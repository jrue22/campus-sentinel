# Campus Sentinel NLP worker

Reads text (demo feed posts, news, school notices, social posts, video transcripts), extracts **whether it describes illness, which symptoms, which place and when**, and writes those fields to Firestore. The dashboard turns them into syndromes and pathogen types with the same rules it uses for survey reports.

| File | What it does |
| --- | --- |
| `extract.py` | The extraction: OpenAI with a strict JSON schema, plus a keyword method (fallback and baseline) |
| `sentinel_worker.py` | Runs it: `live` (demo feed), `rss` (news feeds), `ingest` (a CSV of collected posts), `test` (one sentence) |
| `newsfeed.py` | Reads RSS and Atom news feeds (Python standard library only, nothing to install) |
| `demo-news.xml` | Practice news feed: 12 made-up stories from a made-up outlet, for testing and the demo |
| `evaluate.py` | Scores an extractor against hand-labeled posts: precision, recall, F1 |
| `eval_set.csv` | 33 starter labeled posts (written by the developer, so scores on it are optimistic) |
| `requirements.txt` | Python packages |

## Setup (about 15 minutes, once)

You need Python 3.10 or newer.

**1. Install the packages.** In a terminal, inside this `worker` folder:

```
pip install -r requirements.txt
```

**2. Get a Firebase service-account key.** The worker writes results with the Firebase Admin SDK, which needs a private key.

1. Firebase console → gear icon → **Project settings** → **Service accounts** → **Generate new private key**.
2. Save the file in this folder as `service-account.json`.
3. **Never upload this file to GitHub.** Anyone with it has full control of your database. The `.gitignore` file in the repository keeps it out of commits, but GitHub's web uploader ignores `.gitignore`, so never drag this file into the browser either.

**3. Set the environment variables.** Do this in the terminal where you'll run the worker.

Mac / Linux:
```
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/service-account.json"
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://openai.rc.asu.edu/v1"   # ASU's gateway
export OPENAI_MODEL="gpt-4o-mini"                       # use a name from: python sentinel_worker.py models
```

Windows (PowerShell):
```
$env:GOOGLE_APPLICATION_CREDENTIALS = "$PWD\service-account.json"
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_BASE_URL = "https://openai.rc.asu.edu/v1"
$env:OPENAI_MODEL = "gpt-4o-mini"
```

Check which model names your key can use, and pick one for `OPENAI_MODEL`:

```
python sentinel_worker.py models
```

If the gateway doesn't support strict Structured Outputs, the worker switches to plain JSON mode automatically (it prints a note once); every field is still checked before it's saved.

**4. Publish the new `firestore.rules`** in the Firebase console. They add `media_posts` (demo feed) and `media_extracted` (results).

## Try it

```
python sentinel_worker.py test "half my floor at hassy has been throwing up since last night"
python sentinel_worker.py test "this new track is sick" --keywords
python evaluate.py              # keyword method
python evaluate.py --openai     # OpenAI method
```

## Live demo

1. Before class, start the worker and leave it running:
   ```
   python sentinel_worker.py live
   ```
2. Put the dashboard on the projector. Classmates scan the **demo feed** QR code and post.
3. Each post is tagged within a few seconds on the feed ("Detected: vomiting · Hassayampa"), and the **Social & media signals** panel updates. Eight or so stomach-illness posts about one place in 30 minutes produce a **Spike**.
4. If the OpenAI connection fails, the worker switches to the keyword method on its own and prints a warning. Add `--keywords` to use it from the start.

Afterwards, clear the demo: Firebase console → Firestore → `media_posts` and `media_extracted` → **⋮ → Delete collection**.

## News feeds (RSS)

An RSS feed is an XML file a news site keeps updated with its latest stories. Each story is an `<item>` with a `<title>`, `<link>`, `<description>` (short summary), `<pubDate>` and `<guid>` (unique id). The worker reads the headline and summary (plus the start of the article if the summary is short), runs the same extractor on it, and saves the result with `source: "news"`.

```
py sentinel_worker.py rss demo-news.xml --dry-run       # practice feed, print only (no Firebase needed)
py sentinel_worker.py rss demo-news.xml                 # practice feed, saved as example data
py sentinel_worker.py rss demo-news.xml --drip 2        # live demo: one practice story every 2 minutes
py sentinel_worker.py rss https://www.abc15.com/index.rss --every 30    # a real feed, checked every 30 minutes
```

- **Which feed?** A station's home feed (like ABC15's `index.rss`) holds a few featured stories that can be weeks old. A Google News search feed is fresher and already focused on illness, for example
  `https://news.google.com/rss/search?q=(norovirus OR flu OR outbreak OR measles) Arizona when:7d&hl=en-US&gl=US&ceid=US:en`
  (put the address in quotes in PowerShell). `when:7d` keeps it to the last 7 days.
- `--max-age 365` also analyzes stories up to a year old. Use it with `--dry-run` to test on older stories; saved stories older than 14 days won't show on the dashboard anyway.
- You can list several feed addresses after `rss`. Each story is processed **once** (its id comes from the feed's `<guid>`), and stories older than 14 days are skipped.
- `--every 30` re-checks every 30 minutes and asks the site "anything new since last time?" (ETag / Last-Modified), so an unchanged feed costs almost nothing. Please don't check more often than every 15 minutes.
- The practice feed is marked as example data, so **Include example data** on the dashboard hides it. Its dates are moved up so the newest story is "now".
- For illness stories only, the **public headline and link** are saved, so the dashboard can list them under **Social & news → News headlines**. The article text is never stored.
- News doesn't count toward the social-media spike rule (one story can stand for many people, and outlets repeat each other's stories). It counts as its own source in **Where the signals agree**.
- Most news names a city, not a campus, so most stories show "Place not named". That is the place check working as intended.

## Adding collected data

Put posts in a CSV with a header row `source,posted_at,text` (optionally `demo` as true/false):

```
source,posted_at,text
news,2026-10-18T14:05:00Z,"Stomach illness reported at an ASU residence hall"
reddit,2026-10-18T16:40:00Z,"anyone else at manzy sick? whole floor is coughing"
```

`source` is one of: `news`, `school`, `reddit`, `x`, `tiktok`, `youtube`, `journal`, `other`. For video, put the transcript in `text`.

```
python sentinel_worker.py ingest posts.csv
```

Running the same file twice adds nothing new. **The text and the author are never stored**: only the source type, time and extracted fields, under an id made by hashing the post.

## Measuring accuracy (days 10–11)

`eval_set.csv` was written alongside the keyword list, so the keyword method scores unrealistically well on it. For a fair score:

1. Collect about 200 posts **written by other people**: demo feed posts from a rehearsal, plus real posts from your sources.
2. Label each one by hand (`is_illness`, `symptoms`, `place`) **before** running the extractor on it.
3. Run `python evaluate.py yourfile.csv --openai` and `python evaluate.py yourfile.csv`, and compare.
