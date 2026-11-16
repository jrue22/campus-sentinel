/* =====================================================================
   CAMPUS SENTINEL: example (demo) data, generated fresh
   ---------------------------------------------------------------------
   One place that builds every kind of example data, with dates relative
   to today so a demo never goes stale. Used by:
     - demo-data.html: deletes the old example data in the database and writes new
     - index.html: when the database can't be reached, the demo runs on this data in memory
   Every record carries demo: true. The stories line up across sources:
     norovirus at Hassayampa (reports, wastewater, posts, news, lab)
     influenza A at Gordon Commons, Downtown (reports, wastewater, posts, news, lab)
     Salmonella near West Valley (wastewater, news, lab cultures and genomes)
     strep-like illness at Century Hall, Polytechnic (reports, lab)
     SARS-CoV-2 lineage XFG taking over (wastewater sequencing, lab genomes)
   ===================================================================== */
window.DemoData = (function () {
  "use strict";
  function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
  function isoDate(daysAgo) {
    const d = new Date(); d.setDate(d.getDate() - daysAgo);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString();

  // ---------- Symptom reports (38) ----------
  function reports() {
    const rand = rng(7), pick = list => list[Math.floor(rand() * list.length)];
    const submitted = (daysAgo, lag, hour) => {
      const d = new Date(); d.setDate(d.getDate() - Math.max(0, daysAgo - lag));
      d.setHours(hour, Math.floor(rand() * 60), 0, 0);
      if (d > new Date()) d.setTime(Date.now() - 5 * 60000);
      return d.toISOString();
    };
    const out = [];
    const add = (residence, campuses, daysAgo, symptoms, o = {}) => out.push({
      campuses, residence, onset: isoDate(daysAgo), symptoms,
      maxTempF: o.temp ?? null, severity: o.sev || "moderate", contacts: o.contacts || "unsure",
      sharedMeal: !!o.meal, travel: false, sawProvider: false,
      submittedAt: submitted(daysAgo, o.lag ?? 1, o.hour ?? 10), demo: true,
    });
    // Norovirus-like cluster in one residence hall, growing over the last 5 days
    [[4,1,9],[3,1,14],[3,0,20],[2,1,8],[2,0,17],[1,1,9],[1,0,13],[0,0,8]].forEach(([d, lag, hour]) =>
      add("tempe-hassayampa", ["tempe"], d, ["nausea", "vomiting", "diarrhea", "cramps"].concat(d % 2 ? ["fever"] : []),
        { sev: pick(["moderate", "severe"]), contacts: "yes", lag, hour }));
    // Influenza-like illness downtown
    [5, 4, 2, 1].forEach(d => add("dtphx-taylor", ["downtown"], d, ["fever", "cough", "aches", "fatigue", "headache"],
      { temp: pick([101.4, 102.6, 100.8]), contacts: "yes" }));
    // Strep-like group at Polytechnic
    [6, 3, 1].forEach(d => add("poly-century", ["poly"], d, ["fever", "sorethroat", "glands", "headache"], { temp: 101.8 }));
    // Background illness spread over two weeks
    const bg = [
      ["off-tempe", ["tempe"], ["nose", "sorethroat", "cough"]], ["tempe-manzanita", ["tempe"], ["cough", "nose", "fatigue"]],
      ["off-west", ["west"], ["eyes", "nose"]], ["tempe-tooker", ["tempe"], ["rash", "itchy"]],
      ["off-home", ["online"], ["headache", "fatigue"]], ["off-dtphx", ["downtown", "tempe"], ["diarrhea", "cramps", "fever"]],
      ["tempe-barrett", ["tempe"], ["fever", "cough", "smell", "fatigue"]], ["west-casadeoro", ["west"], ["sinus", "nose", "headache"]],
      ["tempe-vds", ["tempe"], ["cough", "nose"]], ["off-poly", ["poly"], ["nausea", "diarrhea"]],
    ];
    for (let i = 0; i < 22; i++) {
      const [res, campuses, symptoms] = bg[i % bg.length];
      add(res, campuses, Math.floor(rand() * 14), symptoms, { sev: "mild", contacts: pick(["no", "unsure"]), meal: i === 5 });
    }
    add("tempe-hassayampa", ["tempe"], 10, ["nausea", "diarrhea"], { sev: "mild", contacts: "no" });   // baseline for "Rising"
    return out;
  }

  // ---------- Wastewater (every 3 days, 37 days) ----------
  // Quiet baselines, with surges that start ~9 days ago and peak today, so wastewater rises before the reports.
  function wastewater() {
    const rand = rng(11);
    const base = { sars2: 8000, fluA: 2500, fluB: 1500, rsv: 1800, noro: 20000, rota: 900, salm: 600, crypto: 60 };
    const surge = { "tempe-hassayampa|noro": 6, "tempe-campus|noro": 3, "dtphx-campus|fluA": 4, "west-campus|salm": 3.5 };
    const out = [];
    for (let ago = 0; ago <= 36; ago += 3) {
      for (const s of window.WW_SITES) for (const t of window.WW_TARGETS) {
        const m = surge[s.id + "|" + t.id] || 1;
        const f = ago <= 9 ? 1 + (m - 1) * (1 - ago / 18) : 1;
        const nonDetect = t.category !== "viral" && f === 1 && rand() < 0.15;   // bacteria and parasites are often not detected
        out.push({ site: s.id, target: t.id, date: isoDate(ago),
          copiesPerL: nonDetect ? 0 : Math.round((base[t.id] || 1000) * f * (0.75 + 0.5 * rand())),
          pmmovPerL: Math.round(1e6 * (0.7 + 0.6 * rand())), submittedAt: new Date().toISOString(), demo: true });
      }
    }
    return out;
  }
  const wastewaterId = d => "demo_" + d.date + "_" + d.site + "_" + d.target;

  // ---------- SARS-CoV-2 lineages from wastewater sequencing (weekly, 8 weeks, 4 sites) ----------
  // XFG reaches Tempe first and takes over fast; Downtown follows slowly; West Valley is mid-takeover;
  // Polytechnic keeps a different, stable mix.
  function lineages() {
    const rand = rng(23);
    const SITES = {
      "tempe-campus": { mid: 3.5, speed: 1.8, max: 0.85, mix: { "LP.8.1": 0.55, "NB.1.8.1": 0.27, "XEC": 0.18 }, minor: { "BA.2.86": 0.04 } },
      "dtphx-campus": { mid: 5.0, speed: 0.9, max: 0.70, mix: { "LP.8.1": 0.38, "NB.1.8.1": 0.32, "XEC": 0.30 }, minor: { "BA.2.86": 0.05, "KP.3.1.1": 0.05 } },
      "west-campus":  { mid: 6.5, speed: 1.2, max: 0.65, mix: { "LP.8.1": 0.68, "NB.1.8.1": 0.20, "XEC": 0.12 }, minor: { "BA.2.86": 0.03 } },
      "poly-campus":  { mid: 99,  speed: 1.0, max: 0,    mix: { "NB.1.8.1": 0.58, "LP.8.1": 0.30, "XEC": 0.12 }, minor: { "BA.2.86": 0.04 } },
    };
    const out = [];
    for (const [site, c] of Object.entries(SITES)) {
      const minorTotal = Object.values(c.minor).reduce((a, b) => a + b, 0);
      for (let w = 0; w < 8; w++) {
        const xfg = c.max / (1 + Math.exp(-(w - c.mid) * c.speed));
        const rest = 1 - xfg - minorTotal;
        const list = [{ lineage: "XFG", share: xfg }];
        for (const k in c.mix) list.push({ lineage: k, share: rest * c.mix[k] * (0.85 + 0.3 * rand()) });
        for (const k in c.minor) list.push({ lineage: k, share: c.minor[k] });
        const total = list.reduce((a, x) => a + x.share, 0);
        out.push({ site, date: isoDate((7 - w) * 7), demo: true, submittedAt: new Date().toISOString(),
          lineages: list.filter(x => x.share >= 0.005).map(x => ({ lineage: x.lineage, share: Math.round(1000 * x.share / total * 0.97) / 1000 })) });
      }
    }
    return out;
  }
  const lineageId = d => "demo_" + d.date + "_" + d.site;

  // ---------- Social posts and news, as the NLP worker would have saved them ----------
  function media() {
    const out = [];
    const post = (mins, place, symptoms, o = {}) => {
      const campus = { "tempe-hassayampa": "tempe", "dtphx-taylor": "downtown", "campus-tempe": "tempe", "poly-century": "poly", "campus-west": "west" }[place] || null;
      out.push({ source: o.source || "demo-feed", postedAt: minutesAgo(mins), processedAt: minutesAgo(Math.max(0, mins - 1)),
        isIllness: o.ill !== false, who: o.ill === false ? "none" : (o.who || "self"), symptoms: o.ill === false ? [] : symptoms,
        place: place || "unknown", pathogen: o.pathogen || "none", campus, onsetDaysAgo: o.onset ?? null,
        confidence: o.ill === false ? 0 : (o.conf || 0.8), method: "demo", placeCorrected: false, symptomsAdded: [], symptomsRemoved: [], demo: true });
    };
    // A burst of stomach-bug posts from Hassayampa in the last 40 minutes (a "spike")
    post(4, "tempe-hassayampa", ["vomiting"], { who: "close_contact" });
    post(9, "tempe-hassayampa", ["diarrhea", "cramps"]);
    post(15, "tempe-hassayampa", ["nausea", "vomiting"], { who: "close_contact" });
    post(22, "tempe-hassayampa", ["vomiting"]);
    post(31, "tempe-hassayampa", ["diarrhea"], { pathogen: "norovirus" });
    post(38, "campus-tempe", ["vomiting", "nausea"]);
    // Earlier posts over the last 3 days
    post(95, "dtphx-taylor", ["fever", "cough", "chills"]);
    post(400, "dtphx-taylor", ["fever", "aches"], { who: "close_contact" });
    post(1300, "poly-century", ["sorethroat", "fever"]);
    post(2200, "tempe-hassayampa", ["vomiting"], { source: "reddit" });
    post(3100, null, ["nose", "cough"]);
    // Posts the NLP correctly decided were not about illness
    post(12, "campus-tempe", [], { ill: false });
    post(60, null, [], { ill: false });
    post(700, "campus-west", [], { ill: false });

    const story = (hours, title, slug, f) => out.push({ source: "news", postedAt: minutesAgo(hours * 60), processedAt: minutesAgo(hours * 60 - 5),
      isIllness: f.topic === "infectious_disease" && ["cases_or_outbreak", "exposure_warning"].includes(f.type),
      who: "other", symptoms: f.symptoms || [], place: f.place || "unknown", pathogen: f.pathogen || "none",
      campus: { "tempe-hassayampa": "tempe", "dtphx-taylor": "downtown", "campus-west": "west", "poly-century": "poly" }[f.place] || null,
      onsetDaysAgo: null, confidence: 0.9, method: "demo", placeCorrected: false, symptomsAdded: [], symptomsRemoved: [], demo: true,
      outlet: "Valley Demo News (practice feed)", healthTopic: f.topic, reportType: f.type, syndrome: f.syndrome || "none",
      region: f.region || "unknown", caseCount: f.cases ?? null,
      ...(f.topic === "infectious_disease" ? { headline: title, link: "https://example.com/valley-demo-news/" + slug } : {}) });
    story(1, "Norovirus suspected after dozens fall ill at ASU's Hassayampa residence hall", "hassayampa-norovirus",
      { topic: "infectious_disease", type: "cases_or_outbreak", pathogen: "norovirus", syndrome: "gi", place: "tempe-hassayampa", region: "asu_campus", symptoms: ["vomiting", "diarrhea"] });
    story(3, "Free flu shot clinics open at Valley libraries this week", "flu-shot-clinics", { topic: "infectious_disease", type: "advisory_or_prevention", pathogen: "influenza", region: "arizona" });
    story(16, "Wave of fevers and coughs reported at Gordon Commons in downtown Phoenix", "gordon-commons-flu",
      { topic: "infectious_disease", type: "cases_or_outbreak", pathogen: "influenza", syndrome: "ili", place: "dtphx-taylor", region: "asu_campus", symptoms: ["fever", "cough", "aches"] });
    story(21, "Light rail extension opens new stops in Tempe", "light-rail-tempe", { topic: "not_health", type: "none" });
    story(26, "Salmonella cases tied to food truck near ASU West Valley campus", "west-valley-salmonella",
      { topic: "infectious_disease", type: "cases_or_outbreak", pathogen: "salmonella", syndrome: "gi", place: "campus-west", region: "asu_campus", symptoms: ["diarrhea", "fever", "cramps"] });
    story(36, "Booker's sick fadeaway seals Suns comeback win", "suns-comeback", { topic: "not_health", type: "none" });
    story(48, "Mono going around Century Hall, Polytechnic students say", "century-hall-mono",
      { topic: "infectious_disease", type: "cases_or_outbreak", pathogen: "mono", syndrome: "ili", place: "poly-century", region: "asu_campus", symptoms: ["sorethroat", "fever", "fatigue"] });
    story(54, "ER visits for gambling disorder climb as sports betting grows", "gambling-er", { topic: "other_health", type: "none", region: "arizona" });
    story(72, "Strep throat cases reported at a Mesa elementary school", "mesa-strep", { topic: "infectious_disease", type: "cases_or_outbreak", pathogen: "strep", syndrome: "ili", region: "arizona" });
    story(78, "Last year's flu season was the worst in a decade, report finds", "flu-season-report", { topic: "infectious_disease", type: "past_event", pathogen: "influenza" });
    story(96, "Possible measles exposure at a Phoenix shopping center, county says", "measles-exposure",
      { topic: "infectious_disease", type: "exposure_warning", pathogen: "measles", syndrome: "skin", region: "arizona" });
    story(100, "Polytechnic campus hosts student drone competition", "poly-drones", { topic: "not_health", type: "none" });
    return out;
  }

  // ---------- Lab portal patients and results (from lab-demo.js) ----------
  function lab() { return window.LAB_DEMO ? window.LAB_DEMO.build(isoDate(0)) : { patients: [], results: [] }; }

  return { reports, wastewater, wastewaterId, lineages, lineageId, media, lab, isoDate };
})();
