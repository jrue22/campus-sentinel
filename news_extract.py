"""
Campus Sentinel - news extractor
================================
News stories are different from social posts. A post says "I threw up all night";
a story says "Norovirus outbreak sickens dozens at a Tempe dorm" and may never list
a symptom. So news gets its own extractor that asks different questions first:

  1. Is this story about health at all?       health_topic
       infectious_disease | other_health (heat, overdoses, gambling, mental health...) | not_health
  2. What kind of health story is it?         report_type
       cases_or_outbreak | exposure_warning | advisory_or_prevention | research_or_policy | past_event | none
  3. Which disease, and where?                pathogen, syndrome, place, region, case_count
  4. Symptoms only if the story lists them.

A story counts as an illness signal (is_illness) only when it is about an infectious
disease AND reports current cases or an exposure. A flu-shot clinic, a study, or last
year's flu season is health news, but not a signal.

The result has the same fields as extract.extract() (so the worker and dashboard treat
it the same way), plus the news fields above.
"""

import json
import os
import re

from extract import (SYMPTOM_IDS, PLACE_IDS, PLACE_ALIASES, PATHOGEN_IDS, PATHOGEN_ALIASES, RESIDENCE_CAMPUS, CAMPUS_IDS,
                     make_client, ground, ground_symptoms, extract_keywords, _has, _negated, _looks_like_unsupported)

HEALTH_TOPICS = ["infectious_disease", "other_health", "not_health"]
REPORT_TYPES = ["cases_or_outbreak", "exposure_warning", "advisory_or_prevention", "research_or_policy",
                "past_event", "none"]
SIGNAL_TYPES = {"cases_or_outbreak", "exposure_warning"}       # the report types that count as a signal
SYNDROME_IDS = ["ili", "resp", "gi", "skin", "neuro", "other", "none"]
REGIONS = ["asu_campus", "arizona", "elsewhere_us", "outside_us", "unknown"]

# Disease -> usual syndrome (the dashboard has the same table, with the pathogen type).
PATHOGEN_SYNDROME = {
    "norovirus": "gi", "rotavirus": "gi", "salmonella": "gi", "cryptosporidium": "gi", "hepatitis_a": "gi",
    "ecoli": "gi", "listeria": "gi",
    "influenza": "ili", "covid": "ili", "strep": "ili", "mono": "ili",
    "rsv": "resp", "pertussis": "resp", "valley_fever": "resp", "hantavirus": "resp", "tuberculosis": "resp",
    "legionella": "resp",
    "measles": "skin", "mpox": "skin", "chickenpox": "skin",
    "west_nile": "neuro", "meningococcal": "neuro",
}

NEWS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "health_topic": {"type": "string", "enum": HEALTH_TOPICS},
        "report_type": {"type": "string", "enum": REPORT_TYPES},
        "pathogen": {"type": "string", "enum": PATHOGEN_IDS},
        "syndrome": {"type": "string", "enum": SYNDROME_IDS},
        "symptoms": {"type": "array", "items": {"type": "string", "enum": SYMPTOM_IDS}},
        "place": {"type": "string", "enum": PLACE_IDS},
        "region": {"type": "string", "enum": REGIONS},
        "case_count": {"type": ["integer", "null"]},
        "confidence": {"type": "number"},
    },
    "required": ["health_topic", "report_type", "pathogen", "syndrome", "symptoms", "place", "region",
                 "case_count", "confidence"],
}

NEWS_INSTRUCTIONS = """You screen local news stories for a university syndromic surveillance system
at Arizona State University. You read one story (headline, summary, maybe the start of the article)
and return JSON that matches the schema. Most stories are not about health: that's expected.

- health_topic: "infectious_disease" for any contagious or infectious illness (viruses, bacteria,
  fungi like valley fever, parasites, foodborne illness, "people got sick after eating...").
  "other_health" for health stories that aren't infections: heat illness, overdoses, injuries,
  gambling or mental health, cancer, hospital business. "not_health" for everything else.
- report_type: "cases_or_outbreak" if the story reports people who are sick now or recently
  (cases, an outbreak, hospitalizations, people sickened). "exposure_warning" if people may have
  been exposed (a contagious person visited a place, a contaminated product, a recall after
  illnesses). "advisory_or_prevention" for vaccine clinics, tips, mosquito or water testing with no
  human cases. "research_or_policy" for studies, funding, lawsuits, investigations, rules.
  "past_event" for illness that is over (last season, a past year). "none" if not health.
- pathogen: the disease the story names, from the allowed ids; "other" for a named disease not in
  the list; "none" if no disease is named. Don't guess a disease the story doesn't name.
- syndrome: the illness pattern even when no symptoms are listed: "gi" (stomach, food poisoning,
  vomiting or diarrhea), "ili" (flu-like, fever with cough or sore throat), "resp" (other
  respiratory), "skin" (rash), "neuro" (meningitis, encephalitis), "other" if unclear, "none" if not
  an infectious disease story.
- symptoms: only symptoms the story says people have. Often none: that is fine.
- place: an ASU residence hall or campus ONLY if the story names it, else "unknown". A city
  ("Tempe", "Phoenix") is not a campus: use "unknown" and set region instead.
- region: "asu_campus" if an ASU campus or hall is named, "arizona" for elsewhere in Arizona
  (Phoenix, Tempe, Mesa, Tucson, Maricopa County, "the Valley"...), "elsewhere_us", "outside_us",
  or "unknown".
- case_count: the number of sick people if the story gives one, else null.
- confidence: 0 to 1, how sure you are about health_topic and report_type.

Examples:
"Norovirus suspected after dozens fall ill at ASU's Hassayampa residence hall" ->
  {"health_topic": "infectious_disease", "report_type": "cases_or_outbreak", "pathogen": "norovirus", "syndrome": "gi", "symptoms": [], "place": "tempe-hassayampa", "region": "asu_campus", "case_count": null, "confidence": 0.95}
"Free flu shot clinics open at Valley libraries this week" ->
  {"health_topic": "infectious_disease", "report_type": "advisory_or_prevention", "pathogen": "influenza", "syndrome": "none", "symptoms": [], "place": "unknown", "region": "arizona", "case_count": null, "confidence": 0.9}
"ER visits for gambling disorder climb as sports betting grows" ->
  {"health_topic": "other_health", "report_type": "none", "pathogen": "none", "syndrome": "none", "symptoms": [], "place": "unknown", "region": "unknown", "case_count": null, "confidence": 0.9}
"12 sickened after church potluck in Mesa; county investigating" ->
  {"health_topic": "infectious_disease", "report_type": "cases_or_outbreak", "pathogen": "none", "syndrome": "gi", "symptoms": [], "place": "unknown", "region": "arizona", "case_count": 12, "confidence": 0.85}
Return only the JSON."""


def clean_news(r, method):
    """Check every field (never trust an extractor blindly) and add the shared fields."""
    pick = lambda v, allowed, default: v if v in allowed else default
    topic = pick(r.get("health_topic"), HEALTH_TOPICS, "not_health")
    rtype = pick(r.get("report_type"), REPORT_TYPES, "none")
    pathogen = pick(r.get("pathogen"), PATHOGEN_IDS, "none")
    syndrome = pick(r.get("syndrome"), SYNDROME_IDS, "none")
    place = pick(r.get("place"), PLACE_IDS, "unknown")
    region = pick(r.get("region"), REGIONS, "unknown")
    count = r.get("case_count")
    count = count if isinstance(count, int) and 0 < count < 100000 else None
    try:
        conf = max(0.0, min(1.0, float(r.get("confidence", 0))))
    except (TypeError, ValueError):
        conf = 0.0
    if topic != "infectious_disease":                     # only infections get a disease and a syndrome
        pathogen, syndrome = "none", "none"
        if topic == "not_health":
            rtype = "none"
    if syndrome == "none" and pathogen in PATHOGEN_SYNDROME and topic == "infectious_disease":
        syndrome = PATHOGEN_SYNDROME[pathogen]
    if place != "unknown":
        region = "asu_campus"
    is_illness = topic == "infectious_disease" and rtype in SIGNAL_TYPES
    symptoms = sorted({s for s in (r.get("symptoms") or []) if s in SYMPTOM_IDS}) if is_illness else []
    return {
        # shared fields (same as extract.clean)
        "is_illness": is_illness,
        "who": "other" if is_illness else "none",
        "symptoms": symptoms,
        "place": place,
        "pathogen": pathogen,
        "campus": RESIDENCE_CAMPUS.get(place) or CAMPUS_IDS.get(place),
        "onset_days_ago": None,
        "confidence": round(conf, 2),
        "method": method,
        # news fields
        "health_topic": topic,
        "report_type": rtype,
        "syndrome": syndrome,
        "region": region,
        "case_count": count,
    }


# News uses city names that are also our campus nicknames ("a new cancer center in Tempe").
# A campus counts only if the story also says ASU / campus / university; otherwise it's just the city.
CITY_ONLY = {"campus-tempe": ["tempe"], "campus-downtown": ["downtown", "downtown phoenix"],
             "campus-poly": ["poly"], "campus-west": ["west valley"]}
CAMPUS_CONTEXT = re.compile(r"\b(asu|arizona state|campus|university|sun devils?|students?|dorms?|residence halls?)\b")
# News mentions of a disease that the social-post list leaves out on purpose ("flu" alone is too often "flu shot" in posts).
NEWS_ALIASES = {"influenza": ["flu"]}


def news_place(place, text):
    """Drop a campus that the story only names as a city."""
    if place in CITY_ONLY and not CAMPUS_CONTEXT.search(text.lower()):
        t = " " + text.lower() + " "
        named = [n for n in PLACE_ALIASES[place] if _has(t, n)]
        if named and all(n in CITY_ONLY[place] for n in named):
            return "unknown"
    return place


def regrounded(r, text):
    """The place and symptom checks from extract.py, keeping region consistent with the place."""
    r = ground_symptoms(ground(r, text), text)
    place = news_place(r["place"], text)
    if place != r["place"]:
        r = {**r, "place": place, "campus": None, "place_corrected": True}
    if r["place"] != "unknown":
        r = {**r, "region": "asu_campus"}
    elif r["region"] == "asu_campus":
        r = {**r, "region": "arizona" if AZ_WORDS.search(text.lower()) else "unknown"}
    return r


_mode = {"value": "json_schema"}


def extract_news_openai(text, client=None, model=None):
    client = client or make_client()
    model = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    messages = [{"role": "system", "content": NEWS_INSTRUCTIONS}, {"role": "user", "content": text[:2000]}]
    if _mode["value"] == "json_schema":
        try:
            response = client.chat.completions.create(
                model=model, temperature=0, messages=messages,
                response_format={"type": "json_schema",
                                 "json_schema": {"name": "news_screen", "strict": True, "schema": NEWS_SCHEMA}})
            return regrounded(clean_news(json.loads(response.choices[0].message.content), "openai"), text)
        except Exception as e:
            if not _looks_like_unsupported(e):
                raise
            print("  ! Structured Outputs not supported here; switching to JSON mode")
            _mode["value"] = "json_object"
    response = client.chat.completions.create(
        model=model, temperature=0,
        messages=[{"role": "system", "content": NEWS_INSTRUCTIONS + "\n\nReturn a JSON object matching this JSON Schema exactly:\n"
                   + json.dumps(NEWS_SCHEMA)}, messages[1]],
        response_format={"type": "json_object"})
    return regrounded(clean_news(json.loads(response.choices[0].message.content), "openai"), text)


# ---------------------------------------------------------------------------
# Keyword fallback and baseline for news
# ---------------------------------------------------------------------------

INFECTION_WORDS = re.compile(r"\b(outbreak|infections?|infectious|virus|viral|bacteria|bacterial|contagious|"
                             r"sickened|fell ill|falling ill|food poisoning|foodborne|stomach (bug|illness)|"
                             r"exposure|exposed|cases of|cases|disease)\b")
HEALTH_WORDS = re.compile(r"\b(health|hospital|hospitals|er visits?|emergency room|overdoses?|fentanyl|heat[- ]related|"
                          r"heat stroke|mental health|disorder|cancer|doctors?|nurses?|clinic|medical|patients?)\b")
ADVISORY_WORDS = re.compile(r"\b(vaccines?|vaccinations?|shots?|clinics? (open|offer)|booster|tips|how to|prevent|"
                            r"mosquitoes test|tested positive for west nile|water testing|free testing)\b")
RESEARCH_WORDS = re.compile(r"\b(study|studies|report finds|researchers?|survey|probe|investigation into|lawsuit|"
                            r"funding|grant|policy|bill|legislat\w*|budget)\b")
PAST_WORDS = re.compile(r"\b(last (year|season|winter)|years ago|in (19|20)\d\d|was the worst)\b")
EXPOSURE_WORDS = re.compile(r"\b(exposure|exposed|may have been exposed|recall(ed)?|contaminated)\b")
CASE_WORDS = re.compile(r"\b(outbreak|cases?|sickened|fell ill|falling ill|hospitali[sz]ed|confirmed|reported|"
                        r"sick|ill|died|deaths?|going around)\b")
AZ_WORDS = re.compile(r"\b(arizona|phoenix|tempe|mesa|scottsdale|chandler|gilbert|glendale|peoria|surprise|"
                      r"maricopa|pima|pinal|tucson|flagstaff|yuma|prescott|the valley|west valley|east valley|navajo county|"
                      r"apache junction|goodyear|avondale|buckeye|asu)\b")
OUTSIDE_US = re.compile(r"\b(spain|spanish|mexico|canada|china|europe|africa|india|brazil|uk|britain|japan|"
                        r"cruise ship|overseas|abroad)\b")
COUNT = re.compile(r"\b(\d{1,5})\s+(people|students|cases|patients|children|residents|guests|sick|ill|sickened)\b")


def extract_news_keywords(text):
    base = extract_keywords(text)                 # symptoms, place, pathogen from the social-post method
    t = " " + text.lower().replace("’", "'") + " "
    aliases = {pid: names + NEWS_ALIASES.get(pid, []) for pid, names in PATHOGEN_ALIASES.items()}
    pathogen = base["pathogen"] if base["pathogen"] != "none" else next(
        (pid for pid, names in aliases.items() if any(_has(t, n) and not _negated(t, n) for n in names)), "none")
    base = {**base, "place": news_place(base["place"], text)}
    if pathogen != "none" or INFECTION_WORDS.search(t) or (base["symptoms"] and CASE_WORDS.search(t)):
        topic = "infectious_disease"
    elif HEALTH_WORDS.search(t):
        topic = "other_health"
    else:
        topic = "not_health"

    if topic == "not_health":
        rtype = "none"
    elif PAST_WORDS.search(t):
        rtype = "past_event"
    elif RESEARCH_WORDS.search(t):
        rtype = "research_or_policy"
    elif ADVISORY_WORDS.search(t) and not re.search(r"\b(outbreaks?|sickened|hospitali[sz]ed|cases (rise|grow|climb))\b", t):
        rtype = "advisory_or_prevention"
    elif EXPOSURE_WORDS.search(t):
        rtype = "exposure_warning"
    elif CASE_WORDS.search(t) or topic == "infectious_disease":
        rtype = "cases_or_outbreak" if topic == "infectious_disease" else "none"
    else:
        rtype = "none"

    syndrome = PATHOGEN_SYNDROME.get(pathogen, "none")
    if syndrome == "none" and topic == "infectious_disease":
        syndrome = "other"
    region = ("asu_campus" if base["place"] != "unknown" else "arizona" if AZ_WORDS.search(t)
              else "outside_us" if OUTSIDE_US.search(t) else "unknown")
    m = COUNT.search(t)
    r = {"health_topic": topic, "report_type": rtype, "pathogen": pathogen, "syndrome": syndrome,
         "symptoms": base["symptoms"], "place": base["place"], "region": region,
         "case_count": int(m.group(1)) if m else None,
         "confidence": 0.6 if topic == "infectious_disease" else 0.5}
    return clean_news(r, "keywords")


def extract_news(text, use_openai=True):
    """Main entry point for news: try OpenAI, fall back to keywords if it fails."""
    if use_openai:
        try:
            return extract_news_openai(text)
        except Exception as e:
            print(f"  ! OpenAI failed ({type(e).__name__}: {e}); using keyword fallback")
    return extract_news_keywords(text)
