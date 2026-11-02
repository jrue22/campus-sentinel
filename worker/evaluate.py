"""
Score an extractor against a hand-labeled file.

  python evaluate.py                    # keyword method on eval_set.csv
  python evaluate.py --openai           # OpenAI method (uses your API key)
  python evaluate.py my_labels.csv --openai
  python evaluate.py --news             # news extractor on news_eval.csv (add --openai for the model)

Columns: text,is_illness (1/0),symptoms (ids separated by ;),place (id or unknown)

Reports:
  * illness detection: precision, recall, F1
      precision = of the posts flagged as illness, how many really were
      recall    = of the real illness posts, how many were flagged
  * symptoms: precision, recall, F1 over individual symptom mentions
  * place: share of posts with the right place
  * every mistake, so you can see what to fix

News mode (--news) uses columns text,health_topic,is_illness,pathogen,place and does NOT score
symptoms (news often names the disease without listing symptoms). It reports:
  * health filter: share of stories with the right health_topic
    (infectious_disease / other_health / not_health), and the mix-ups
  * illness signal: precision, recall, F1 (infectious AND current cases or an exposure)
  * disease named: share of signal stories with the right pathogen
  * place: share of stories with the right place
"""

import csv
import sys
import time

from extract import extract_keywords, extract_openai, make_client
from news_extract import extract_news_keywords, extract_news_openai


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
    mtp = mfp = mfn = 0               # symptoms from the model alone, before the symptom check
    checked = 0                       # posts where the symptom check changed the list
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
        raw_sym = (got_sym - set(got.get("symptoms_added", []))) | set(got.get("symptoms_removed", []))
        mtp += len(raw_sym & truth_sym); mfp += len(raw_sym - truth_sym); mfn += len(truth_sym - raw_sym)
        checked += raw_sym != got_sym
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
    if use_openai:
        mp, mr, mf = prf(mtp, mfp, mfn)
        print(f"    model alone      precision {mp:.2f}  recall {mr:.2f}  F1 {mf:.2f}   (symptom check changed {checked} posts)")
    print(f"  Place correct      {place_ok}/{scored} ({place_ok / scored:.0%})")
    if mistakes:
        print(f"\n  {len(mistakes)} posts with at least one mistake:")
        for text, ti, ts, tpl, got in mistakes:
            print(f"   - {text[:70]!r}")
            print(f"       expected ill={int(ti)} {ts} @ {tpl}")
            print(f"       got      ill={int(got['is_illness'])} {got['symptoms']} @ {got['place']}")
    return {"precision": p, "recall": r, "f1": f, "symptom_f1": sf, "place_acc": place_ok / scored, "skipped": len(failed)}


def evaluate_news(path, use_openai):
    rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
    client = make_client() if use_openai else None
    start, failed, mistakes = time.time(), [], []
    tp = fp = fn = tn = 0
    topic_ok = place_ok = path_ok = path_n = 0
    mixups = {}
    for i, row in enumerate(rows, 1):
        print(f"  {i}/{len(rows)}  ({time.time() - start:.0f}s)  {row['text'][:50]!r}", flush=True)
        try:
            got = extract_news_openai(row["text"], client=client) if use_openai else extract_news_keywords(row["text"])
        except Exception as e:
            print(f"     ! API error, skipped: {type(e).__name__}: {str(e)[:120]}")
            failed.append(row["text"]); continue
        truth_ill = row["is_illness"].strip() == "1"
        truth_topic, truth_path = row["health_topic"].strip(), row["pathogen"].strip() or "none"
        truth_place = row["place"].strip() or "unknown"
        if got["is_illness"] and truth_ill: tp += 1
        elif got["is_illness"]: fp += 1
        elif truth_ill: fn += 1
        else: tn += 1
        topic_ok += got["health_topic"] == truth_topic
        if got["health_topic"] != truth_topic:
            k = f"{truth_topic} -> {got['health_topic']}"; mixups[k] = mixups.get(k, 0) + 1
        if truth_ill:
            path_n += 1; path_ok += got["pathogen"] == truth_path
        place_ok += got["place"] == truth_place
        if (got["is_illness"] != truth_ill or got["health_topic"] != truth_topic or got["place"] != truth_place
                or (truth_ill and got["pathogen"] != truth_path)):
            mistakes.append((row["text"], truth_topic, truth_ill, truth_path, truth_place, got))
    scored = len(rows) - len(failed)
    if not scored:
        print("\nNo stories could be scored."); return None
    p, r, f = prf(tp, fp, fn)
    print(f"\n{'OpenAI' if use_openai else 'keywords'} news extractor on {scored} labeled stories ({path}), {time.time() - start:.0f} seconds")
    if failed:
        print(f"  ! {len(failed)} stories skipped because of API errors")
    print(f"  Health filter      {topic_ok}/{scored} right ({topic_ok / scored:.0%})"
          + (f"   mix-ups: {', '.join(f'{k} ({v})' for k, v in mixups.items())}" if mixups else ""))
    print(f"  Illness signal     precision {p:.2f}  recall {r:.2f}  F1 {f:.2f}   (TP {tp}, FP {fp}, FN {fn}, TN {tn})")
    if path_n:
        print(f"  Disease named      {path_ok}/{path_n} signal stories right ({path_ok / path_n:.0%})")
    print(f"  Place correct      {place_ok}/{scored} ({place_ok / scored:.0%})")
    if mistakes:
        print(f"\n  {len(mistakes)} stories with at least one mistake:")
        for text, tt, ti, tpth, tpl, got in mistakes:
            print(f"   - {text[:70]!r}")
            print(f"       expected {tt}, signal={int(ti)}, {tpth} @ {tpl}")
            print(f"       got      {got['health_topic']} ({got['report_type']}), signal={int(got['is_illness'])}, {got['pathogen']} @ {got['place']}")
    return {"topic_acc": topic_ok / scored, "f1": f, "skipped": len(failed)}


if __name__ == "__main__":
    files = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--news" in sys.argv:
        evaluate_news(files[0] if files else "news_eval.csv", "--openai" in sys.argv)
    else:
        evaluate(files[0] if files else "eval_set.csv", "--openai" in sys.argv)
