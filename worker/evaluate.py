"""
Score an extractor against a hand-labeled file.

  python evaluate.py                    # keyword method on eval_set.csv
  python evaluate.py --openai           # OpenAI method (uses your API key)
  python evaluate.py my_labels.csv --openai

Columns: text,is_illness (1/0),symptoms (ids separated by ;),place (id or unknown)

Reports:
  * illness detection: precision, recall, F1
      precision = of the posts flagged as illness, how many really were
      recall    = of the real illness posts, how many were flagged
  * symptoms: precision, recall, F1 over individual symptom mentions
  * place: share of posts with the right place
  * every mistake, so you can see what to fix
"""

import csv
import sys
import time

from extract import extract_keywords, extract_openai, make_client


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def evaluate(path, use_openai):
    rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
    client = make_client() if use_openai else None
    failed = []                       # posts the API couldn't answer: left out of the scores, not swapped for keywords
    start = time.time()
    tp = fp = fn = tn = 0
    stp = sfp = sfn = 0
    place_ok = 0
    mistakes = []
    for i, row in enumerate(rows, 1):
        print(f"  {i}/{len(rows)}  ({time.time() - start:.0f}s)  {row['text'][:50]!r}", flush=True)
        if use_openai:
            try:
                got = extract_openai(row["text"], client=client)
            except Exception as e:
                print(f"     ! API error, skipped: {type(e).__name__}: {str(e)[:120]}")
                failed.append(row["text"])
                continue
        else:
            got = extract_keywords(row["text"])
        truth_ill = row["is_illness"].strip() == "1"
        truth_sym = {s for s in row["symptoms"].split(";") if s}
        truth_place = row["place"].strip() or "unknown"
        got_sym = set(got["symptoms"])

        if got["is_illness"] and truth_ill: tp += 1
        elif got["is_illness"] and not truth_ill: fp += 1
        elif not got["is_illness"] and truth_ill: fn += 1
        else: tn += 1
        stp += len(got_sym & truth_sym); sfp += len(got_sym - truth_sym); sfn += len(truth_sym - got_sym)
        place_ok += got["place"] == truth_place

        if got["is_illness"] != truth_ill or got_sym != truth_sym or got["place"] != truth_place:
            mistakes.append((row["text"], truth_ill, sorted(truth_sym), truth_place, got))

    scored = len(rows) - len(failed)
    if not scored:
        print("\nNo posts could be scored. Check the API settings with: python sentinel_worker.py test \"...\"")
        return None
    p, r, f = prf(tp, fp, fn)
    sp, sr, sf = prf(stp, sfp, sfn)
    method = "OpenAI" if use_openai else "keywords"
    print(f"\n{method} on {scored} labeled posts ({path}), {time.time() - start:.0f} seconds")
    if failed:
        print(f"  ! {len(failed)} posts skipped because of API errors; scores cover the other {scored}")
    print(f"  Illness detection  precision {p:.2f}  recall {r:.2f}  F1 {f:.2f}   (TP {tp}, FP {fp}, FN {fn}, TN {tn})")
    print(f"  Symptoms           precision {sp:.2f}  recall {sr:.2f}  F1 {sf:.2f}")
    print(f"  Place correct      {place_ok}/{scored} ({place_ok / scored:.0%})")
    if mistakes:
        print(f"\n  {len(mistakes)} posts with at least one mistake:")
        for text, ti, ts, tpl, got in mistakes:
            print(f"   - {text[:70]!r}")
            print(f"       expected ill={int(ti)} {ts} @ {tpl}")
            print(f"       got      ill={int(got['is_illness'])} {got['symptoms']} @ {got['place']}")
    return {"precision": p, "recall": r, "f1": f, "symptom_f1": sf, "place_acc": place_ok / scored, "skipped": len(failed)}


if __name__ == "__main__":
    files = [a for a in sys.argv[1:] if not a.startswith("--")]
    evaluate(files[0] if files else "eval_set.csv", "--openai" in sys.argv)
