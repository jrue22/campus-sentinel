/* =====================================================================
   SENTINEL LAB CORE: the interpretation rules, with no screen code
   ---------------------------------------------------------------------
   Used by lab.html (the Lab portal), index.html (lab summaries on the
   clinician home page) and demo-data.html (de-identified demo copies).
   Everything is inside one function so its names can't clash with the
   page's own; the page gets them from window.LabCore.
   ===================================================================== */
window.LabCore = (function () {
"use strict";
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
   3. INTERPRETATION RULES
   interpret(result, ctx) turns one result into:
     finding     one line for tables ("Influenza A detected")
     level       positive / negative / discuss
     syndrome, category, pathogens    (the same ids as the surveillance dashboard)
     flags       [{level: "alert" | "discuss" | "info", text}]
                 "discuss" = the result needs a clinician's review before signing
                 (shown as "Needs review"; like the paper's "need discussion" list for the Molecular Biology Board)
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
let LINEAGES = [];            // public wastewater lineage samples, set by the page with setLineages()
function setLineages(list) { LINEAGES = list || []; }
function wastewaterLineage(lineage, campus) {
  if (!lineage || !campus || !LINEAGES.length || !window.WW_SITES) return null;
  const site = window.WW_SITES.find(s => s.campus === campus && !(s.residences || []).length);
  if (!site) return null;
  const latest = LINEAGES.filter(x => x.site === site.id).sort((a, b) => b.date.localeCompare(a.date))[0];
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

// What a result looks like on a worklist: status + whether it needs review.
function statusOf(r, it) {
  if (r.status === "signed") return { key: "signed", label: "Signed", cls: "ok-p" };
  if (it.needsDiscussion) return { key: "discuss", label: "Needs review", cls: "watch-p" };
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


// Demo lab data for this browser tab, shared by lab.html and the home page
// (so a result signed in the lab shows up on the home page too). Rebuilt each day.
const DEMO_KEY = "sentinel-lab-demo";
function loadDemo(build) {
  try { const v = JSON.parse(sessionStorage.getItem(DEMO_KEY) || "null"); if (v && v.day === todayStr()) return v; } catch (e) { /* storage blocked */ }
  const v = { day: todayStr(), ...build(todayStr()) }; saveDemo(v); return v;
}
function saveDemo(v) { try { sessionStorage.setItem(DEMO_KEY, JSON.stringify({ day: todayStr(), patients: v.patients, results: v.results })); } catch (e) { /* storage blocked: the demo still works on this page */ } }
function resetDemo() { try { sessionStorage.removeItem(DEMO_KEY); } catch (e) { /* ignore */ } }

return { loadDemo, saveDemo, resetDemo, C, TH, TARGETS, ORGS, DRUGS, PLACES, CAMPUSES, SYN, KIND_NAMES, esc, localDate, todayStr, DATE_RE, toUTC, addDays, daysBetween, mmwrWeek, fmtDate, fmtTime, placeName, placeCampus, ageOf, ageBand, synTag, plural, uid, catName, analysisContext, interpret, wastewaterLineage, setLineages, betaLactamCategories, geneCategories, hitConfirmed, alleleDistance, genomeClusters, statusOf, deidentify };
})();
