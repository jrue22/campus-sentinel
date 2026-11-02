"""
Campus Sentinel - NLP extraction
=================================
Turns one piece of text (a post, a transcript, a headline) into a small,
fixed record:

    {
      "is_illness":     True/False   # someone is actually sick right now
      "who":            "self" | "close_contact" | "other" | "none"
      "symptoms":       ["vomiting", "diarrhea"]   # the app's symptom ids
      "place":          "tempe-hassayampa"         # a residence id, a campus id, or "unknown"
      "pathogen":       "norovirus"                # a disease named in the text, or "none"
      "campus":         "tempe"                    # or None
      "onset_days_ago": 1                          # or None
      "confidence":     0.0 - 1.0
      "method":         "openai" | "keywords"
    }

The worker does NOT decide the syndrome or pathogen type. The dashboard
does that with the same rules it uses for survey reports, so every
source is labeled the same way.

Two extractors:
  * extract_openai()   - an LLM with Structured Outputs (the main one)
  * extract_keywords() - a transparent keyword method, used for testing,
                         as a fallback if the API fails, and as a
                         baseline to compare the LLM against.
"""

import json
import os
import re

# ---------------------------------------------------------------------------
# 1. Vocabulary shared with index.html. Keep these in sync with the app.
# ---------------------------------------------------------------------------

SYMPTOM_IDS = [
    "cough", "sorethroat", "nose", "sob", "smell", "ear", "sinus",
    "fever", "chills", "aches", "fatigue", "headache", "glands", "stiffneck",
    "nausea", "vomiting", "diarrhea", "blood", "cramps",
    "rash", "itchy", "eyes",
]

# Places: residence ids from RESIDENCES in index.html, plus campus-wide ids.
RESIDENCE_CAMPUS = {
    "tempe-barrett": "tempe", "tempe-hassayampa": "tempe", "tempe-manzanita": "tempe",
    "tempe-tooker": "tempe", "tempe-vds": "tempe", "tempe-sonora": "tempe", "tempe-other": "tempe",
    "dtphx-taylor": "downtown", "dtphx-other": "downtown",
    "poly-century": "poly", "poly-other": "poly",
    "west-casadeoro": "west", "west-other": "west",
}
CAMPUS_IDS = {"campus-tempe": "tempe", "campus-downtown": "downtown", "campus-poly": "poly", "campus-west": "west"}
PLACE_IDS = list(RESIDENCE_CAMPUS) + list(CAMPUS_IDS) + ["unknown"]

# Diseases a text may name directly (news and notices often name the disease, not the symptoms).
PATHOGEN_IDS = ["none", "norovirus", "rotavirus", "influenza", "covid", "rsv", "strep", "salmonella",
                "cryptosporidium", "measles", "mono", "other"]
PATHOGEN_ALIASES = {
    "norovirus": ["norovirus", "noro", "stomach flu", "winter vomiting"],
    "rotavirus": ["rotavirus"],
    "influenza": ["influenza", "the flu", "have flu", "got flu", "flu outbreak", "flu cases", "flu going around", "flu a", "flu b"],
    "covid": ["covid", "covid-19", "coronavirus", "sars-cov-2"],
    "rsv": ["rsv"],
    "strep": ["strep", "strep throat"],
    "salmonella": ["salmonella"],
    "cryptosporidium": ["cryptosporidium", "crypto outbreak"],
    "measles": ["measles"],
    "mono": ["mono", "mononucleosis"],
}

# Names and nicknames people actually use. Longest names are checked first.
PLACE_ALIASES = {
    "tempe-hassayampa": ["hassayampa", "hassy", "hassy village"],
    "tempe-manzanita": ["manzanita", "manzy"],
    "tempe-tooker": ["tooker"],
    "tempe-vds": ["vista del sol", "vds"],
    "tempe-barrett": ["barrett"],
    "tempe-sonora": ["sonora"],
    "dtphx-taylor": ["taylor place", "taylor"],
    "poly-century": ["century hall"],
    "west-casadeoro": ["casa de oro"],
    # Campus-level places: names, nicknames and well-known buildings. The grounding check only
    # accepts places named here, so add any nickname students use that's missing.
    "campus-tempe": ["tempe campus", "asu tempe", "main campus", "tempe", "memorial union", "the mu",
                     "hayden library", "hayden", "sun devil fitness", "sdfc", "biodesign"],
    "campus-downtown": ["downtown phoenix", "downtown phx", "downtown campus", "asu downtown", "dtphx", "dt phx",
                        "downtown", "health north", "health south", "cronkite"],
    "campus-poly": ["polytechnic", "polytech", "poly tech", "asu poly", "poly campus", "poly"],
    "campus-west": ["west valley", "west campus", "asu west", "west valley campus"],
}

# ---------------------------------------------------------------------------
# 2. OpenAI extractor (Structured Outputs: the model must return this schema)
# ---------------------------------------------------------------------------

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "is_illness": {"type": "boolean",
                       "description": "True only if the text says a real person is sick now or very recently."},
        "who": {"type": "string", "enum": ["self", "close_contact", "other", "none"]},
        "symptoms": {"type": "array", "items": {"type": "string", "enum": SYMPTOM_IDS}},
        "place": {"type": "string", "enum": PLACE_IDS},
        "pathogen": {"type": "string", "enum": PATHOGEN_IDS},
        "onset_days_ago": {"type": ["integer", "null"]},
        "confidence": {"type": "number"},
    },
    "required": ["is_illness", "who", "symptoms", "place", "pathogen", "onset_days_ago", "confidence"],
}

INSTRUCTIONS = """You extract illness information for a university syndromic surveillance system
at Arizona State University. You read one short text (a social post, video transcript,
news headline or campus notice) and return JSON that matches the schema.

Rules:
- is_illness is true only when a real person is sick NOW or in the last few days.
  It is false for figurative language ("this beat is sick", "I'm dead", "dying lol"),
  jokes, vaccine or clinic announcements, general health advice, and past illnesses.
- who: "self" (the writer), "close_contact" (roommate, friend, floor, class), "other"
  (people in general), or "none".
- symptoms: only symptoms the text says are present, mapped to the allowed ids. Never add a
  symptom the text doesn't describe. Respect negation: "no fever" means fever is NOT present.
  Map slang, e.g. "threw up"/"puking" -> vomiting; "the runs"/"blew up the toilet"/"on the toilet all night"
  -> diarrhea; "hurts to swallow"/"throat is on fire" -> sorethroat; "snot"/"can't stop sneezing"/"stuffy" -> nose;
  "burning up" -> fever; "wiped out" -> fatigue; "my head is pounding" -> headache.
- place: ONLY a place the text names, using the most specific one (residence halls first, then campus).
  Most posts don't name a place: then answer "unknown". Never default to campus-tempe or any campus.
  Nicknames and buildings: "hassy" = tempe-hassayampa, "manzy" = tempe-manzanita, "vds" = tempe-vds,
  "the MU"/"Hayden"/"SDFC" = campus-tempe; "Health North"/"Health South"/"Cronkite"/"Taylor" = Downtown Phoenix
  (Taylor Place is dtphx-taylor; the others are campus-downtown); "polytech"/"poly" = campus-poly;
  "asu west" = campus-west; "main campus" = campus-tempe.
- pathogen: a disease the text names as present ("norovirus cases", "I have the flu", "strep is going around"),
  otherwise "none". Do not infer a disease from symptoms alone. A vaccine or clinic notice is not a case.
- onset_days_ago: whole days since symptoms started if stated ("since Tuesday", "last night" = 0 or 1),
  otherwise null.
- confidence: 0 to 1, how sure you are that is_illness is correct.

Examples:
"Somebody blew up the toilet in health north, gross" ->
  {"is_illness": true, "who": "other", "symptoms": ["diarrhea"], "place": "campus-downtown", "pathogen": "none", "onset_days_ago": null, "confidence": 0.7}
"tfw you wake up and it hurts to swallow" ->
  {"is_illness": true, "who": "self", "symptoms": ["sorethroat"], "place": "unknown", "pathogen": "none", "onset_days_ago": 0, "confidence": 0.85}
"that new dining hall is sick!" ->
  {"is_illness": false, "who": "none", "symptoms": [], "place": "unknown", "pathogen": "none", "onset_days_ago": null, "confidence": 0.95}
"half my floor at hassy has noro, everyone's puking" ->
  {"is_illness": true, "who": "close_contact", "symptoms": ["vomiting"], "place": "tempe-hassayampa", "pathogen": "norovirus", "onset_days_ago": null, "confidence": 0.95}
Return only the JSON."""


def make_client():
    """An OpenAI client. OPENAI_BASE_URL points it at a gateway such as https://openai.rc.asu.edu/v1."""
    from openai import OpenAI  # imported here so the keyword method works without the package
    return OpenAI(api_key=os.environ.get("OPENAI_API_KEY"),
                  base_url=os.environ.get("OPENAI_BASE_URL") or None,
                  # Give up on a request after 30 seconds (the library default is 10 minutes),
                  # and retry once, so a stalled gateway can't freeze the worker or a live demo.
                  timeout=float(os.environ.get("OPENAI_TIMEOUT", "30")),
                  max_retries=1)


_mode = {"value": "json_schema"}   # remembers if the gateway needed the simpler JSON mode


def extract_openai(text, client=None, model=None):
    """Ask the model for a structured record. Raises on API errors (the caller falls back to keywords).

    Tries strict Structured Outputs first. Some gateways don't support that option; then it
    uses plain JSON mode with the schema written into the instructions, and clean() still
    checks every field, so the result has the same shape either way.
    """
    client = client or make_client()
    model = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    messages = [{"role": "system", "content": INSTRUCTIONS}, {"role": "user", "content": text[:2000]}]
    if _mode["value"] == "json_schema":
        try:
            response = client.chat.completions.create(
                model=model, temperature=0, messages=messages,   # temperature 0: as repeatable as possible
                response_format={"type": "json_schema",
                                 "json_schema": {"name": "illness_extraction", "strict": True, "schema": SCHEMA}})
            return ground(clean(json.loads(response.choices[0].message.content), method="openai"), text)
        except Exception as e:
            if not _looks_like_unsupported(e):
                raise
            print("  ! Structured Outputs not supported here; switching to JSON mode")
            _mode["value"] = "json_object"
    response = client.chat.completions.create(
        model=model, temperature=0,
        messages=[{"role": "system", "content": INSTRUCTIONS + "\n\nReturn a JSON object matching this JSON Schema exactly:\n"
                   + json.dumps(SCHEMA)}, messages[1]],
        response_format={"type": "json_object"})
    return ground(clean(json.loads(response.choices[0].message.content), method="openai"), text)


def place_named(place, text):
    """True if the text contains a name or nickname for this place (or, for a campus, for one of its halls)."""
    t = " " + text.lower().replace("\u2019", "'") + " "
    names = list(PLACE_ALIASES.get(place, []))
    campus = CAMPUS_IDS.get(place)
    if campus:   # a campus is also "named" when one of its residence halls is
        for rid, c in RESIDENCE_CAMPUS.items():
            if c == campus:
                names += PLACE_ALIASES.get(rid, [])
    return any(_has(t, n) for n in names)


def ground(r, text):
    """Grounding check: keep the model's place only if the text actually names it.

    LLMs tend to fill in a plausible place (usually Tempe) when none is given. A place
    that can't be found in the text becomes "unknown", so the map and the place table
    only show places people actually mentioned.
    """
    # If the text doesn't name the model's place, use the place the text does name
    # (from the list of names and nicknames), or "unknown".
    if r["place"] != "unknown" and not place_named(r["place"], text):
        fixed = find_place(text)
        r = {**r, "place": fixed, "campus": RESIDENCE_CAMPUS.get(fixed) or CAMPUS_IDS.get(fixed),
             "place_corrected": True}
    return r


def _looks_like_unsupported(e):
    """True if the error says the response_format / json_schema option isn't supported."""
    msg = str(e).lower()
    return getattr(e, "status_code", None) in (400, 422) and any(w in msg for w in ("response_format", "json_schema", "schema", "not supported", "unsupported"))


def list_models(client=None):
    """Model names the API key can use (helps when a gateway uses its own names)."""
    client = client or make_client()
    return sorted(m.id for m in client.models.list().data)


# ---------------------------------------------------------------------------
# 3. Keyword extractor (transparent baseline and fallback)
# ---------------------------------------------------------------------------

# Phrase -> symptom id. Checked as whole words, case-insensitive.
LEXICON = {
    "vomiting": ["throwing up", "threw up", "throw up", "puking", "puked", "vomiting", "vomited", "vomit"],
    "diarrhea": ["diarrhea", "the runs", "stomach bug"],
    "nausea": ["nauseous", "nausea", "queasy", "sick to my stomach"],
    "cramps": ["stomach cramps", "cramps", "stomach hurts", "stomach ache", "stomachache"],
    "fever": ["fever", "feverish", "burning up", "temperature of", "running a temp"],
    "chills": ["chills", "shivering"],
    "cough": ["coughing", "cough"],
    "sorethroat": ["sore throat", "throat hurts", "throat is killing"],
    "nose": ["runny nose", "stuffy", "congested", "sneezing", "sniffles"],
    "aches": ["body aches", "body hurts", "everything hurts", "aching"],
    "fatigue": ["exhausted", "wiped out", "so tired", "no energy", "fatigue"],
    "headache": ["headache", "migraine", "head is pounding", "head hurts"],
    "sob": ["can't breathe", "short of breath", "trouble breathing"],
    "smell": ["can't taste", "can't smell", "lost my taste", "lost my smell"],
    "rash": ["rash", "hives", "spots all over"],
    "itchy": ["itchy", "itching"],
    "eyes": ["pink eye", "red eyes", "itchy eyes", "eyes are burning"],
    "stiffneck": ["stiff neck"],
    "glands": ["swollen glands", "swollen lymph"],
    "ear": ["ear hurts", "earache", "ear infection"],
    "sinus": ["sinus"],
    "blood": ["blood in my stool", "bloody stool"],
}

# Phrases that look like illness but aren't (filtered out first).
FIGURATIVE = [r"\bsick (beat|song|track|trick|fit|shot|play|goal|view)\b", r"\bsick of\b",
              r"\b(track|song|beat|game|defense|play|view|fit|shot|trick|set|drop) (is|was) (so |really |lowkey )?sick\b",
              r"\bdying (lol|lmao|laughing)\b", r"\bi'?m dead\b", r"\bflu shots?\b",
              r"\bvaccin", r"\bclinic (hours|open)", r"\bhealth fair\b"]
NEGATIONS = ["no", "not", "without", "never", "don't have", "dont have", "isn't", "wasn't", "no more"]
# Strong words clearly mean illness on their own; "sick"/"ill" alone are often slang, so they count only weakly.
STRONG_SICK = (r"\b(food poisoning|the flu|have flu|got flu|covid|norovirus|noro|stomach bug|bug going around|outbreak|"
               r"stomach illness|cases (reported|confirmed)|feel(ing)? (awful|terrible|horrible|like death))\b")
WEAK_SICK = r"\b(sick|ill|unwell)\b"
CONTACT_WORDS = r"\b(roommate|suitemate|my friend|friends|my floor|whole floor|half (my|the) floor|everyone|my class|people in)\b"


def _has(text, phrase):
    return re.search(r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])", text) is not None


def _negated(text, phrase):
    """True if a negation word appears within the 3 words before the phrase."""
    m = re.search(r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])", text)
    if not m:
        return False
    before = text[:m.start()].split()[-3:]
    window = " ".join(before)
    return any(_has(window, n) for n in NEGATIONS)


def find_place(text):
    """The most specific place named in the text, from PLACE_ALIASES (residence halls before campuses)."""
    t = " " + text.lower().replace("\u2019", "'") + " "
    for pid, names in sorted(PLACE_ALIASES.items(), key=lambda kv: (kv[0].startswith("campus-"), -max(len(n) for n in kv[1]))):
        if any(_has(t, n) for n in names):
            return pid
    return "unknown"


def extract_keywords(text):
    t = " " + text.lower().replace("’", "'") + " "
    figurative = any(re.search(p, t) for p in FIGURATIVE)

    symptoms = []
    for sid, phrases in LEXICON.items():
        hit = next((p for p in phrases if _has(t, p)), None)
        if hit and not _negated(t, hit):
            symptoms.append(sid)

    # A strong word counts only if it isn't negated ("no covid, just allergies").
    strong = not figurative and any(not _negated(t, m.group(0)) for m in re.finditer(STRONG_SICK, t))
    weak = re.search(WEAK_SICK, t) is not None and not figurative
    is_illness = bool(symptoms) or strong or weak
    if figurative and not symptoms:
        is_illness = False

    place = find_place(t)

    onset = None
    if re.search(r"\b(last night|this morning|today|tonight)\b", t):
        onset = 0
    elif re.search(r"\byesterday\b", t):
        onset = 1
    else:
        m = re.search(r"\b(\d+|two|three|four|five) days?\b", t)
        if m:
            words = {"two": 2, "three": 3, "four": 4, "five": 5}
            onset = int(words.get(m.group(1), m.group(1)))

    pathogen = "none"
    if not figurative:
        for pid, names in PATHOGEN_ALIASES.items():
            if any(_has(t, n) for n in names) and not any(_negated(t, n) for n in names if _has(t, n)):
                pathogen = pid
                break
    if pathogen != "none":
        is_illness = True

    who = "none"
    if is_illness:
        who = "close_contact" if re.search(CONTACT_WORDS, t) else "self"

    # Confidence grows with the number of symptoms; a clear illness word alone ("food poisoning") counts as 0.55.
    # (Below 0.5 with no symptoms, clean() drops it: a bare "sick" isn't enough evidence.)
    confidence = 0.0 if not is_illness else min(0.9, max(0.55 if (strong or pathogen != "none") else 0.0, 0.4 + 0.15 * len(symptoms)))
    return clean({"is_illness": is_illness, "who": who, "symptoms": symptoms, "place": place, "pathogen": pathogen,
                  "onset_days_ago": onset, "confidence": confidence}, method="keywords")


# ---------------------------------------------------------------------------
# 4. Cleaning: never trust any extractor's output blindly
# ---------------------------------------------------------------------------

def clean(r, method):
    symptoms = sorted({s for s in (r.get("symptoms") or []) if s in SYMPTOM_IDS})
    place = r.get("place") if r.get("place") in PLACE_IDS else "unknown"
    onset = r.get("onset_days_ago")
    onset = onset if isinstance(onset, int) and 0 <= onset <= 30 else None
    try:
        conf = max(0.0, min(1.0, float(r.get("confidence", 0))))
    except (TypeError, ValueError):
        conf = 0.0
    pathogen = r.get("pathogen") if r.get("pathogen") in PATHOGEN_IDS else "none"
    is_illness = bool(r.get("is_illness")) and (bool(symptoms) or pathogen != "none" or conf >= 0.5)
    return {
        "is_illness": is_illness,
        "who": r.get("who") if r.get("who") in ("self", "close_contact", "other", "none") else "none",
        "symptoms": symptoms if is_illness else [],
        "place": place,
        "pathogen": pathogen if is_illness else "none",
        "campus": RESIDENCE_CAMPUS.get(place) or CAMPUS_IDS.get(place),
        "onset_days_ago": onset,
        "confidence": round(conf, 2),
        "method": method,
    }


def extract(text, use_openai=True):
    """Main entry point: try OpenAI, fall back to keywords if it fails."""
    if use_openai:
        try:
            return extract_openai(text)
        except Exception as e:  # network down, bad key, rate limit...
            print(f"  ! OpenAI failed ({type(e).__name__}: {e}); using keyword fallback")
    return extract_keywords(text)
