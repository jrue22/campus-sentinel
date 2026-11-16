/* =====================================================================
   SENTINEL LAB PORTAL: the logic
   Sections:
     1 Helpers
     2 Data store (one interface, two back ends: demo memory or Firestore)
     3 Interpretation rules (the "pipeline" that turns results into findings)
     4 File readers (CSV templates, Nextclade, AMRFinderPlus, mlst, chewBBACA)
     5 Clinician views (worklist, patients, patient record, import, outbreaks)
     6 Patient view
     7 Researcher view (de-identified)
     8 Printed reports
     9 Sign-in, roles and startup
   ===================================================================== */
"use strict";

/* =====================================================================
   1. HELPERS
   ===================================================================== */
const $ = id => document.getElementById(id);
const C = window.LAB_CONFIG, TH = C.thresholds;
const TARGETS = window.LAB_TARGETS, ORGS = window.LAB_ORGANISMS, DRUGS = window.LAB_DRUGS;
const PLACES = window.LAB_PLACES, CAMPUSES = window.LAB_CAMPUSES, SYN = window.LAB_SYNDROMES;
const KIND_NAMES = { pcr: "PCR panel", culture: "Culture + susceptibility", viral_genome: "Viral genome", bacterial_genome: "Bacterial genome" };

function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function localDate(when) {
  const d = new Date(when); if (isNaN(d)) return null;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const todayStr = () => localDate(new Date());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toUTC = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (s, n) => new Date(toUTC(s) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);
function mmwrWeek(str) {   // CDC epidemiological week (same as index.html)
  const t = toUTC(str);
  const startOf = y => { const jan1 = new Date(Date.UTC(y, 0, 1)); const dow = jan1.getUTCDay(); return Date.UTC(y, 0, dow <= 3 ? 1 - dow : 8 - dow); };
  let year = Number(str.slice(0, 4)), start = startOf(year);
  if (t < start) { year -= 1; start = startOf(year); } else if (t >= startOf(year + 1)) { year += 1; start = startOf(year); }
  return year + "-W" + String(Math.floor((t - start) / (7 * 864e5)) + 1).padStart(2, "0");
}
const fmtDate = s => s ? new Date(s.length === 10 ? s + "T12:00:00" : s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const fmtTime = s => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const placeName = id => (PLACES[id] || [id || "Unknown"])[0];
const placeCampus = id => (PLACES[id] || [])[1] || null;
const ageOf = p => p && p.birthYear ? new Date().getFullYear() - p.birthYear : null;
const ageBand = a => a == null ? "unknown" : a < 18 ? "under 18" : a <= 21 ? "18-21" : a <= 25 ? "22-25" : a <= 34 ? "26-34" : "35+";
const synTag = id => SYN[id] ? `<span class="syn"><i class="sw" style="background:${SYN[id][1]}"></i>${SYN[id][0]}</span>` : "";
const plural = (n, w, pl) => `${n} ${n === 1 ? w : (pl || w + "s")}`;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const catName = c => ({ viral: "Viral", bacterial: "Bacterial", parasitic: "Parasitic", fungal: "Fungal" }[c] || "Undetermined");

/* =====================================================================
   2. DATA STORE
   The rest of the app only calls these functions (like the paper's
   "data access layer"). In demo mode they change arrays in memory; when
   signed in they write to Firestore, and the live listeners update the page.
   ===================================================================== */
const state = {
  mode: null,            // "demo" or "live"
  role: null,            // "patient", "clinician" or "researcher"
  user: null,            // signed-in Firebase user
  patients: [], results: [], deid: [], lineages: [],
  ctab: "worklist", patientId: null, worklistFilter: "open", demoPatientId: null,
  db: null, auth: null, unsub: [],
};

const store = {
  async addPatient(p) {
    if (state.mode === "demo") { state.patients.push(p); return render(); }
    await state.db.collection("lab_patients").doc(p.id).set(p);
  },
  async updatePatient(id, fields) {
    if (state.mode === "demo") { Object.assign(state.patients.find(p => p.id === id), fields); }
    else await state.db.collection("lab_patients").doc(id).update(fields);
    // Patients find their results by ownerEmail, so it is copied onto every result.
    if ("ownerEmail" in fields) {
      const mine = state.results.filter(r => r.patientId === id);
      if (state.mode === "demo") mine.forEach(r => { r.ownerEmail = fields.ownerEmail; });
      else await commitInBatches(mine.map(r => b => b.update(state.db.collection("lab_results").doc(r.id), { ownerEmail: fields.ownerEmail })));
    }
    if (state.mode === "demo") render();
  },
  async addResults(list) {
    if (state.mode === "demo") { state.results.push(...list); return render(); }
    await commitInBatches(list.map(r => b => b.set(state.db.collection("lab_results").doc(r.id), r)));
  },
  async updateResult(id, fields) {
    if (state.mode === "demo") { Object.assign(state.results.find(r => r.id === id), fields); return render(); }
    await state.db.collection("lab_results").doc(id).update(fields);
  },
  async saveDeid(id, doc) {
    if (state.mode === "demo") return;            // demo: the researcher view builds these on the fly
    await state.db.collection("lab_deid").doc(id).set(doc);
  },
  async loadDemoIntoDatabase() {
    const { patients, results } = LAB_DEMO.build(todayStr());
    await commitInBatches([
      ...patients.map(p => b => b.set(state.db.collection("lab_patients").doc(p.id), p)),
      ...results.map(r => b => b.set(state.db.collection("lab_results").doc(r.id), r)),
    ]);
    // signed demo results also get their de-identified copy
    const ctx = analysisContext(results, patients);
    await commitInBatches(results.filter(r => r.status === "signed").map(r => b =>
      b.set(state.db.collection("lab_deid").doc("demo-" + r.id), deidentify(r, patients.find(p => p.id === r.patientId), interpret(r, ctx)))));
  },
  async removeDemoFromDatabase() {
    const del = (col, items) => items.map(x => b => b.delete(state.db.collection(col).doc(x.id)));
    await commitInBatches([...del("lab_results", state.results.filter(r => r.demo)), ...del("lab_patients", state.patients.filter(p => p.demo)),
      ...del("lab_deid", state.deid.filter(d => d.demo))]);
  },
};
async function commitInBatches(ops) {          // Firestore allows 500 writes per batch
  for (let i = 0; i < ops.length; i += 400) {
    const b = state.db.batch(); ops.slice(i, i + 400).forEach(op => op(b)); await b.commit();
  }
}

/* =====================================================================
   3. INTERPRETATION RULES
   interpret(result, ctx) turns one result into:
     finding     one line for tables ("Influenza A detected")
     level       positive / negative / discuss
     syndrome, category, pathogens    (the same ids as the surveillance dashboard)
     flags       [{level: "alert" | "discuss" | "info", text}]
                 "discuss" = the result needs a clinician's judgment before signing
                 (like the paper's "need discussion" list for the Molecular Biology Board)
     plain       plain-language sentences for the patient
   ctx holds what a rule needs from other results: the same patient's other
   tests, genome clusters, and wastewater lineages.
   ===================================================================== */

// Built once per render: everything rules need to look across results.
function analysisContext(results, patients) {
  const byPatient = {};
  results.forEach(r => (byPatient[r.patientId] = byPatient[r.patientId] || []).push(r));
  const genomes = results.filter(r => r.kind === "bacterial_genome" && r.data && r.data.profile && Object.keys(r.data.profile).length);
  return { results, patients: patients || [], byPatient, genomes, patientOf: id => (patients || []).find(p => p.id === id) };
}

function interpret(r, ctx) {
  const f = { pcr: interpretPcr, culture: interpretCulture, viral_genome: interpretViral, bacterial_genome: interpretBacterial }[r.kind];
  const out = f ? f(r, ctx) : { finding: "Unknown test type", level: "discuss", flags: [{ level: "discuss", text: "Unknown result type." }], plain: [] };
  out.needsDiscussion = out.flags.some(x => x.level === "discuss");
  out.level = out.needsDiscussion && out.level !== "negative" ? "discuss" : out.level;
  return out;
}

// --- PCR panels ---
function interpretPcr(r) {
  const d = r.data || {}, flags = [];
  const hits = (d.targets || []).filter(t => t.result === "detected").sort((a, b) => (a.ct ?? 99) - (b.ct ?? 99));
  const name = id => (TARGETS[id] || { name: id }).name;
  const tested = (d.targets || []).length;
  if (!hits.length) return { finding: "Not detected", level: "negative", syndrome: null, category: null, pathogens: [], flags,
    plain: [`None of the ${tested} germs this ${d.panel === "gi" ? "stomach" : "respiratory"} test looks for were found.`] };
  hits.forEach(t => {
    if (t.ct != null && t.ct > TH.lateCt) flags.push({ level: "discuss", text: `<b>${esc(name(t.id))} detected late</b> (Ct ${t.ct} &gt; ${TH.lateCt}): very little genetic material. It could be early or late in illness, or contamination; consider repeating the test.` });
  });
  if (hits.length > 1) flags.push({ level: "discuss", text: `<b>Co-detection:</b> ${hits.map(t => esc(name(t.id)) + (t.ct != null ? ` (Ct ${t.ct})` : "")).join(", ")}. Decide which is most likely causing the illness; the lowest Ct usually has the most genetic material.` });
  const main = TARGETS[hits[0].id] || {};
  return { finding: hits.map(t => name(t.id)).join(" + ") + " detected", level: "positive", syndrome: main.syndrome, category: main.category,
    pathogens: hits.map(t => name(t.id)), flags,
    plain: [`The test found ${hits.map(t => name(t.id)).join(" and ")}.`, hits.length > 1 ? "Finding more than one germ is common; your clinician decides which one matters." : ""] };
}

// --- Cultures with antibiotic susceptibility (AST) ---
function interpretCulture(r) {
  const d = r.data || {}, flags = [], org = ORGS[d.organism] || {};
  const ast = d.ast || [];
  if (!d.organism || /no growth/i.test(d.organism)) return { finding: "No growth", level: "negative", flags, pathogens: [], plain: ["Nothing grew in the culture."] };
  const nonS = ast.filter(a => a.interp === "R" || a.interp === "I");
  const cats = [...new Set(nonS.map(a => DRUGS[a.drug]).filter(Boolean))];
  if (cats.length >= TH.mdrCategories)
    flags.push({ level: "alert", text: `<b>Multidrug resistant (MDR):</b> not susceptible in ${cats.length} drug categories (${cats.map(esc).join("; ")}). Definition: Magiorakos et al. 2012.` });
  if (/Escherichia|Klebsiella/.test(d.organism) && ast.some(a => ["ceftriaxone", "cefepime"].includes(a.drug) && a.interp === "R"))
    flags.push({ level: "alert", text: "<b>Possible ESBL producer:</b> resistant to 3rd-generation cephalosporins. Confirm, and consider contact precautions." });
  if (ast.some(a => DRUGS[a.drug] === "carbapenems" && a.interp !== "S"))
    flags.push({ level: "alert", text: "<b>Carbapenem not susceptible:</b> notify infection prevention and public health right away." });
  if (d.organism === "Streptococcus pyogenes" && ast.some(a => DRUGS[a.drug] === "macrolides" && a.interp === "R"))
    flags.push({ level: "info", text: "<b>Macrolide resistance:</b> azithromycin and erythromycin are unlikely to work for this patient." });
  if (!ast.length) flags.push({ level: "info", text: "No susceptibility results were reported." });
  const ok = ast.filter(a => a.interp === "S").length;
  return { finding: (org.short || d.organism) + (cats.length >= TH.mdrCategories ? " (MDR)" : ""), level: "positive",
    syndrome: org.syndrome || null, category: org.category || "bacterial", pathogens: [d.organism], flags,
    plain: [`The culture grew ${org.short || d.organism}.`, ast.length ? `The lab tested ${ast.length} antibiotics: ${ok} should work against it${nonS.length ? ` and ${nonS.length} may not` : ""}.` : ""] };
}

// --- Viral genomes (e.g. Nextclade output) ---
function interpretViral(r, ctx) {
  const d = r.data || {}, flags = [];
  if (d.coverage != null && d.coverage < TH.minCoverage)
    flags.push({ level: "discuss", text: `<b>Low coverage:</b> ${d.coverage}% of the genome was read (minimum ${TH.minCoverage}%). The lineage may be wrong; consider re-sequencing.` });
  if (d.qcStatus === "bad") flags.push({ level: "discuss", text: "<b>Nextclade quality check failed</b> (status: bad). Do not report the lineage without review." });
  else if (d.qcStatus === "mediocre") flags.push({ level: "info", text: "Nextclade quality check: mediocre." });
  if (d.frameShifts > 0) flags.push({ level: "info", text: `${plural(d.frameShifts, "frame shift")} found; these are often sequencing errors.` });
  // Integration with surveillance: is this lineage also in the campus wastewater?
  const p = ctx.patientOf(r.patientId), ww = wastewaterLineage(d.lineage, placeCampus(p && p.residence));
  if (ww) flags.push({ level: "info", text: `<b>Matches wastewater:</b> ${esc(d.lineage)} was ${Math.round(ww.share * 100)}% of SARS-CoV-2 in ${esc(ww.siteName)} on ${fmtDate(ww.date)}.` });
  const same = ctx.results.filter(x => x.kind === "viral_genome" && x.id !== r.id && x.data && x.data.lineage === d.lineage &&
    Math.abs(daysBetween(x.collected, r.collected)) <= 14).length;
  if (same) flags.push({ level: "info", text: `${plural(same, "other patient")} had ${esc(d.lineage)} within 14 days.` });
  const virusIsFlu = /influenza/i.test(d.virus || "");
  return { finding: `${d.virus || "Virus"} ${d.lineage || d.clade || "lineage unknown"}`, level: "positive",
    syndrome: "ili", category: "viral", pathogens: [d.virus || "virus"], flags,
    plain: [`The lab read the genetic code of the ${virusIsFlu ? "flu virus" : "virus"} from your sample. It belongs to the ${esc(d.lineage || d.clade || "unknown")} ${virusIsFlu ? "clade" : "lineage"}.`,
      ww ? `This version is also the one most often found in your campus wastewater, which means it is circulating widely.` : "",
      "This helps public health track which versions are spreading. It usually does not change your treatment."] };
}

// Latest wastewater sample's share of a lineage at the campus-wide sewer (from the public "lineages" data).
function wastewaterLineage(lineage, campus) {
  if (!lineage || !campus || !state.lineages.length || !window.WW_SITES) return null;
  const site = window.WW_SITES.find(s => s.campus === campus && !(s.residences || []).length);
  if (!site) return null;
  const latest = state.lineages.filter(x => x.site === site.id).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!latest) return null;
  const total = latest.lineages.reduce((n, x) => n + Number(x.share || 0), 0) || 1;
  const hit = latest.lineages.find(x => x.lineage === lineage);
  return hit ? { share: Number(hit.share) / total, date: latest.date, siteName: site.name } : null;
}

// --- Bacterial genomes (AMRFinderPlus + mlst + cgMLST allele profile) ---
// Drug categories a beta-lactamase gene is expected to affect, by gene family.
function betaLactamCategories(gene) {
  const g = gene.toLowerCase();
  if (/bla(kpc|ndm|vim|imp|oxa-48|oxa-181|oxa-232)/.test(g))
    return ["penicillins", "1st/2nd-generation cephalosporins", "3rd/4th-generation cephalosporins", "carbapenems"];
  if (/bla(ctx-m|cmy|dha|shv-(2|5|12))/.test(g)) return ["penicillins", "1st/2nd-generation cephalosporins", "3rd/4th-generation cephalosporins"];
  return ["penicillins"];
}
function geneCategories(hit) {
  const cats = new Set();
  String(hit.cls || "").toUpperCase().split("/").forEach(cl => {
    if (cl === "BETA-LACTAM") betaLactamCategories(hit.gene).forEach(c => cats.add(c));
    (window.LAB_GENE_CLASSES[cl] || []).forEach(c => cats.add(c));
  });
  return [...cats];
}
const hitConfirmed = h => (h.identity ?? 100) >= TH.minIdentity && (h.coverage ?? 100) >= TH.minGeneCoverage;

// Allele differences between two cgMLST profiles: loci where both have a call and the calls differ.
function alleleDistance(a, b) {
  let diff = 0, compared = 0;
  for (const locus in a) {
    if (!(locus in b) || a[locus] == null || b[locus] == null) continue;
    compared++; if (a[locus] !== b[locus]) diff++;
  }
  return { diff, compared };
}

function interpretBacterial(r, ctx) {
  const d = r.data || {}, flags = [], amr = (d.amr || []).filter(h => (h.type || "AMR") === "AMR");
  const confirmed = amr.filter(hitConfirmed), partial = amr.filter(h => !hitConfirmed(h));
  partial.forEach(h => flags.push({ level: "discuss", text: `<b>Partial match for ${esc(h.gene)}</b> (${h.identity}% identity, ${h.coverage}% coverage; minimum ${TH.minIdentity}% and ${TH.minGeneCoverage}%). The gene may be broken or a relative; check the culture result.` }));
  const esbl = confirmed.filter(h => /bla(ctx-m|cmy|dha)/i.test(h.gene));
  if (esbl.length) flags.push({ level: "alert", text: `<b>ESBL/AmpC gene:</b> ${esbl.map(h => esc(h.gene)).join(", ")}. Expect resistance to 3rd-generation cephalosporins.` });
  const carb = confirmed.filter(h => /bla(kpc|ndm|vim|imp|oxa-48)/i.test(h.gene));
  if (carb.length) flags.push({ level: "alert", text: `<b>Carbapenemase gene:</b> ${carb.map(h => esc(h.gene)).join(", ")}. Notify infection prevention right away.` });
  if (d.species === "Escherichia coli" && String(d.st) === "131") flags.push({ level: "info", text: "<b>ST131:</b> a globally spread E. coli lineage that is often multidrug resistant." });

  // Genotype-phenotype check against the same patient's culture of the same species.
  const culture = (ctx.byPatient[r.patientId] || []).filter(x => x.kind === "culture" && x.data && x.data.organism === d.species)
    .sort((a, b) => Math.abs(daysBetween(a.collected, r.collected)) - Math.abs(daysBetween(b.collected, r.collected)))[0];
  if (culture) {
    const ast = culture.data.ast || [];
    const predicted = new Map();
    confirmed.forEach(h => geneCategories(h).forEach(c => predicted.set(c, [...(predicted.get(c) || []), h.gene])));
    predicted.forEach((genes, cat) => {
      const tested = ast.filter(a => DRUGS[a.drug] === cat);
      if (tested.length && tested.every(a => a.interp === "S"))
        flags.push({ level: "discuss", text: `<b>Genome and culture disagree:</b> ${genes.map(esc).join(", ")} predicts resistance to ${esc(cat)}, but the culture says susceptible (${tested.map(a => esc(a.drug)).join(", ")}). Check before choosing treatment.` });
    });
    const unexplained = [...new Set(ast.filter(a => a.interp !== "S" && !predicted.has(DRUGS[a.drug])).map(a => DRUGS[a.drug]).filter(Boolean))];
    if (unexplained.length) flags.push({ level: "info", text: `Resistance to ${unexplained.map(esc).join("; ")} is not explained by a known gene (another mechanism, or a gene missing from the database).` });
    if (predicted.size && !flags.some(x => x.text.includes("disagree"))) flags.push({ level: "info", text: "Genome and culture agree on every drug category the genes predict." });
  }

  // Outbreak check: closest other isolate of the same species.
  let closest = null;
  if (d.profile) ctx.genomes.filter(g => g.id !== r.id && g.data.species === d.species).forEach(g => {
    const dist = alleleDistance(d.profile, g.data.profile);
    if (dist.compared && (!closest || dist.diff < closest.diff)) closest = { ...dist, other: g };
  });
  if (closest && closest.diff <= TH.clusterAlleles) {
    const op = ctx.patientOf(closest.other.patientId);
    flags.push({ level: "alert", text: `<b>Likely same strain as ${esc(closest.other.patientCode)}'s isolate</b> (${closest.diff} of ${closest.compared} loci differ; cutoff ${TH.clusterAlleles})${op ? ", " + esc(placeName(op.residence)) : ""}. Possible outbreak: look for a shared source.` });
  } else if (closest) flags.push({ level: "info", text: `Nearest other ${esc(d.species)} isolate differs at ${closest.diff} of ${closest.compared} loci: not the same outbreak strain.` });

  const org = ORGS[d.species] || {};
  return { finding: `${org.short || d.species || "Bacterium"}${d.st ? " ST" + d.st : ""}${confirmed.length ? " · " + plural(confirmed.length, "resistance gene") : ""}`,
    level: "positive", syndrome: org.syndrome || null, category: "bacterial", pathogens: [d.species], flags, cluster: closest && closest.diff <= TH.clusterAlleles,
    plain: [`The lab read the genetic code of the ${org.short || "bacteria"} from your sample.`,
      confirmed.length ? `It carries ${plural(confirmed.length, "gene")} that can make some antibiotics work less well. Your clinician has used this to choose your treatment.` : "It carries no known antibiotic-resistance genes.",
      closest && closest.diff <= TH.clusterAlleles ? "It closely matches bacteria from another case, so public health may ask about places you ate or visited." : ""] };
}

// Groups of isolates linked by <= cutoff allele differences (single linkage), per species.
function genomeClusters(genomes) {
  const out = [];
  const bySpecies = {};
  genomes.forEach(g => (bySpecies[g.data.species] = bySpecies[g.data.species] || []).push(g));
  Object.entries(bySpecies).forEach(([species, list]) => {
    const parent = list.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const d = alleleDistance(list[i].data.profile, list[j].data.profile);
      if (d.compared && d.diff <= TH.clusterAlleles) parent[find(i)] = find(j);
    }
    const groups = {};
    list.forEach((g, i) => (groups[find(i)] = groups[find(i)] || []).push(g));
    Object.values(groups).filter(g => g.length > 1).forEach(members => out.push({ species, members }));
  });
  return out;
}

// What a result looks like on a worklist: status + whether it needs discussion.
function statusOf(r, it) {
  if (r.status === "signed") return { key: "signed", label: "Signed", cls: "ok-p" };
  if (it.needsDiscussion) return { key: "discuss", label: "Needs discussion", cls: "watch-p" };
  return { key: "ready", label: "Ready to sign", cls: "plain-p" };
}

// De-identified copy for researchers: no name, code, email, exact date or residence.
function deidentify(r, p, it) {
  const d = r.data || {};
  const nonS = r.kind === "culture" ? [...new Set((d.ast || []).filter(a => a.interp !== "S").map(a => DRUGS[a.drug]).filter(Boolean))] : [];
  return {
    kind: r.kind, week: mmwrWeek(r.collected), ageBand: ageBand(ageOf(p)), campus: placeCampus(p && p.residence) || "unknown",
    specimen: r.specimen || "", syndrome: it.syndrome || "", category: it.category || "", positive: it.level !== "negative",
    pathogens: it.pathogens || [], organism: d.organism || d.species || "", st: d.st || "",
    nonSusceptible: nonS, mdr: nonS.length >= TH.mdrCategories,
    genes: (d.amr || []).filter(hitConfirmed).map(h => h.gene), lineage: d.lineage || "", coverage: d.coverage ?? null,
    profile: r.kind === "bacterial_genome" ? (d.profile || null) : null,
    demo: !!r.demo, signedWeek: mmwrWeek(todayStr()),
  };
}

/* =====================================================================
   4. FILE READERS
   Pipelines run elsewhere; the portal reads their standard output files.
   Every reader returns { items, errors } so the import screen can show a
   preview and every problem BEFORE anything is saved.
   ===================================================================== */

// CSV with quoted fields. Returns rows as objects keyed by lower-case header.
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter(r => r.some(c => c.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map(h => h.trim().toLowerCase());
  return clean.slice(1).map((r, i) => Object.assign(Object.fromEntries(head.map((h, j) => [h, (r[j] ?? "").trim()])), { _line: i + 2 }));
}
// Tab-separated output from command-line tools (no quoting).
function parseTsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim() !== "" && !l.startsWith("##"));
  if (!lines.length) return { head: [], rows: [] };
  const head = lines[0].split("\t").map(h => h.trim());
  return { head, rows: lines.slice(1).map(l => l.split("\t")) };
}
const colIndex = (head, ...names) => {
  const low = head.map(h => h.toLowerCase());
  for (const n of names) { const i = low.indexOf(n.toLowerCase()); if (i >= 0) return i; }
  return -1;
};
const findPatient = code => state.patients.find(p => p.code.toLowerCase() === String(code || "").trim().toLowerCase());
const targetId = s => { const v = String(s || "").trim().toLowerCase(); return TARGETS[v] ? v : Object.keys(TARGETS).find(k => TARGETS[k].name.toLowerCase() === v) || null; };

// PCR panel CSV: one row per target. Rows with the same patient, date and panel become one result.
function readPcrCsv(text) {
  const items = new Map(), errors = [];
  parseCsv(text).forEach(r => {
    const p = findPatient(r.patient_code), t = targetId(r.target), res = (r.result || "").toLowerCase();
    const panel = /^(gi|gastro)/i.test(r.panel) ? "gi" : /^resp/i.test(r.panel) ? "respiratory" : null;
    const ct = r.ct === "" || r.ct == null ? null : Number(r.ct);
    const problem = !p ? `unknown patient_code "${r.patient_code}" (add the patient first)` : !DATE_RE.test(r.collected_date || "") ? "collected_date must be YYYY-MM-DD"
      : !panel ? 'panel must be "respiratory" or "gi"' : !t ? `unknown target "${r.target}"`
      : !/^(detected|not detected|not_detected|positive|negative)$/.test(res) ? 'result must be "detected" or "not detected"'
      : ct !== null && !(ct > 0 && ct < 50) ? "ct must be a number between 0 and 50, or blank" : null;
    if (problem) return errors.push(`Line ${r._line}: ${problem}.`);
    const key = p.id + "|" + r.collected_date + "|" + panel;
    if (!items.has(key)) items.set(key, newResult(p, "pcr", r.collected_date, r.specimen || (panel === "gi" ? "stool" : "nasopharyngeal swab"), { panel, targets: [] }, "csv", "PCR panel CSV"));
    items.get(key).data.targets.push({ id: t, result: /^(detected|positive)$/.test(res) ? "detected" : "not_detected", ct: /^(detected|positive)$/.test(res) ? ct : null });
  });
  return { items: [...items.values()], errors };
}

// Culture + susceptibility CSV: one row per antibiotic.
function readCultureCsv(text) {
  const items = new Map(), errors = [];
  parseCsv(text).forEach(r => {
    const p = findPatient(r.patient_code), drug = (r.antibiotic || "").trim().toLowerCase(), interp = (r.interpretation || "").trim().toUpperCase();
    const problem = !p ? `unknown patient_code "${r.patient_code}"` : !DATE_RE.test(r.collected_date || "") ? "collected_date must be YYYY-MM-DD"
      : !r.organism ? "organism is missing" : drug && !DRUGS[drug] ? `unknown antibiotic "${r.antibiotic}" (add it to LAB_DRUGS in lab-config.js)`
      : drug && !["S", "I", "R"].includes(interp) ? "interpretation must be S, I or R (as reported by the lab)" : null;
    if (problem) return errors.push(`Line ${r._line}: ${problem}.`);
    const key = p.id + "|" + r.collected_date + "|" + r.organism;
    if (!items.has(key)) items.set(key, newResult(p, "culture", r.collected_date, r.specimen || "", { organism: r.organism.trim(), ast: [] }, "csv", "Culture CSV"));
    if (drug) items.get(key).data.ast.push({ drug, mic: r.mic || "", interp });
    if (!ORGS[r.organism.trim()] && !errors.some(e => e.includes(r.organism))) errors.push(`Note: "${r.organism}" is not in LAB_ORGANISMS, so it has no syndrome (it will still be saved).`);
  });
  return { items: [...items.values()], errors: errors };
}

// Nextclade TSV (nextclade run --output-tsv). One row per sequence.
function readNextclade(text) {
  const { head, rows } = parseTsv(text), errors = [];
  const ix = n => colIndex(head, ...n);
  const c = { seq: ix(["seqName"]), clade: ix(["clade"]), pango: ix(["Nextclade_pango", "lineage"]), qc: ix(["qc.overallStatus"]),
    cov: ix(["coverage"]), subs: ix(["totalSubstitutions"]), miss: ix(["totalMissing"]), fs: ix(["totalFrameShifts"]),
    aa: ix(["aaSubstitutions"]), err: ix(["errors"]) };
  if (c.seq < 0) return { items: [], errors: ["This doesn't look like a Nextclade TSV (no seqName column). Use nextclade's --output-tsv file."] };
  const items = rows.map(r => {
    const num = i => i >= 0 && r[i] !== "" ? Number(r[i]) : null;
    let cov = num(c.cov); if (cov != null && cov <= 1) cov = Math.round(cov * 1000) / 10;   // Nextclade reports coverage as a fraction
    return { seqName: r[c.seq], error: c.err >= 0 ? r[c.err] : "", data: {
      lineage: c.pango >= 0 ? r[c.pango] : "", clade: c.clade >= 0 ? r[c.clade] : "", coverage: cov, qcStatus: c.qc >= 0 ? r[c.qc] : "",
      substitutions: num(c.subs), missing: num(c.miss), frameShifts: num(c.fs) || 0,
      aaSubstitutions: c.aa >= 0 && r[c.aa] ? r[c.aa].split(",").slice(0, 60) : [] } };
  });
  items.filter(x => x.error).forEach(x => errors.push(`${x.seqName}: Nextclade reported an error (${x.error}).`));
  return { items: items.filter(x => !x.error), errors };
}

// AMRFinderPlus TSV. Column names changed in version 4 ("Gene symbol" -> "Element symbol"), so both are accepted.
function readAmrFinder(text) {
  const { head, rows } = parseTsv(text);
  const g = colIndex(head, "Gene symbol", "Element symbol"), cls = colIndex(head, "Class"), sub = colIndex(head, "Subclass");
  const type = colIndex(head, "Element type", "Type");
  const id = head.findIndex(h => /identity/i.test(h)), cov = head.findIndex(h => /coverage of reference/i.test(h));
  if (g < 0 || cls < 0) return { items: [], errors: ["This doesn't look like AMRFinderPlus output (no Gene symbol / Element symbol and Class columns)."] };
  return { items: rows.map(r => ({ gene: r[g], cls: r[cls] || "", subclass: sub >= 0 ? r[sub] : "", type: type >= 0 ? r[type] : "AMR",
    identity: id >= 0 ? Number(r[id]) : null, coverage: cov >= 0 ? Number(r[cov]) : null })).filter(h => h.gene), errors: [] };
}

// mlst output: FILE  SCHEME  ST  allele(n) ...  ("-" means a new sequence type)
function readMlst(text) {
  const line = text.split(/\r?\n/).find(l => l.trim() && !/^FILE\t/i.test(l));
  if (!line) return { scheme: "", st: "", errors: ["The mlst file is empty."] };
  const parts = line.split("\t");
  if (parts.length < 3) return { scheme: "", st: "", errors: ["mlst output should be tab-separated: FILE, SCHEME, ST, alleles."] };
  return { scheme: parts[1], st: parts[2] === "-" ? "novel" : parts[2], errors: [] };
}

// chewBBACA AlleleCall results_alleles.tsv: FILE + one column per locus. Calls like INF-12 count as 12;
// LNF, PLOT, NIPH, ASM, ALM and similar mean "no call" and are skipped.
function readChewbbaca(text) {
  const { head, rows } = parseTsv(text);
  if (!rows.length || !/file/i.test(head[0])) return { profile: null, errors: ["chewBBACA results_alleles.tsv should start with a FILE column."] };
  const r = rows[0], profile = {};
  head.slice(1).forEach((locus, i) => { const v = String(r[i + 1] || "").replace(/^INF-/, ""); if (/^\d+$/.test(v)) profile[locus.replace(/\.fasta$/, "")] = Number(v); });
  return { profile, isolate: r[0], loci: head.length - 1, errors: Object.keys(profile).length < (head.length - 1) * 0.9
    ? [`Only ${Object.keys(profile).length} of ${head.length - 1} loci have a call; distances will use the loci both isolates share.`] : [] };
}

function newResult(p, kind, collected, specimen, data, source, tool, file) {
  const now = new Date().toISOString(), by = currentUserName();
  return { id: (state.mode === "demo" ? "demo-r" : "r-") + uid(), patientId: p.id, patientCode: p.code, ownerEmail: p.ownerEmail || "",
    kind, collected, specimen, status: "analyzed", data, provenance: { source, tool: tool || "", file: file || "", importedBy: by, importedAt: now },
    note: "", signedBy: "", signedAt: "", demo: state.mode === "demo" || !!p.demo, history: [{ at: now, by, action: "imported" }] };
}

/* =====================================================================
   5. CLINICIAN VIEWS
   ===================================================================== */
const it = r => state.its.get(r.id);
const byNewest = (a, b) => b.collected.localeCompare(a.collected) || String(b.provenance?.importedAt).localeCompare(String(a.provenance?.importedAt));

function showCtab(name) {
  state.ctab = name;
  ["worklist", "patients", "patient", "import", "outbreaks"].forEach(t => { $("ctab-" + t).hidden = t !== name; });
  document.querySelectorAll("[data-ctab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.ctab === (name === "patient" ? "patients" : name))));
  render();      // re-interprets everything, then draws this tab
}

function renderClinician() {
  const discuss = state.results.filter(r => r.status !== "signed" && it(r).needsDiscussion).length;
  $("badgeDiscuss").hidden = !discuss; $("badgeDiscuss").textContent = discuss;
  ({ worklist: renderWorklist, patients: renderPatients, patient: renderPatientRecord, import: renderImport, outbreaks: renderOutbreaks })[state.ctab]();
}

// --- Worklist: every result and where it is in the review process (KDI's "Bioinfo-Board") ---
function renderWorklist() {
  const week = addDays(todayStr(), -6);
  const st = r => statusOf(r, it(r)).key;
  const counts = { discuss: 0, ready: 0, signed: 0 };
  state.results.forEach(r => counts[st(r)]++);
  const posWeek = state.results.filter(r => r.collected >= week && it(r).level !== "negative").length;
  const filters = { open: r => st(r) !== "signed", discuss: r => st(r) === "discuss", ready: r => st(r) === "ready", signed: r => st(r) === "signed", all: () => true };
  const rows = state.results.filter(filters[state.worklistFilter]).sort(byNewest);
  const fbtn = (k, label) => `<button type="button" data-wl="${k}" aria-pressed="${state.worklistFilter === k}">${label}</button>`;
  $("ctab-worklist").innerHTML = `
    <div class="kpis">
      ${kpi("Needs discussion", counts.discuss, "flagged by the rules")}
      ${kpi("Ready to sign", counts.ready, "no flags")}
      ${kpi("Signed", counts.signed, "visible to patients")}
      ${kpi("Positive, last 7 days", posWeek, "by collection date")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Worklist</h3>
        <span class="seg" role="group" aria-label="Filter">${fbtn("open", "To review")}${fbtn("discuss", "Needs discussion")}${fbtn("ready", "Ready")}${fbtn("signed", "Signed")}${fbtn("all", "All")}</span></div>
      ${rows.length ? `<div class="table-box"><table><thead><tr><th>Collected</th><th>Patient</th><th>Test</th><th>Finding</th><th>Status</th></tr></thead><tbody>${
        rows.map(r => { const i = it(r), s = statusOf(r, i); return `<tr class="clickable" data-open="${esc(r.id)}" tabindex="0">
          <td class="mono">${esc(r.collected)}</td><td><b>${esc(r.patientCode)}</b></td><td>${esc(KIND_NAMES[r.kind])}</td>
          <td>${esc(i.finding)}${i.flags.some(f => f.level === "alert") ? ' <span class="pill alert-p">alert</span>' : ""}</td>
          <td><span class="pill ${s.cls}">${s.label}</span></td></tr>`; }).join("")}</tbody></table></div>`
        : `<div class="quiet">Nothing here. ${state.worklistFilter === "open" ? "Every result has been signed." : ""}</div>`}
      <p class="hint">Results that break a rule (late PCR detection, low genome coverage, partial gene match, genome and culture disagreeing...) wait in "Needs discussion". Signing one needs a note explaining the decision.</p>
    </div>`;
}
function kpi(label, num, sub) { return `<div class="kpi"><span class="eyebrow">${label}</span><span class="num">${num}</span><span class="muted" style="font-size:0.8rem">${sub}</span></div>`; }

function openResult(id) {
  const r = state.results.find(x => x.id === id); if (!r) return;
  state.patientId = r.patientId; showCtab("patient");
  setTimeout(() => { const el = $("res-" + id); if (el) { el.scrollIntoView({ block: "start", behavior: "smooth" }); el.focus(); } }, 30);
}

// --- Patients ---
function renderPatients() {
  const list = state.patients.slice().sort((a, b) => a.code.localeCompare(b.code));
  const count = id => state.results.filter(r => r.patientId === id).length;
  const open = id => state.results.filter(r => r.patientId === id && r.status !== "signed").length;
  $("ctab-patients").innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>Patients</h3><span class="eyebrow">${plural(list.length, "patient")}</span></div>
      ${list.length ? `<div class="table-box"><table><thead><tr><th>Code</th><th>Name</th><th>Age</th><th>Residence</th><th style="text-align:center">Results</th><th style="text-align:center">To review</th><th>Patient login</th></tr></thead><tbody>${
        list.map(p => `<tr class="clickable" data-patient="${esc(p.id)}" tabindex="0"><td><b>${esc(p.code)}</b></td><td>${esc(p.name)}</td><td>${ageOf(p) ?? ""}</td>
          <td>${esc(placeName(p.residence))}</td><td class="n">${count(p.id)}</td><td class="n">${open(p.id) || "—"}</td>
          <td class="muted">${p.ownerEmail ? esc(p.ownerEmail) : "not linked"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No patients yet.</p>`}
    </div>
    <div class="panel">
      <h3>Add a patient</h3>
      <div class="grid2">
        <label class="field">Name <input type="text" id="npName" maxlength="60" placeholder="First name and initial"></label>
        <label class="field">Birth year <input type="number" id="npYear" min="1930" max="${new Date().getFullYear()}" placeholder="2006"></label>
        <label class="field">Residence <select id="npRes">${Object.entries(PLACES).map(([id, v]) => `<option value="${id}">${esc(v[0])}</option>`).join("")}</select></label>
        <label class="field">Patient's sign-in email (optional) <input type="email" id="npEmail" placeholder="name@asu.edu"></label>
      </div>
      <div class="row"><button class="btn small" id="npAdd">Add patient</button><span id="npMsg" class="hint"></span></div>
      ${state.mode === "live" ? `<p class="hint">Use made-up patients only: this class project is not approved for real health information.</p>` : ""}
    </div>
    ${state.mode === "live" ? `<div class="panel"><h3>Demo data</h3><p class="hint">Add the 21 synthetic patients to the database (so a classmate can sign in as one), or remove them afterwards.</p>
      <div class="row"><button class="btn small ghost" id="demoLoad">Add demo patients</button><button class="btn small ghost" id="demoRemove">Remove demo data</button><span class="hint" id="demoMsg"></span></div></div>` : ""}`;
}

async function addPatient() {
  const name = $("npName").value.trim(), year = Number($("npYear").value), email = $("npEmail").value.trim().toLowerCase();
  const msg = $("npMsg");
  if (!name) return (msg.textContent = "Enter a name.");
  if (!(year > 1930 && year <= new Date().getFullYear())) return (msg.textContent = "Enter a birth year.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return (msg.textContent = "That email doesn't look right.");
  const next = 1000 + 1 + Math.max(0, ...state.patients.map(p => Number(p.code.slice(2)) - 1000).filter(Number.isFinite));
  const p = { id: (state.mode === "demo" ? "demo-p" : "p-") + uid(), code: "P-" + next, name, birthYear: year, residence: $("npRes").value,
    ownerEmail: email, demo: state.mode === "demo", createdAt: new Date().toISOString(), createdBy: currentUserName() };
  try { await store.addPatient(p); msg.textContent = `Added ${p.code}.`; }
  catch (e) { msg.textContent = dbError(e); }
}

// --- One patient's record: the technical report on screen (paper Figure 5) ---
function renderPatientRecord() {
  const p = state.patients.find(x => x.id === state.patientId);
  if (!p) { $("ctab-patient").innerHTML = `<p class="muted">Patient not found.</p>`; return; }
  const rs = state.results.filter(r => r.patientId === p.id).sort(byNewest);
  const discuss = rs.filter(r => r.status !== "signed" && it(r).needsDiscussion);
  $("ctab-patient").innerHTML = `
    <div class="row"><button class="btn small ghost" data-back>&larr; All patients</button></div>
    <div class="panel">
      <div class="panel-head"><h2>${esc(p.code)} · ${esc(p.name)}</h2>
        <div class="row"><button class="btn small" data-print="clinician">Print technical report</button><button class="btn small ghost" data-print="patient">Print patient summary</button></div></div>
      <div class="patient-head">
        <div><span class="eyebrow">Age</span>${ageOf(p) ?? "—"}</div>
        <div><span class="eyebrow">Residence</span>${esc(placeName(p.residence))}</div>
        <div><span class="eyebrow">Campus</span>${esc(CAMPUSES[placeCampus(p.residence)] || "—")}</div>
        <div><span class="eyebrow">Results</span>${rs.length} (${rs.filter(r => r.status === "signed").length} signed)</div>
      </div>
      <div class="row">
        <label class="field" style="flex:1;min-width:220px">Patient's sign-in email <input type="email" id="ownerEmail" value="${esc(p.ownerEmail || "")}" placeholder="name@asu.edu"></label>
        <button class="btn small ghost" id="saveOwner" style="align-self:end">Save</button><span class="hint" id="ownerMsg" style="align-self:end"></span>
      </div>
      <p class="hint">The patient sees their signed results after signing in with this Google account.</p>
    </div>
    <div class="panel">
      <h3>Summary</h3>
      ${rs.length ? `<div class="table-box"><table><thead><tr><th>Collected</th><th>Test</th><th>Finding</th><th>Syndrome</th><th>Type</th><th>Status</th></tr></thead><tbody>${
        rs.map(r => { const i = it(r), s = statusOf(r, i); return `<tr class="clickable" data-jump="${esc(r.id)}"><td class="mono">${esc(r.collected)}</td><td>${esc(KIND_NAMES[r.kind])}</td>
          <td>${esc(i.finding)}</td><td>${synTag(i.syndrome) || "—"}</td><td>${i.level === "negative" ? "—" : catName(i.category)}</td><td><span class="pill ${s.cls}">${s.label}</span></td></tr>`; }).join("")}</tbody></table></div>` : `<p class="muted">No results yet. Use Import results.</p>`}
      ${discuss.length ? `<div class="flags"><li class="discuss"><b>${plural(discuss.length, "result needs", "results need")} discussion</b> before signing: ${discuss.map(r => esc(KIND_NAMES[r.kind]) + " (" + esc(r.collected) + ")").join(", ")}.</li></div>` : ""}
    </div>
    ${rs.map(resultCard).join("")}`;
}

function resultCard(r) {
  const i = it(r), s = statusOf(r, i), d = r.data || {};
  let body = "";
  if (r.kind === "pcr") {
    const det = (d.targets || []).filter(t => t.result === "detected");
    body = `<div class="chipline">${det.length ? det.map(t => `<span class="chip${t.ct > TH.lateCt ? " warn" : ""}">${esc((TARGETS[t.id] || { name: t.id }).name)} · Ct ${t.ct ?? "—"}</span>`).join("") : '<span class="chip">No targets detected</span>'}</div>
      <details><summary class="hint">All ${(d.targets || []).length} targets tested (${d.panel === "gi" ? "GI" : "respiratory"} panel)</summary>
      <p class="hint">${(d.targets || []).map(t => esc((TARGETS[t.id] || { name: t.id }).name) + ": " + (t.result === "detected" ? "detected" : "not detected")).join(" · ")}</p></details>`;
  } else if (r.kind === "culture") {
    body = `<p><b>${esc(d.organism)}</b></p>${(d.ast || []).length ? `<div class="ast">${d.ast.map(a => `<span><span>${esc(a.drug)} <span class="muted mono">${esc(a.mic)}</span></span><span class="sir ${esc(a.interp)}">${esc(a.interp)}</span></span>`).join("")}</div>` : ""}`;
  } else if (r.kind === "viral_genome") {
    body = `<div class="meta"><span>Virus: ${esc(d.virus)}</span><span>Lineage: <b>${esc(d.lineage || "—")}</b></span>${d.clade ? `<span>Clade: ${esc(d.clade)}</span>` : ""}
      <span>Coverage: ${d.coverage ?? "—"}%</span><span>QC: ${esc(d.qcStatus || "—")}</span><span>Substitutions: ${d.substitutions ?? "—"}</span><span>Missing bases: ${d.missing ?? "—"}</span></div>
      ${(d.aaSubstitutions || []).length ? `<div class="chipline">${d.aaSubstitutions.slice(0, 16).map(m => `<span class="chip">${esc(m)}</span>`).join("")}${d.aaSubstitutions.length > 16 ? `<span class="chip">+${d.aaSubstitutions.length - 16} more</span>` : ""}</div>` : ""}`;
  } else if (r.kind === "bacterial_genome") {
    const amr = (d.amr || []);
    body = `<div class="meta"><span>Species: <i>${esc(d.species)}</i></span><span>MLST: ${d.st ? "ST" + esc(d.st) : "—"} ${d.scheme ? "(" + esc(d.scheme) + ")" : ""}</span>
      <span>cgMLST loci called: ${d.profile ? Object.keys(d.profile).length : 0}</span>${d.isolate ? `<span>Isolate: ${esc(d.isolate)}</span>` : ""}</div>
      ${amr.length ? `<div class="table-box"><table><thead><tr><th>Gene</th><th>Class</th><th>Identity</th><th>Coverage</th><th>Call</th></tr></thead><tbody>${
        amr.map(h => `<tr><td class="mono">${esc(h.gene)}</td><td>${esc(h.cls)}</td><td class="n">${h.identity ?? "—"}%</td><td class="n">${h.coverage ?? "—"}%</td>
          <td>${hitConfirmed(h) ? '<span class="pill ok-p">confirmed</span>' : '<span class="pill watch-p">partial</span>'}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No resistance genes found.</p>`}`;
  }
  const flags = i.flags.length ? `<ul class="flags">${i.flags.map(f => `<li class="${f.level}">${f.text}</li>`).join("")}</ul>` : "";
  const pv = r.provenance || {};
  const sign = r.status === "signed"
    ? `<p class="hint">Signed by ${esc(r.signedBy)} · ${fmtTime(r.signedAt)}${r.note ? ` · Note: ${esc(r.note)}` : ""}</p>`
    : `<label class="field">Clinician note ${i.needsDiscussion ? "(required: explain your decision. The patient sees this note.)" : "(optional; the patient sees this note)"}
         <textarea id="note-${esc(r.id)}" maxlength="600" style="min-height:4em;font-family:var(--f-body)">${esc(r.note)}</textarea></label>
       <div class="row"><button class="btn small" data-sign="${esc(r.id)}">Sign result</button><span class="hint" id="signMsg-${esc(r.id)}"></span></div>`;
  return `<article class="result ${i.level}" id="res-${esc(r.id)}" tabindex="-1">
    <div class="result-top"><div><span class="eyebrow">${esc(KIND_NAMES[r.kind])} · ${esc(r.specimen || "")} · collected ${esc(r.collected)}</span><h3>${esc(i.finding)}</h3></div>
      <span class="pill ${s.cls}">${s.label}</span></div>
    ${body}${flags}
    <div class="meta"><span>Source: ${esc(pv.tool || pv.source || "—")}${pv.file ? " (" + esc(pv.file) + ")" : ""}</span><span>Imported by ${esc(pv.importedBy || "—")} · ${fmtTime(pv.importedAt)}</span></div>
    ${sign}
  </article>`;
}

async function signResult(id) {
  const r = state.results.find(x => x.id === id), i = it(r), note = ($("note-" + id).value || "").trim(), msg = $("signMsg-" + id);
  if (i.needsDiscussion && !note) { msg.className = "err"; msg.textContent = "Add a note explaining your decision before signing a result that needs discussion."; return; }
  const now = new Date().toISOString(), by = currentUserName();
  const deidId = r.deidId || "d-" + uid();
  try {
    await store.updateResult(id, { status: "signed", signedBy: by, signedAt: now, note, deidId,
      history: [...(r.history || []), { at: now, by, action: i.needsDiscussion ? "signed after discussion" : "signed" }] });
    const p = state.patients.find(x => x.id === r.patientId);
    await store.saveDeid(deidId, deidentify({ ...r, status: "signed" }, p, i));
  } catch (e) { msg.className = "err"; msg.textContent = dbError(e); }
}

// --- Import results ---
const IMPORT_KINDS = {
  pcr: { label: "PCR panel (CSV)", template: "patient_code,collected_date,specimen,panel,target,result,ct\nP-1003,2026-11-12,stool,gi,noro_gii,detected,26.2\nP-1003,2026-11-12,stool,gi,salmonella,not detected," },
  culture: { label: "Culture + susceptibility (CSV)", template: "patient_code,collected_date,specimen,organism,antibiotic,mic,interpretation\nP-1016,2026-11-12,throat swab,Streptococcus pyogenes,penicillin,<=0.03,S\nP-1016,2026-11-12,throat swab,Streptococcus pyogenes,erythromycin,>2,R" },
  viral_genome: { label: "Viral genome (Nextclade TSV)" },
  bacterial_genome: { label: "Bacterial genome (AMRFinderPlus + mlst + chewBBACA)" },
};
let importDraft = null;

function renderImport() {
  const k = state.importKind || "pcr";
  const patientOptions = state.patients.slice().sort((a, b) => a.code.localeCompare(b.code)).map(p => `<option value="${esc(p.id)}">${esc(p.code)} · ${esc(p.name)}</option>`).join("");
  const sample = `<div class="grid2">
      <label class="field">Patient <select id="imPatient">${patientOptions}</select></label>
      <label class="field">Collected <input type="date" id="imDate" value="${todayStr()}" max="${todayStr()}"></label>
      <label class="field">Specimen <input type="text" id="imSpecimen" value="${k === "bacterial_genome" ? "isolate" : "nasopharyngeal swab"}"></label>
      ${k === "viral_genome" ? `<label class="field">Virus <select id="imVirus"><option>SARS-CoV-2</option><option>Influenza A (H3N2)</option><option>Influenza A (H1N1pdm)</option><option>Influenza B</option></select></label>`
        : `<label class="field">Species <select id="imSpecies">${Object.keys(ORGS).map(o => `<option>${esc(o)}</option>`).join("")}</select></label>`}
    </div>`;
  const body = {
    pcr: () => csvBox("pcr"),
    culture: () => csvBox("culture"),
    viral_genome: () => `${sample}${fileBox("imNextclade", "Nextclade TSV", ".tsv,.txt", "nextclade run --output-tsv nextclade.tsv. One file can hold many sequences; pick which one below.")}
      <label class="field" id="seqPickWrap" hidden>Sequence <select id="seqPick"></select></label>`,
    bacterial_genome: () => `${sample}
      ${fileBox("imAmr", "AMRFinderPlus output (required)", ".tsv,.txt", "amrfinder -n assembly.fasta --organism ... > amrfinder.tsv")}
      ${fileBox("imMlst", "mlst output (optional)", ".tsv,.txt", "mlst assembly.fasta > mlst.tsv")}
      ${fileBox("imChew", "chewBBACA allele calls (optional, for outbreak clusters)", ".tsv,.txt", "chewBBACA.py AlleleCall ... produces results_alleles.tsv")}`,
  }[k]();
  $("ctab-import").innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>Import results</h3><span class="eyebrow">Pipelines run elsewhere; the portal checks, interprets and reports</span></div>
      <div class="seg" role="group" aria-label="Result type">${Object.entries(IMPORT_KINDS).map(([id, v]) => `<button type="button" data-imkind="${id}" aria-pressed="${id === k}">${v.label}</button>`).join("")}</div>
      ${state.patients.length ? body : `<p class="muted">Add a patient first (Patients tab).</p>`}
      <div class="row"><button class="btn small" id="imPreview">Check file</button><span class="hint">Nothing is saved until you confirm.</span></div>
    </div>
    <div id="imResult"></div>`;
  importDraft = null;
}
function csvBox(kind) {
  return `<p class="hint">Paste the lab's export or choose a file. One row per ${kind === "pcr" ? "target" : "antibiotic"}; rows for the same patient and date become one result. Target ids: <span class="mono">${kind === "pcr" ? Object.keys(TARGETS).join(", ") : Object.keys(DRUGS).join(", ")}</span>.</p>
    <textarea id="imCsv" spellcheck="false" placeholder="${esc(IMPORT_KINDS[kind].template)}"></textarea>
    <div class="row"><input type="file" id="imCsvFile" accept=".csv,text/csv"><button type="button" class="btn small ghost" id="imTemplate">Fill in an example</button></div>`;
}
function fileBox(id, label, accept, hint) {
  return `<label class="field">${label}<input type="file" id="${id}" accept="${accept}"></label><p class="hint mono" style="margin-top:-6px">${esc(hint)}</p>`;
}
const readFile = input => input && input.files && input.files[0] ? input.files[0].text().then(t => ({ text: t, name: input.files[0].name })) : Promise.resolve(null);

async function previewImport() {
  const k = state.importKind || "pcr", out = $("imResult");
  let items = [], errors = [];
  try {
    if (k === "pcr" || k === "culture") {
      const f = await readFile($("imCsvFile")); const text = f ? f.text : $("imCsv").value;
      ({ items, errors } = (k === "pcr" ? readPcrCsv : readCultureCsv)(text));
      if (f) items.forEach(r => { r.provenance.file = f.name; });
    } else {
      const p = state.patients.find(x => x.id === $("imPatient").value), date = $("imDate").value, spec = $("imSpecimen").value.trim();
      if (!p || !DATE_RE.test(date)) errors.push("Choose a patient and a collection date.");
      else if (k === "viral_genome") {
        const f = await readFile($("imNextclade"));
        if (!f) errors.push("Choose the Nextclade TSV file.");
        else {
          const nc = readNextclade(f.text); errors.push(...nc.errors);
          const pickWrap = $("seqPickWrap"), pick = $("seqPick");
          if (nc.items.length > 1 && pickWrap.hidden) {
            pick.innerHTML = nc.items.map((x, i) => `<option value="${i}">${esc(x.seqName)}</option>`).join(""); pickWrap.hidden = false;
            errors.push(`The file has ${nc.items.length} sequences: choose which one belongs to this patient, then check again.`);
          } else if (nc.items.length) {
            const x = nc.items[nc.items.length > 1 ? Number(pick.value) : 0];
            items = [newResult(p, "viral_genome", date, spec, { virus: $("imVirus").value, ...x.data, sequence: x.seqName }, "nextclade", "Nextclade", f.name)];
          }
        }
      } else {
        const [amr, mlst, chew] = await Promise.all([readFile($("imAmr")), readFile($("imMlst")), readFile($("imChew"))]);
        if (!amr) errors.push("Choose the AMRFinderPlus file.");
        else {
          const a = readAmrFinder(amr.text); errors.push(...a.errors);
          const m = mlst ? readMlst(mlst.text) : { scheme: "", st: "", errors: [] }; errors.push(...m.errors);
          const c = chew ? readChewbbaca(chew.text) : { profile: null, errors: [] }; errors.push(...c.errors);
          if (!a.errors.length) items = [newResult(p, "bacterial_genome", date, spec, { species: $("imSpecies").value, scheme: m.scheme, st: m.st,
            amr: a.items, profile: c.profile, isolate: c.isolate || "" }, "pipeline", ["AMRFinderPlus", mlst && "mlst", chew && "chewBBACA"].filter(Boolean).join(" + "),
            [amr.name, mlst && mlst.name, chew && chew.name].filter(Boolean).join(", "))];
        }
      }
    }
  } catch (e) { errors.push("Couldn't read the file: " + e.message); }
  importDraft = items;
  // Preview: interpret the new results together with everything already saved.
  const ctx = analysisContext([...state.results, ...items], state.patients);
  out.innerHTML = `<div class="panel"><div class="panel-head"><h3>Check before saving</h3><span class="eyebrow">${plural(items.length, "result")} ready</span></div>
    ${errors.length ? `<ul class="flags">${errors.map(e => `<li class="${e.startsWith("Note") ? "" : "discuss"}">${esc(e)}</li>`).join("")}</ul>` : ""}
    ${items.map(r => { const i = interpret(r, ctx); return `<div class="result ${i.level}"><div class="result-top"><div><span class="eyebrow">${esc(r.patientCode)} · ${esc(KIND_NAMES[r.kind])} · ${esc(r.collected)}</span><h3>${esc(i.finding)}</h3></div>
      <span class="pill ${i.needsDiscussion ? "watch-p" : "plain-p"}">${i.needsDiscussion ? "Will need discussion" : "Ready to sign"}</span></div>
      ${i.flags.length ? `<ul class="flags">${i.flags.map(f => `<li class="${f.level}">${f.text}</li>`).join("")}</ul>` : ""}</div>`; }).join("")}
    <div class="row"><button class="btn" id="imSave" ${items.length && !errors.some(e => !e.startsWith("Note")) ? "" : "disabled"}>Save ${plural(items.length, "result")}</button>
      ${errors.some(e => !e.startsWith("Note")) ? `<span class="err">Fix the problems above first; nothing has been saved.</span>` : ""}<span class="hint" id="imMsg"></span></div></div>`;
}
async function saveImport() {
  if (!importDraft || !importDraft.length) return;
  const n = importDraft.length;
  try { await store.addResults(importDraft); importDraft = null; state.ctab = "worklist"; state.worklistFilter = "open"; showCtab("worklist"); }
  catch (e) { $("imMsg").textContent = dbError(e); }
  void n;
}

// --- Outbreak analysis: integrates every patient's results (paper: "integrative analysis") ---
function renderOutbreaks() {
  const since = addDays(todayStr(), -13);
  const recent = state.results.filter(r => r.collected >= since && it(r).level !== "negative" && (r.kind === "pcr" || r.kind === "culture"));
  // positives by pathogen x residence
  const cells = {};
  recent.forEach(r => it(r).pathogens.forEach(pg => {
    const p = state.patients.find(x => x.id === r.patientId), place = p ? p.residence : "unknown";
    const k = pg + "|" + place; cells[k] = cells[k] || { pathogen: pg, place, n: 0, syndrome: it(r).syndrome, patients: new Set() };
    cells[k].patients.add(r.patientCode); cells[k].n = cells[k].patients.size;
  }));
  const posRows = Object.values(cells).sort((a, b) => b.n - a.n);
  const clusters = genomeClusters(state.ctx.genomes);
  const mdr = state.results.filter(r => r.kind === "culture" && it(r).flags.some(f => /MDR|ESBL|Carbapenem/.test(f.text)));
  const lineages = {};
  state.results.filter(r => r.kind === "viral_genome" && r.data && r.data.lineage).forEach(r => {
    const L = lineages[r.data.lineage] = lineages[r.data.lineage] || { n: 0, last: "" }; L.n++; if (r.collected > L.last) L.last = r.collected; });
  $("ctab-outbreaks").innerHTML = `
    <div class="kpis">${kpi("Positive tests, 14 days", recent.length, "PCR and culture")}${kpi("Genomic clusters", clusters.length, `≤ ${TH.clusterAlleles} allele differences`)}${kpi("Resistant organisms", mdr.length, "MDR, ESBL or carbapenem")}${kpi("Virus lineages", Object.keys(lineages).length, "from genomes")}</div>
    <div class="panel"><div class="panel-head"><h3>Positive tests by place</h3><span class="eyebrow">Last 14 days · distinct patients</span></div>
      ${posRows.length ? `<div class="table-box"><table><thead><tr><th>Pathogen</th><th>Residence</th><th>Syndrome</th><th style="text-align:center">Patients</th><th>Codes</th></tr></thead><tbody>${
        posRows.map(c => `<tr><td>${esc(c.pathogen)}</td><td>${esc(placeName(c.place))}</td><td>${synTag(c.syndrome) || "—"}</td><td class="n">${c.n}</td><td class="muted">${[...c.patients].map(esc).join(", ")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No positive tests in the last 14 days.</p>`}
      <p class="hint">Lab-confirmed counts complement the anonymous symptom reports on the <a href="./#overview">surveillance dashboard</a>: same places, same syndromes.</p></div>
    <div class="panel"><div class="panel-head"><h3>Bacterial genome clusters</h3><span class="eyebrow">cgMLST allele differences</span></div>
      ${clusters.length ? clusters.map(cl => `<div class="result positive"><div class="result-top"><h3><i>${esc(cl.species)}</i> · ${plural(cl.members.length, "isolate")}${cl.members[0].data.st ? " · ST" + esc(cl.members[0].data.st) : ""}</h3><span class="pill alert-p">likely outbreak</span></div>
          <p>${cl.members.map(g => { const p = state.patients.find(x => x.id === g.patientId); return `<b>${esc(g.patientCode)}</b> (${esc(placeName(p && p.residence))}, ${esc(g.collected)})`; }).join(" · ")}</p>
          <p class="hint">Isolates within ${TH.clusterAlleles} allele differences of each other are probably the same strain: look for a shared food, place or event.</p></div>`).join("") : `<p class="muted">No clusters: no two isolates are within ${TH.clusterAlleles} allele differences.</p>`}
      ${distanceMatrices()}</div>
    <div class="panel"><div class="panel-head"><h3>Virus lineages</h3><span class="eyebrow">Patients vs campus wastewater</span></div>
      ${Object.keys(lineages).length ? `<div class="table-box"><table><thead><tr><th>Lineage</th><th style="text-align:center">Patients</th><th>Latest sample</th><th>Share in Tempe wastewater</th></tr></thead><tbody>${
        Object.entries(lineages).sort((a, b) => b[1].n - a[1].n).map(([L, v]) => { const w = wastewaterLineage(L, "tempe"); return `<tr><td class="mono"><b>${esc(L)}</b></td><td class="n">${v.n}</td><td class="mono">${esc(v.last)}</td><td>${w ? Math.round(w.share * 100) + "% (" + fmtDate(w.date) + ")" : '<span class="muted">not in latest sample, or no wastewater data</span>'}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="muted">No viral genomes yet.</p>`}
      <p class="hint">Wastewater shares come from the public lineage data on the surveillance dashboard (Freyja), so clinic genomes and community sewage can be compared directly.</p></div>`;
}

// One heat map per species: allele differences between every pair of isolates.
function distanceMatrices() {
  const bySpecies = {};
  state.ctx.genomes.forEach(g => (bySpecies[g.data.species] = bySpecies[g.data.species] || []).push(g));
  return Object.entries(bySpecies).filter(([, l]) => l.length > 1).map(([species, list]) => {
    const n = list.length, cell = 46, L = 70, T = 26, W = L + n * cell + 4, H = T + n * cell + 4;
    let svg = `<svg class="heat" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Allele differences between ${esc(species)} isolates">`;
    list.forEach((g, i) => {
      svg += `<text x="${L - 6}" y="${T + i * cell + cell / 2 + 4}" text-anchor="end" fill="var(--ink-2)">${esc(g.patientCode)}</text>`;
      svg += `<text x="${L + i * cell + cell / 2}" y="${T - 8}" text-anchor="middle" fill="var(--ink-2)">${esc(g.patientCode.slice(2))}</text>`;
      list.forEach((h, j) => {
        const d = i === j ? 0 : alleleDistance(g.data.profile, h.data.profile).diff;
        const close = i !== j && d <= TH.clusterAlleles;
        svg += `<rect x="${L + j * cell}" y="${T + i * cell}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="${i === j ? "var(--surface-2)" : close ? "var(--alert-bg)" : "var(--surface)"}" stroke="var(--line)"><title>${esc(g.patientCode)} vs ${esc(h.patientCode)}: ${d} allele differences</title></rect>`;
        svg += `<text x="${L + j * cell + cell / 2 - 1}" y="${T + i * cell + cell / 2 + 4}" text-anchor="middle" fill="${close ? "var(--alert)" : "var(--ink)"}">${i === j ? "·" : d}</text>`;
      });
    });
    return `<div><span class="eyebrow"><i>${esc(species)}</i>: allele differences (red = same strain, ≤ ${TH.clusterAlleles})</span><div class="table-box">${svg}</svg></div></div>`;
  }).join("");
}

/* =====================================================================
   6. PATIENT VIEW: own results only, only once signed, in plain language
   ===================================================================== */
function renderPatientView() {
  const p = state.mode === "demo" ? state.patients.find(x => x.id === state.demoPatientId)
    : state.patients.find(x => x.ownerEmail === (state.user && state.user.email || "").toLowerCase());
  const rs = p ? state.results.filter(r => r.patientId === p.id && r.status === "signed").sort(byNewest) : [];
  const pending = p && state.mode === "demo" ? state.results.filter(r => r.patientId === p.id && r.status !== "signed").length : 0;
  $("view-patient").innerHTML = !p
    ? `<div class="panel"><h2>No results yet</h2><p>We couldn't find lab results linked to ${esc(state.user ? state.user.email : "this account")}.</p>
        <p class="hint">Results appear here after your clinician reviews them. If you expected some, ask the clinic to link this email to your record.</p></div>`
    : `<div style="display:grid;gap:16px">
      <div class="panel"><div class="panel-head"><div><span class="eyebrow">My lab results</span><h2>${esc(p.name)}</h2></div>
        ${rs.length ? `<button class="btn small" data-print="patient-self">Print my results</button>` : ""}</div>
        <p class="muted">Results appear here after your clinician has reviewed them.${pending ? ` ${plural(pending, "result is", "results are")} still being reviewed.` : ""}</p></div>
      ${rs.length ? rs.map(r => { const i = it(r); return `<article class="result ${i.level === "negative" ? "negative" : "positive"}">
          <div class="result-top"><div><span class="eyebrow">${esc(KIND_NAMES[r.kind])} · collected ${fmtDate(r.collected)}</span><h3>${esc(plainHeadline(r, i))}</h3></div></div>
          ${i.plain.filter(Boolean).map(t => `<p>${t}</p>`).join("")}
          ${r.note ? `<div class="flags"><li><b>Note from your clinician:</b> ${esc(r.note)}</li></div>` : ""}
          <p class="hint">Reviewed by ${esc(r.signedBy)} on ${fmtDate(r.signedAt)}.</p></article>`; }).join("")
        : `<div class="quiet">No reviewed results yet.</div>`}
      <p class="hint">Questions about a result? Contact the clinic. If you have trouble breathing, chest pain, confusion, or a stiff neck with fever, call 911.</p>
    </div>`;
}
function plainHeadline(r, i) {
  if (i.level === "negative") return r.kind === "culture" ? "Nothing grew" : "Nothing was found";
  return { pcr: "Germ found: " + i.pathogens.join(" and "), culture: (ORGS[r.data.organism] || {}).short ? "Bacteria found: " + ORGS[r.data.organism].short : "Bacteria found",
    viral_genome: "Virus type: " + (r.data.lineage || r.data.clade || "identified"), bacterial_genome: "Bacteria's genetic code read" }[r.kind] || i.finding;
}

/* =====================================================================
   7. RESEARCHER VIEW: de-identified records only
   (Live: the lab_deid collection, written when a clinician signs a result.
    Demo: built here from the signed demo results.)
   ===================================================================== */
function researchRows() {
  if (state.mode === "live") return state.deid;
  return state.results.filter(r => r.status === "signed").map(r => deidentify(r, state.patients.find(p => p.id === r.patientId), it(r)));
}
const suppress = n => n > 0 && n < TH.suppressBelow ? `<${TH.suppressBelow}` : String(n);

function renderResearcher() {
  const rows = researchRows();
  const pos = rows.filter(x => x.positive);
  // positives by pathogen and week (no place)
  const weeks = [...new Set(rows.map(x => x.week))].sort().slice(-6);
  const byPath = {};
  pos.forEach(x => x.pathogens.forEach(pg => { byPath[pg] = byPath[pg] || {}; byPath[pg][x.week] = (byPath[pg][x.week] || 0) + 1; }));
  // by campus and syndrome (place: small counts suppressed)
  const byCampus = {};
  pos.forEach(x => { const k = x.campus + "|" + x.syndrome; byCampus[k] = (byCampus[k] || 0) + 1; });
  // resistance: organism x drug category
  const cultures = rows.filter(x => x.kind === "culture" && x.organism);
  const res = {};
  cultures.forEach(x => { const o = res[x.organism] = res[x.organism] || { n: 0, mdr: 0, cats: {} }; o.n++; if (x.mdr) o.mdr++; x.nonSusceptible.forEach(c => { o.cats[c] = (o.cats[c] || 0) + 1; }); });
  const genes = {};
  rows.filter(x => x.kind === "bacterial_genome").forEach(x => x.genes.forEach(g => { genes[g] = (genes[g] || 0) + 1; }));
  const clusters = genomeClusters(rows.filter(x => x.kind === "bacterial_genome" && x.profile).map((x, i) => ({ id: "iso" + i, data: { species: x.organism, profile: x.profile, st: x.st }, week: x.week, campus: x.campus })));
  const lineages = {};
  rows.filter(x => x.lineage).forEach(x => { lineages[x.lineage] = lineages[x.lineage] || {}; lineages[x.lineage][x.week] = (lineages[x.lineage][x.week] || 0) + 1; });

  $("view-researcher").innerHTML = `<div style="display:grid;gap:16px">
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">Researcher view</span><h2>De-identified lab results</h2></div>
      <div class="row"><button class="btn small" id="rxCsv" ${rows.length ? "" : "disabled"}>Download CSV + data dictionary</button><button class="btn small ghost" data-print="research">Print summary</button></div></div>
      <p class="muted">Only signed results, with no names, patient codes, emails, exact dates or residence halls: collection week (MMWR), age band and campus only. Counts by campus under ${TH.suppressBelow} are shown as "&lt;${TH.suppressBelow}". For symptom reports, wastewater and social data, use the <a href="./#research">Research tab</a> on the surveillance dashboard.</p></div>
    <div class="kpis">${kpi("Signed results", rows.length, "de-identified")}${kpi("Positive", pos.length, "PCR, culture, genome")}${kpi("MDR isolates", cultures.filter(x => x.mdr).length, `≥ ${TH.mdrCategories} drug categories`)}${kpi("Genomic clusters", clusters.length, `≤ ${TH.clusterAlleles} allele differences`)}</div>
    <div class="panel"><h3>Positive results by pathogen and week</h3>
      ${Object.keys(byPath).length ? `<div class="table-box"><table><thead><tr><th>Pathogen</th>${weeks.map(w => `<th style="text-align:center">${esc(w)}</th>`).join("")}<th style="text-align:center">Total</th></tr></thead><tbody>${
        Object.entries(byPath).sort((a, b) => sum(b[1]) - sum(a[1])).map(([pg, w]) => `<tr><td>${esc(pg)}</td>${weeks.map(k => `<td class="n">${w[k] || "—"}</td>`).join("")}<td class="n"><b>${sum(w)}</b></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No positive results yet.</p>`}</div>
    <div class="panel"><h3>Positive results by campus and syndrome</h3>
      ${Object.keys(byCampus).length ? `<div class="table-box"><table><thead><tr><th>Campus</th><th>Syndrome</th><th style="text-align:center">Positive</th></tr></thead><tbody>${
        Object.entries(byCampus).sort((a, b) => b[1] - a[1]).map(([k, n]) => { const [c, s] = k.split("|"); return `<tr><td>${esc(CAMPUSES[c] || c)}</td><td>${synTag(s) || "—"}</td><td class="n">${suppress(n)}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}</div>
    <div class="panel"><h3>Antibiotic resistance</h3>
      ${Object.keys(res).length ? `<div class="table-box"><table><thead><tr><th>Organism</th><th style="text-align:center">Isolates</th><th style="text-align:center">MDR</th><th>Not susceptible (isolates)</th></tr></thead><tbody>${
        Object.entries(res).map(([o, v]) => `<tr><td><i>${esc(o)}</i></td><td class="n">${v.n}</td><td class="n">${v.mdr}</td><td>${Object.entries(v.cats).map(([c, n]) => esc(c) + " (" + n + ")").join("; ") || "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No cultures yet.</p>`}
      ${Object.keys(genes).length ? `<p><span class="eyebrow">Resistance genes in sequenced isolates</span></p><div class="chipline">${Object.entries(genes).sort((a, b) => b[1] - a[1]).map(([g, n]) => `<span class="chip">${esc(g)} × ${n}</span>`).join("")}</div>` : ""}</div>
    <div class="panel"><h3>Genomic clusters</h3>
      ${clusters.length ? clusters.map(cl => `<p><b><i>${esc(cl.species)}</i></b>${cl.members[0].data.st ? " ST" + esc(cl.members[0].data.st) : ""}: ${plural(cl.members.length, "isolate")} (weeks ${[...new Set(cl.members.map(m => m.week))].map(esc).join(", ")}; ${[...new Set(cl.members.map(m => CAMPUSES[m.campus] || m.campus))].map(esc).join(", ")})</p>`).join("") : `<p class="muted">No clusters among signed isolates.</p>`}</div>
    <div class="panel"><h3>Virus lineages by week</h3>
      ${Object.keys(lineages).length ? `<div class="table-box"><table><thead><tr><th>Lineage</th>${weeks.map(w => `<th style="text-align:center">${esc(w)}</th>`).join("")}</tr></thead><tbody>${
        Object.entries(lineages).map(([L, w]) => `<tr><td class="mono">${esc(L)}</td>${weeks.map(k => `<td class="n">${w[k] || "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p class="muted">No signed viral genomes yet.</p>`}</div>
    <div class="panel"><h3>Using this data responsibly</h3><p class="muted">These are screening labels from simple rules, not diagnoses. Clinic patients are not a random sample of campus. Combine weeks or places before publishing small counts, and never try to identify anyone.</p></div>
  </div>`;
}
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

const DEID_COLUMNS = [
  ["kind", "Test type: pcr, culture, viral_genome or bacterial_genome"], ["week", "MMWR week the specimen was collected (exact dates are removed)"],
  ["age_band", "Patient age band"], ["campus", "Campus of the patient's residence (no residence hall)"], ["specimen", "Specimen type"],
  ["syndrome", "Syndrome id, same as the surveillance dashboard"], ["category", "Pathogen category"], ["positive", "true if anything was found"],
  ["pathogens", "Pathogens found, separated by semicolons"], ["organism", "Organism (culture or genome)"], ["st", "MLST sequence type"],
  ["non_susceptible", "Drug categories with an I or R result, separated by semicolons"], ["mdr", "true if not susceptible in 3 or more categories"],
  ["genes", "Confirmed resistance genes, separated by semicolons"], ["lineage", "Virus lineage"], ["coverage", "Genome coverage (%)"], ["is_demo", "true for synthetic demo data"],
];
function downloadResearchCsv() {
  const cell = v => { let s = Array.isArray(v) ? v.join(";") : v == null ? "" : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = researchRows().map(x => [x.kind, x.week, x.ageBand, x.campus, x.specimen, x.syndrome, x.category, x.positive, x.pathogens, x.organism, x.st, x.nonSusceptible, x.mdr, x.genes, x.lineage, x.coverage, x.demo]);
  const csv = "﻿" + [DEID_COLUMNS.map(c => c[0]), ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  const dict = "﻿" + [["column", "description"], ...DEID_COLUMNS].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  save("sentinel-lab-deidentified_" + todayStr() + ".csv", csv); setTimeout(() => save("sentinel-lab-data-dictionary.csv", dict), 300);
}
function save(name, text) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* =====================================================================
   8. PRINTED REPORTS
   The report is built into #printArea (the only thing that prints), then
   the browser's print dialog opens. "Save as PDF" there makes a PDF.
   ===================================================================== */
const SYNTHETIC = `<div class="synthetic">SYNTHETIC DEMO DATA. Class project (ASU BMI 461), not a clinical laboratory report. Not for diagnosis or treatment.</div>`;

function printReport(kind) {
  let html = "";
  if (kind === "clinician") html = clinicianReport(state.patients.find(p => p.id === state.patientId));
  else if (kind === "patient") html = patientReport(state.patients.find(p => p.id === state.patientId));
  else if (kind === "patient-self") html = patientReport(state.mode === "demo" ? state.patients.find(p => p.id === state.demoPatientId)
    : state.patients.find(x => x.ownerEmail === (state.user.email || "").toLowerCase()));
  else if (kind === "research") html = researchReport();
  $("printArea").innerHTML = `<div class="rpt">${html}</div>`;
  window.print();
}
const rptHead = (title, sub) => `<div class="rpt-head"><div><h1>${title}</h1><div>${sub}</div></div><div style="text-align:right">Campus Sentinel Lab Portal<br>Printed ${fmtTime(new Date().toISOString())}<br>by ${esc(currentUserName())}</div></div>${SYNTHETIC}`;

// Technical report for clinicians (paper Figure 5: patient info, summary table, details, "need discussion")
function clinicianReport(p) {
  const rs = state.results.filter(r => r.patientId === p.id).sort(byNewest);
  const discuss = rs.filter(r => it(r).needsDiscussion);
  return rptHead("Laboratory report (technical)", `${esc(p.code)} · ${esc(p.name)}`) + `
    <div class="sec"><h2>Patient</h2><table><tbody>
      <tr><th>Code</th><td>${esc(p.code)}</td><th>Name</th><td>${esc(p.name)}</td></tr>
      <tr><th>Age</th><td>${ageOf(p) ?? "—"}</td><th>Residence</th><td>${esc(placeName(p.residence))} (${esc(CAMPUSES[placeCampus(p.residence)] || "—")})</td></tr></tbody></table></div>
    <div class="sec"><h2>Summary</h2><table><thead><tr><th>Collected</th><th>Test</th><th>Finding</th><th>Syndrome</th><th>Type</th><th>Status</th></tr></thead><tbody>${
      rs.map(r => { const i = it(r); return `<tr><td>${esc(r.collected)}</td><td>${esc(KIND_NAMES[r.kind])}</td><td><b>${esc(i.finding)}</b></td><td>${i.syndrome ? esc(SYN[i.syndrome][0]) : "—"}</td><td>${i.level === "negative" ? "—" : catName(i.category)}</td><td>${statusOf(r, i).label}</td></tr>`; }).join("")}</tbody></table></div>
    ${discuss.length ? `<div class="sec"><h2>Needs discussion</h2>${discuss.map(r => it(r).flags.filter(f => f.level === "discuss").map(f => `<div class="flag">${esc(KIND_NAMES[r.kind])} (${esc(r.collected)}): ${f.text}${r.status === "signed" ? `<br><b>Resolved</b> by ${esc(r.signedBy)}: ${esc(r.note)}` : " <b>Open.</b>"}</div>`).join("")).join("")}</div>` : ""}
    <h2>Details</h2>
    ${rs.map(r => { const i = it(r), d = r.data || {}, pv = r.provenance || {};
      let det = "";
      if (r.kind === "pcr") det = `<p>${(d.panel === "gi" ? "GI" : "Respiratory")} panel, ${(d.targets || []).length} targets. Detected: ${(d.targets || []).filter(t => t.result === "detected").map(t => `${esc((TARGETS[t.id] || {}).name || t.id)} (Ct ${t.ct ?? "—"})`).join(", ") || "none"}.</p>`;
      if (r.kind === "culture") det = `<p><i>${esc(d.organism)}</i></p>${(d.ast || []).length ? `<table><thead><tr><th>Antibiotic</th><th>Category</th><th>MIC</th><th>S/I/R</th></tr></thead><tbody>${d.ast.map(a => `<tr><td>${esc(a.drug)}</td><td>${esc(DRUGS[a.drug] || "")}</td><td>${esc(a.mic)}</td><td><b>${esc(a.interp)}</b></td></tr>`).join("")}</tbody></table>` : ""}`;
      if (r.kind === "viral_genome") det = `<p>${esc(d.virus)} · lineage <b>${esc(d.lineage || "—")}</b>${d.clade ? " · clade " + esc(d.clade) : ""} · coverage ${d.coverage ?? "—"}% · QC ${esc(d.qcStatus || "—")} · ${d.substitutions ?? "—"} substitutions${(d.aaSubstitutions || []).length ? ". Amino-acid changes: " + d.aaSubstitutions.slice(0, 20).map(esc).join(", ") : ""}</p>`;
      if (r.kind === "bacterial_genome") det = `<p><i>${esc(d.species)}</i>${d.st ? " · ST" + esc(d.st) : ""}${d.scheme ? " (" + esc(d.scheme) + ")" : ""} · ${d.profile ? Object.keys(d.profile).length : 0} cgMLST loci</p>${(d.amr || []).length ? `<table><thead><tr><th>Gene</th><th>Class</th><th>Identity</th><th>Coverage</th><th>Call</th></tr></thead><tbody>${d.amr.map(h => `<tr><td>${esc(h.gene)}</td><td>${esc(h.cls)}</td><td>${h.identity ?? "—"}%</td><td>${h.coverage ?? "—"}%</td><td>${hitConfirmed(h) ? "confirmed" : "partial"}</td></tr>`).join("")}</tbody></table>` : "<p>No resistance genes.</p>"}`;
      return `<div class="sec"><h3>${esc(KIND_NAMES[r.kind])} · ${esc(r.specimen || "")} · collected ${esc(r.collected)}: ${esc(i.finding)}</h3>${det}
        ${i.flags.map(f => `<div class="flag ${f.level === "alert" ? "alert" : ""}">${f.text}</div>`).join("")}
        <p style="font-size:9pt;color:#555">Source: ${esc(pv.tool || pv.source || "—")}${pv.file ? " (" + esc(pv.file) + ")" : ""} · imported by ${esc(pv.importedBy || "—")}, ${fmtTime(pv.importedAt)}${r.status === "signed" ? ` · signed by ${esc(r.signedBy)}, ${fmtTime(r.signedAt)}` : " · NOT YET SIGNED"}${r.note ? ` · Note: ${esc(r.note)}` : ""}</p></div>`; }).join("")}
    <div class="sign"><div>Reviewing clinician</div><div>Date</div></div>
    <div class="foot">Rules: PCR late detection Ct &gt; ${TH.lateCt}; genome coverage ≥ ${TH.minCoverage}%; resistance gene identity and coverage ≥ ${TH.minIdentity}% / ${TH.minGeneCoverage}%; outbreak cluster ≤ ${TH.clusterAlleles} cgMLST allele differences; MDR = not susceptible in ≥ ${TH.mdrCategories} drug categories (Magiorakos et al. 2012). S/I/R as reported by the laboratory.</div>`;
}

// Plain-language report for the patient: signed results only.
function patientReport(p) {
  const rs = state.results.filter(r => r.patientId === p.id && r.status === "signed").sort(byNewest);
  return rptHead("Your lab results", esc(p.name)) + `
    <p>These are the lab results your clinician has reviewed. Each one says what was tested, what was found and what it means.</p>
    ${rs.length ? rs.map(r => { const i = it(r); return `<div class="sec"><h2>${esc(KIND_NAMES[r.kind])} · ${fmtDate(r.collected)}</h2>
      <p class="big">${esc(plainHeadline(r, i))}</p>${i.plain.filter(Boolean).map(t => `<p>${t}</p>`).join("")}
      ${r.note ? `<div class="flag">Note from your clinician: ${esc(r.note)}</div>` : ""}<p style="font-size:9pt;color:#555">Reviewed by ${esc(r.signedBy)} on ${fmtDate(r.signedAt)}.</p></div>`; }).join("") : "<p>No reviewed results yet.</p>"}
    <div class="foot">Questions about these results? Contact the clinic. If you have trouble breathing, chest pain, confusion, or a stiff neck with fever, call 911.</div>`;
}

function researchReport() {
  const rows = researchRows(), pos = rows.filter(x => x.positive);
  const byPath = {}; pos.forEach(x => x.pathogens.forEach(pg => { byPath[pg] = (byPath[pg] || 0) + 1; }));
  return rptHead("De-identified lab summary", `${rows.length} signed results`) + `
    <div class="sec"><h2>Positive results by pathogen</h2><table><thead><tr><th>Pathogen</th><th>Positive</th></tr></thead><tbody>${
      Object.entries(byPath).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join("")}</tbody></table></div>
    <div class="sec"><h2>Resistance</h2><p>${rows.filter(x => x.mdr).length} multidrug-resistant isolates. Genes: ${[...new Set(rows.flatMap(x => x.genes))].map(esc).join(", ") || "none"}.</p></div>
    <div class="foot">De-identified: collection week, age band and campus only. Screening labels from rules, not diagnoses.</div>`;
}

/* =====================================================================
   9. SIGN-IN, ROLES AND STARTUP
   ===================================================================== */
function currentUserName() {
  if (state.mode === "demo") return "Dr. Demo Clinician";
  return state.user ? (state.user.displayName || state.user.email) : "unknown";
}
function roleFor(email) {
  const e = String(email || "").toLowerCase(), has = list => (list || []).map(x => x.toLowerCase()).includes(e);
  return has(C.clinicians) ? "clinician" : has(C.researchers) ? "researcher" : "patient";
}
function dbError(e) {
  return e && e.code === "permission-denied"
    ? "The database refused. Check that this account is listed in firestore.rules (isClinician) and that the rules are published."
    : "Couldn't save (" + (e && (e.code || e.message) || "unknown error") + ").";
}
function getConfig() { if (window.FIREBASE_CONFIG) return window.FIREBASE_CONFIG; try { return firebaseConfig; } catch (e) { return null; } } // eslint-disable-line no-undef

function render() {
  state.ctx = analysisContext(state.results, state.patients);
  state.its = new Map(state.results.map(r => [r.id, interpret(r, state.ctx)]));
  const role = state.role;
  $("view-landing").hidden = !!role;
  $("view-clinician").hidden = role !== "clinician";
  $("view-patient").hidden = role !== "patient";
  $("view-researcher").hidden = role !== "researcher";
  $("demoBanner").hidden = state.mode !== "demo";
  document.querySelectorAll("[data-role]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.role === role)));
  $("demoPatientWrap").hidden = !(state.mode === "demo" && role === "patient");
  if (role === "clinician") renderClinician();
  if (role === "patient") renderPatientView();
  if (role === "researcher") renderResearcher();
  $("whoText").textContent = state.mode === "demo" ? "Demo" : state.user ? `${state.user.email} · ${role}` : "Not signed in";
}

function startDemo(role) {
  stopListening();
  const { patients, results } = LAB_DEMO.build(todayStr());
  Object.assign(state, { mode: "demo", role, patients, results, deid: [], ctab: "worklist", worklistFilter: "open" });
  const withSigned = patients.filter(p => results.some(r => r.patientId === p.id && r.status === "signed"));
  state.demoPatientId = withSigned[0].id;
  $("demoPatient").innerHTML = patients.map(p => `<option value="${esc(p.id)}">${esc(p.code)} · ${esc(p.name)}</option>`).join("");
  $("demoPatient").value = state.demoPatientId;
  if (role === "clinician") showCtab("worklist"); else render();
  window.scrollTo(0, 0);
}
function exitDemo() {
  Object.assign(state, { mode: state.user ? "live" : null, role: null, patients: [], results: [], deid: [] });
  if (state.user) onUser(state.user); else render();
}

function stopListening() { state.unsub.forEach(u => u()); state.unsub = []; }
function listen(query, onDocs) {
  state.unsub.push(query.onSnapshot(snap => { onDocs(snap.docs.map(d => ({ id: d.id, ...d.data() }))); render(); },
    err => { $("problem").hidden = false; $("problem").textContent = err.code === "permission-denied"
      ? "The database refused to share these records. Publish the updated firestore.rules, and check the email lists in it and in lab-config.js."
      : "Live updates stopped (" + err.code + "). Reload to reconnect."; }));
}

function onUser(user) {
  state.user = user;
  $("signIn").hidden = !!user || !state.auth; $("signOut").hidden = !user;
  if (state.mode === "demo") return render();          // stay in the demo until "Exit demo"
  stopListening();
  if (!user) { Object.assign(state, { mode: null, role: null, patients: [], results: [], deid: [] }); return render(); }
  const email = (user.email || "").toLowerCase(), role = roleFor(email), db = state.db;
  Object.assign(state, { mode: "live", role, patients: [], results: [], deid: [] });
  if (role === "clinician") {
    listen(db.collection("lab_patients"), d => { state.patients = d; });
    listen(db.collection("lab_results"), d => { state.results = d; });
    listen(db.collection("lab_deid"), d => { state.deid = d; });
  } else if (role === "researcher") {
    listen(db.collection("lab_deid"), d => { state.deid = d; });
  } else {   // patient: only their own record and their own signed results (the rules check the same thing)
    listen(db.collection("lab_patients").where("ownerEmail", "==", email), d => { state.patients = d; });
    listen(db.collection("lab_results").where("ownerEmail", "==", email).where("status", "==", "signed"), d => { state.results = d; });
  }
  if (role === "clinician") showCtab(state.ctab); else render();
}

async function signIn() {
  if (!state.auth) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  try { await state.auth.signInWithPopup(provider); }
  catch (err) {
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") return state.auth.signInWithRedirect(provider);
    $("problem").hidden = false;
    $("problem").textContent = "Sign-in failed: " + ({ "auth/unauthorized-domain": "this website isn't on Firebase's list. Add it under Authentication > Settings > Authorized domains.",
      "auth/operation-not-allowed": "Google sign-in is turned off. Turn it on under Authentication > Sign-in method.",
      "auth/popup-closed-by-user": "the sign-in window was closed before finishing." }[err.code] || err.message);
  }
}

// One click handler for the whole page (buttons are re-drawn often).
document.addEventListener("click", e => {
  const t = e.target.closest("button, tr[data-open], tr[data-patient], tr[data-jump]");
  if (!t) return;
  const ds = t.dataset;
  if (t.id === "signIn" || t.id === "signIn2") signIn();
  else if (t.id === "signOut") state.auth && state.auth.signOut();
  else if (ds.demo) startDemo(ds.demo);
  else if (t.id === "exitDemo") exitDemo();
  else if (ds.role) { state.role = ds.role; if (ds.role === "clinician") showCtab(state.ctab === "patient" ? "worklist" : state.ctab); else render(); }
  else if (ds.ctab) { if (ds.ctab === "import") state.importKind = state.importKind || "pcr"; showCtab(ds.ctab); }
  else if (ds.wl) { state.worklistFilter = ds.wl; renderWorklist(); }
  else if (ds.open) openResult(ds.open);
  else if (ds.patient) { state.patientId = ds.patient; showCtab("patient"); window.scrollTo(0, 0); }
  else if (ds.jump) { const el = $("res-" + ds.jump); if (el) el.scrollIntoView({ behavior: "smooth" }); }
  else if (ds.back !== undefined) showCtab("patients");
  else if (ds.sign) signResult(ds.sign);
  else if (ds.print) printReport(ds.print);
  else if (ds.imkind) { state.importKind = ds.imkind; renderImport(); }
  else if (t.id === "imPreview") previewImport();
  else if (t.id === "imSave") saveImport();
  else if (t.id === "imTemplate") { const today = todayStr(); $("imCsv").value = IMPORT_KINDS[state.importKind].template.replace(/2026-11-12/g, addDays(today, -1)); }
  else if (t.id === "npAdd") addPatient();
  else if (t.id === "saveOwner") {
    const v = $("ownerEmail").value.trim().toLowerCase();
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { $("ownerMsg").textContent = "That email doesn't look right."; return; }
    store.updatePatient(state.patientId, { ownerEmail: v }).then(() => { if ($("ownerMsg")) $("ownerMsg").textContent = "Saved."; }, err => { $("ownerMsg").textContent = dbError(err); });
  }
  else if (t.id === "rxCsv") downloadResearchCsv();
  else if (t.id === "demoLoad") { $("demoMsg").textContent = "Adding…"; store.loadDemoIntoDatabase().then(() => { $("demoMsg").textContent = "Added."; }, err => { $("demoMsg").textContent = dbError(err); }); }
  else if (t.id === "demoRemove") { if (!confirm("Remove every demo patient and result from the database?")) return; store.removeDemoFromDatabase().then(() => {}, err => { $("demoMsg").textContent = dbError(err); }); }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("tr[data-open], tr[data-patient]")) e.target.click(); });
$("demoPatient").addEventListener("change", e => { state.demoPatientId = e.target.value; render(); });

(function start() {
  const cfg = getConfig();
  const ready = window.firebase && cfg && cfg.projectId && !String(cfg.projectId).startsWith("PASTE");
  if (ready) {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    state.db = firebase.firestore(); state.auth = firebase.auth();
    state.auth.onAuthStateChanged(onUser);
    // Public wastewater lineages (last 70 days), to compare clinic genomes with community sewage.
    state.db.collection("lineages").where("date", ">=", addDays(todayStr(), -70)).onSnapshot(s => { state.lineages = s.docs.map(d => d.data()); if (state.role) render(); }, () => {});
  } else {
    $("signIn2").disabled = true;
    $("signInNote").textContent = window.firebase ? "Sign-in isn't set up (firebase-config.js is missing). The demo still works." : "The Firebase library didn't load, so sign-in is unavailable. The demo still works.";
    render();
  }
  const want = (location.hash || "").slice(1);            // e.g. lab.html#demo-clinician opens the demo directly
  if (/^demo-(clinician|patient|researcher)$/.test(want)) startDemo(want.slice(5));
  else render();
})();
