# Campus Sentinel NLP worker

Reads text (demo feed posts, news, school notices, social posts, video transcripts), extracts **whether it describes illness, which symptoms, which place and when**, and writes those fields to Firestore. The dashboard turns them into syndromes and pathogen types with the same rules it uses for survey reports.

| File | What it does |
| --- | --- |
| `extract.py` | The extraction: OpenAI with a strict JSON schema, plus a keyword method (fallback and baseline) |
| `sentinel_worker.py` | Runs it: `live` (demo feed), `ingest` (a CSV of collected posts), `test` (one sentence) |
| `evaluate.py` | Scores an extractor against hand-labeled posts: precision, recall, F1 |
| `eval_set.csv` | 30 starter labeled posts (written by the developer, so scores on it are optimistic) |
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
export OPENAI_MODEL="gpt-4o-mini"          # or the model your ASU program provides
# export OPENAI_BASE_URL="https://..."     # only if ASU gives you a different endpoint
```

Windows (PowerShell):
```
$env:GOOGLE_APPLICATION_CREDENTIALS = "$PWD\service-account.json"
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_MODEL = "gpt-4o-mini"
```

If your ASU access is through **Azure OpenAI** rather than OpenAI directly, the connection code is slightly different. Ask before the demo and it can be switched.

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
