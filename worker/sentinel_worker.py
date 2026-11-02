"""
Campus Sentinel - NLP worker
============================
Runs on your laptop (or any computer) and turns text into illness signals.

  python sentinel_worker.py live              # watch the demo feed and process new posts as they arrive
  python sentinel_worker.py ingest posts.csv  # process a file of collected posts (news, Reddit, transcripts...)
  python sentinel_worker.py rss URL [URL...]  # read news feeds (RSS or Atom); add --every 30 to re-check every 30 min
  python sentinel_worker.py rss demo-news.xml # the practice feed (made-up stories, marked as example data)
  python sentinel_worker.py test "text..."    # try the extractor on one sentence
  python sentinel_worker.py models            # list the models your API key can use

Add --keywords to any command to skip OpenAI and use the keyword method.
Add --dry-run to rss to print the results without saving anything (no Firebase key needed).

What it writes: one document per post in the "media_extracted" collection with
the extracted fields only (source type, time, symptoms, place, onset). It never
stores the author, and for real sources it never stores the text itself.
The dashboard turns these into syndromes and pathogen types with its own rules.

Setup (see README.md in this folder):
  pip install -r requirements.txt
  set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service-account key file
  set OPENAI_API_KEY (and OPENAI_MODEL / OPENAI_BASE_URL if ASU gives you others)
"""

import csv
import datetime as dt
import glob
import hashlib
import json
import os
import re
import sys
import threading
import time

from extract import extract
import newsfeed

SOURCES = {"demo-feed", "news", "school", "reddit", "x", "tiktok", "youtube", "journal", "other"}


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def find_key():
    """The Firebase key: GOOGLE_APPLICATION_CREDENTIALS if set, else service-account.json next to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", ""),
                  os.path.join(here, "service-account.json"),
                  os.path.join(here, "service-account.json.json")]      # Windows hides extensions, so this happens
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    others = sorted(glob.glob(os.path.join(here, "*firebase-adminsdk*.json")))
    if others:
        return others[0]                                                  # the file as Firebase named it
    sys.exit("Firebase key not found.\n"
             "  Download it: Firebase console > gear icon > Project settings > Service accounts > Generate new private key,\n"
             f"  then save it in {here} as service-account.json\n"
             "  (or set GOOGLE_APPLICATION_CREDENTIALS to its full path). Never upload this file to GitHub.")


def connect():
    """Connect to Firestore with the Admin SDK (bypasses the security rules, so keep the key private)."""
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        key = find_key()
        print(f"Using Firebase key: {os.path.basename(key)}")
        firebase_admin.initialize_app(credentials.Certificate(key))
    return firestore.client()


def make_record(result, source, posted_at, demo):
    """The document stored for one post: extracted fields only."""
    return {
        "source": source if source in SOURCES else "other",
        "postedAt": posted_at,
        "processedAt": now_iso(),
        "isIllness": result["is_illness"],
        "who": result["who"],
        "symptoms": result["symptoms"],
        "place": result["place"],
        "pathogen": result["pathogen"],
        "campus": result["campus"],
        "onsetDaysAgo": result["onset_days_ago"],
        "confidence": result["confidence"],
        "method": result["method"],
        "placeCorrected": bool(result.get("place_corrected")),   # the grounding check changed the model's place
        "symptomsAdded": result.get("symptoms_added", []),      # the symptom check added these (the model missed them)
        "symptomsRemoved": result.get("symptoms_removed", []),  # ...and removed these (the text negates them)
        "demo": bool(demo),
    }


# ---------------------------------------------------------------------------
# live: watch media_posts and process each new post within seconds
# ---------------------------------------------------------------------------

def run_live(use_openai):
    db = connect()
    done = {ref.id for ref in db.collection("media_extracted").list_documents()}   # already processed
    print(f"Watching the demo feed. {len(done)} posts already processed. Press Ctrl+C to stop.")
    lock = threading.Lock()

    def handle(doc):
        with lock:
            if doc.id in done:
                return
            done.add(doc.id)
        post = doc.to_dict() or {}
        text = str(post.get("text", ""))[:500]
        if not text.strip():
            return
        result = extract(text, use_openai)
        db.collection("media_extracted").document(doc.id).set(
            make_record(result, "demo-feed", post.get("createdAt") or now_iso(), demo=True))
        tag = (", ".join(result["symptoms"]) or "no symptoms") + f" @ {result['place']}"
        if result.get("place_corrected"):
            tag += "  (place corrected: the model named a place the post doesn't mention)"
        if result.get("symptoms_added"):
            tag += f"  (symptom check added: {', '.join(result['symptoms_added'])})"
        if result.get("symptoms_removed"):
            tag += f"  (symptom check removed, text says no: {', '.join(result['symptoms_removed'])})"
        print(f"  {'ILL ' if result['is_illness'] else 'skip'} [{result['method']}] {text[:60]!r} -> {tag}")

    def on_snapshot(snapshot, changes, read_time):
        for change in changes:
            if change.type.name == "ADDED":
                threading.Thread(target=handle, args=(change.document,), daemon=True).start()

    watch = db.collection("media_posts").on_snapshot(on_snapshot)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        watch.unsubscribe()
        print("Stopped.")


# ---------------------------------------------------------------------------
# ingest: process a CSV of collected posts
# Columns: source,posted_at,text   (posted_at as an ISO time, e.g. 2026-10-18T14:05:00Z)
# Optional column: demo (true/false) for synthetic background data
# ---------------------------------------------------------------------------

def run_ingest(path, use_openai):
    db = connect()
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    print(f"Processing {len(rows)} rows from {path}")
    batch, n, ill = db.batch(), 0, 0
    for i, row in enumerate(rows, 1):
        text = (row.get("text") or "").strip()
        if not text:
            continue
        result = extract(text, use_openai)
        # The id is a hash of source + time + text, so re-running the same file adds nothing new,
        # and the text itself is never stored.
        doc_id = hashlib.sha256(f"{row.get('source')}|{row.get('posted_at')}|{text}".encode()).hexdigest()[:24]
        demo = str(row.get("demo", "")).lower() in ("1", "true", "yes")
        batch.set(db.collection("media_extracted").document(doc_id),
                  make_record(result, row.get("source", "other"), row.get("posted_at") or now_iso(), demo))
        n += 1
        ill += result["is_illness"]
        if n % 400 == 0:
            batch.commit(); batch = db.batch()
            print(f"  {i} rows done")
    batch.commit()
    print(f"Done: {n} posts processed, {ill} about illness.")


# ---------------------------------------------------------------------------
# rss: read news feeds and process each new story once
# ---------------------------------------------------------------------------

NEWS_MAX_AGE_DAYS = 14        # older stories are skipped (the dashboard only shows 14 days)


def story_id(feed, story):
    """A stable id from the feed + the story's guid, so a story is only ever processed once."""
    return "news-" + hashlib.sha256(f"{feed}|{story['id']}".encode()).hexdigest()[:20]


def news_record(result, story, outlet, posted_at, demo):
    record = make_record(result, "news", posted_at, demo)
    record["who"] = "other" if result["is_illness"] else "none"     # a news story reports on other people
    record["outlet"] = outlet[:80]
    # For illness stories only, keep the public headline and link so the dashboard can list them.
    # (Social posts never store text; a published headline is public and links back to the source.)
    if result["is_illness"]:
        record["headline"] = story["title"][:200]
        link = story["link"] if re.match(r"https?://", story["link"] or "") else ""
        record["link"] = link[:500]
    return record


def read_feed(source, use_openai, db, done, cache, demo_shift=None, only_new=True):
    """Process the new stories in one feed. Returns (stories read, about illness)."""
    xml_text = newsfeed.fetch(source, cache)
    if xml_text is None:
        print(f"  {source}: no change since last check")
        return 0, 0
    outlet, stories = newsfeed.parse(xml_text)
    now = dt.datetime.now(dt.timezone.utc)
    n = ill = 0
    for story in stories:
        sid = story_id(source, story)
        if only_new and sid in done:
            continue
        published = story["published"] or now
        if demo_shift is not None:
            published = published + demo_shift                      # practice feed: move the dates up to today
        if now - published > dt.timedelta(days=NEWS_MAX_AGE_DAYS):
            continue
        result = extract(newsfeed.story_text(story), use_openai)
        posted_at = published.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        if db is not None:
            db.collection("media_extracted").document(sid).set(
                news_record(result, story, outlet, posted_at, demo=demo_shift is not None))
        done.add(sid)
        n += 1
        ill += result["is_illness"]
        tag = (", ".join(result["symptoms"]) or "no symptoms") + f" @ {result['place']}"
        if result["pathogen"] != "none":
            tag += f"  pathogen: {result['pathogen']}"
        print(f"  {'ILL ' if result['is_illness'] else 'skip'} [{result['method']}] {story['title'][:70]!r} -> {tag}")
    return n, ill


def run_rss(sources, use_openai, every_min=None, dry_run=False, drip_min=None):
    db = None if dry_run else connect()
    done = set() if db is None else {ref.id for ref in db.collection("media_extracted").list_documents()}
    cache = {}
    web = [s for s in sources if re.match(r"https?://", s)]
    files = [s for s in sources if s not in web]

    # Practice feed files: example data. All stories are re-dated so the newest one is "now",
    # and they are processed again on every run (so they never go stale).
    for path in files:
        outlet, stories = newsfeed.parse(newsfeed.fetch(path))
        dates = [s["published"] for s in stories if s["published"]]
        if drip_min:
            run_drip(path, stories, outlet, use_openai, db, drip_min)
            continue
        shift = (dt.datetime.now(dt.timezone.utc) - max(dates)) if dates else dt.timedelta(0)
        print(f"Practice feed {path}: {outlet} ({len(stories)} stories, re-dated to end now)")
        n, ill = read_feed(path, use_openai, db, done, None, demo_shift=shift, only_new=False)
        print(f"Done: {n} stories, {ill} about illness.")

    if not web:
        return
    while True:
        print(f"Checking {len(web)} feed(s) at {dt.datetime.now().strftime('%H:%M')}")
        for url in web:
            try:
                n, ill = read_feed(url, use_openai, db, done, cache)
                if n:
                    print(f"  {url}: {n} new stories, {ill} about illness")
            except Exception as e:                                   # one broken feed shouldn't stop the others
                print(f"  ! {url}: {type(e).__name__}: {str(e)[:150]}")
        if not every_min:
            return
        print(f"Next check in {every_min} minutes. Press Ctrl+C to stop.")
        try:
            time.sleep(every_min * 60)
        except KeyboardInterrupt:
            print("Stopped.")
            return


def run_drip(path, stories, outlet, use_openai, db, drip_min):
    """Live demo: release the practice stories one at a time, oldest first, each stamped 'now'."""
    stories = sorted(stories, key=lambda s: s["published"] or dt.datetime.now(dt.timezone.utc))
    print(f"Dripping {len(stories)} practice stories from {outlet}, one every {drip_min} min. Ctrl+C to stop.")
    try:
        for i, story in enumerate(stories, 1):
            result = extract(newsfeed.story_text(story), use_openai)
            sid = story_id(path, story)
            if db is not None:
                db.collection("media_extracted").document(sid).set(
                    news_record(result, story, outlet, now_iso(), demo=True))
            print(f"  {i}/{len(stories)} {'ILL ' if result['is_illness'] else 'skip'} {story['title'][:70]!r}")
            if i < len(stories):
                time.sleep(drip_min * 60)
    except KeyboardInterrupt:
        print("Stopped.")


def option(name, default=None):
    """The number after a flag, e.g. option('--every') for '--every 30'."""
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            try:
                return float(sys.argv[i + 1])
            except ValueError:
                sys.exit(f"{name} needs a number of minutes, e.g. {name} 30")
    return default


def run_test(text, use_openai):
    print(json.dumps(extract(text, use_openai), indent=2))


if __name__ == "__main__":
    # Words that aren't flags or the numbers after --every / --drip
    args = [a for i, a in enumerate(sys.argv[1:], 1)
            if not a.startswith("--") and sys.argv[i - 1] not in ("--every", "--drip")]
    use_openai = "--keywords" not in sys.argv
    if not args:
        print(__doc__); sys.exit(0)
    cmd = args[0]
    if cmd == "live":
        run_live(use_openai)
    elif cmd == "ingest" and len(args) > 1:
        run_ingest(args[1], use_openai)
    elif cmd == "rss" and len(args) > 1:
        run_rss(args[1:], use_openai, every_min=option("--every"), dry_run="--dry-run" in sys.argv,
                drip_min=option("--drip"))
    elif cmd == "test" and len(args) > 1:
        run_test(" ".join(args[1:]), use_openai)
    elif cmd == "models":
        from extract import list_models
        print("\n".join(list_models()))
    else:
        print(__doc__)
