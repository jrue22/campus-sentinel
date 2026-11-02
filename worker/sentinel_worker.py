"""
Campus Sentinel - NLP worker
============================
Runs on your laptop (or any computer) and turns text into illness signals.

  python sentinel_worker.py live              # watch the demo feed and process new posts as they arrive
  python sentinel_worker.py ingest posts.csv  # process a file of collected posts (news, Reddit, transcripts...)
  python sentinel_worker.py test "text..."    # try the extractor on one sentence
  python sentinel_worker.py models            # list the models your API key can use

Add --keywords to any command to skip OpenAI and use the keyword method.

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
import sys
import threading
import time

from extract import extract

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


def run_test(text, use_openai):
    print(json.dumps(extract(text, use_openai), indent=2))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    use_openai = "--keywords" not in sys.argv
    if not args:
        print(__doc__); sys.exit(0)
    cmd = args[0]
    if cmd == "live":
        run_live(use_openai)
    elif cmd == "ingest" and len(args) > 1:
        run_ingest(args[1], use_openai)
    elif cmd == "test" and len(args) > 1:
        run_test(" ".join(args[1:]), use_openai)
    elif cmd == "models":
        from extract import list_models
        print("\n".join(list_models()))
    else:
        print(__doc__)
