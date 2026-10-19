// Wastewater surveillance settings, shared by index.html and wastewater-import.html.
// EDIT THESE to match your treatment facility's real sampling points and assays.
// The sites below are placeholders. "residences: []" means the site covers its whole campus;
// a list of residence ids (from RESIDENCES in index.html) means a building-level sewer line.
// "syndromes" links each target to the symptom syndromes it should show up in.
// "lat" and "lng" place each site on the dashboard map. The values below are approximate
// campus or building locations; replace them with the real manhole or sampler locations.
window.WW_TARGETS = [
  { id: "sars2", name: "SARS-CoV-2",        category: "viral",     syndromes: ["ili", "resp"], hint: "Expect respiratory illness. Encourage testing, vaccination and staying home when sick." },
  { id: "fluA",  name: "Influenza A",       category: "viral",     syndromes: ["ili"],         hint: "Expect flu-like illness. Promote vaccination and early antiviral care for high-risk students." },
  { id: "rsv",   name: "RSV",               category: "viral",     syndromes: ["resp", "ili"], hint: "Expect cold-like illness; watch students with asthma or other lung conditions." },
  { id: "noro",  name: "Norovirus GII",     category: "viral",     syndromes: ["gi"],          hint: "Expect vomiting and diarrhea. Step up bleach-based cleaning of shared bathrooms and kitchens." },
  { id: "salm",  name: "Salmonella",        category: "bacterial", syndromes: ["gi"],          hint: "Possible foodborne source. Review dining venues and alert environmental health." },
  { id: "campy", name: "Campylobacter",     category: "bacterial", syndromes: ["gi"],          hint: "Possible foodborne source (poultry, unpasteurized milk). Alert environmental health." },
  { id: "shig",  name: "Shigella (ipaH)",   category: "bacterial", syndromes: ["gi"],          hint: "Spreads person to person; stress handwashing. Consider stool testing for bloody diarrhea." },
  { id: "stec",  name: "STEC E. coli (stx)", category: "bacterial", syndromes: ["gi"],         hint: "Serious foodborne risk. Notify health services if bloody diarrhea is reported." },
];
window.WW_SITES = [
  { id: "tempe-campus",      name: "Tempe campus main sewer",       campus: "tempe",    residences: [], lat: 33.4242, lng: -111.9281 },
  { id: "tempe-hassayampa",  name: "Hassayampa Village sewer line", campus: "tempe",    residences: ["tempe-hassayampa"], lat: 33.4157, lng: -111.9296 },
  { id: "dtphx-campus",      name: "Downtown Phoenix campus sewer", campus: "downtown", residences: [], lat: 33.4530, lng: -112.0735 },
  { id: "poly-campus",       name: "Polytechnic campus sewer",      campus: "poly",     residences: [], lat: 33.3070, lng: -111.6790 },
  { id: "west-campus",       name: "West Valley campus sewer",      campus: "west",     residences: [], lat: 33.6077, lng: -112.1606 },
];

// SARS-CoV-2 lineages shown by name in the genomics panel, in color order (up to 5).
// Any other lineage in the data is counted as "Other". The example data uses these names.
// Replace with the lineages your lab's Freyja results report.
window.WW_LINEAGES = ["LP.8.1", "XFG", "NB.1.8.1", "XEC"];
