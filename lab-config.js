/* =====================================================================
   Campus Sentinel Lab portal: settings and interpretation rules
   ---------------------------------------------------------------------
   Everything the Lab portal (lab.html) needs to know about tests, drugs
   and thresholds lives here, in one readable place, so the rules can be
   checked and changed without touching the app code.

   WHO CAN SEE WHAT
   The email lists below only decide which screens the page shows.
   The real protection is in firestore.rules (isClinician / isResearcher):
   keep both lists the same.
   ===================================================================== */

window.LAB_CONFIG = {
  // Google accounts that sign in as clinicians (see and add every patient's results).
  clinicians: ["drewgordon9@gmail.com"],
  // Google accounts that sign in as researchers (de-identified data only).
  researchers: [drewgordon9@gmail.com],
  // Everyone else who signs in is treated as a patient and sees only records
  // whose ownerEmail is their own address, and only after a clinician signs them.

  // Thresholds used by the interpretation rules (lab.html, section 3)
  thresholds: {
    // PCR: a target detected at a cycle threshold (Ct) above this is a "late" detection
    // (very little genetic material, or contamination) and goes to "needs discussion".
    // Source: common laboratory practice; labs set their own cutoff.
    lateCt: 35,
    // Viral genomes: share of the genome sequenced. Below this, lineage calls are unreliable.
    // Source: genomic surveillance programs commonly require >= 90% coverage for reporting.
    minCoverage: 90,
    // Resistance genes: a hit counts as confirmed only if it matches the reference gene this well.
    minIdentity: 90,     // % identity to the reference sequence
    minGeneCoverage: 90, // % of the reference gene covered
    // Bacterial outbreak clusters: isolates differing at this many cgMLST loci or fewer are
    // reported as "likely the same outbreak strain". Thresholds vary by species and scheme;
    // 5 is a common starting point for Salmonella and E. coli (e.g. EnteroBase's HC5 level).
    clusterAlleles: 5,
    // Multidrug resistant (MDR): not susceptible to at least one drug in this many drug
    // categories. Source: Magiorakos et al., Clin Microbiol Infect 2012 (international expert proposal).
    mdrCategories: 3,
    // Researcher view: counts below this are shown as "<5" so small groups can't point to people.
    suppressBelow: 5,
  },
};

/* ---------------------------------------------------------------------
   PCR panel targets: each maps to a pathogen, a syndrome (the same ids the
   dashboard uses) and a pathogen category.
   --------------------------------------------------------------------- */
window.LAB_TARGETS = {
  // Respiratory panel
  flu_a:        { name: "Influenza A",              panel: "respiratory", syndrome: "ili",  category: "viral" },
  flu_b:        { name: "Influenza B",              panel: "respiratory", syndrome: "ili",  category: "viral" },
  sars_cov_2:   { name: "SARS-CoV-2",               panel: "respiratory", syndrome: "ili",  category: "viral" },
  rsv:          { name: "RSV",                      panel: "respiratory", syndrome: "resp", category: "viral" },
  rhino_entero: { name: "Rhinovirus/enterovirus",   panel: "respiratory", syndrome: "resp", category: "viral" },
  hmpv:         { name: "Human metapneumovirus",    panel: "respiratory", syndrome: "resp", category: "viral" },
  adenovirus:   { name: "Adenovirus",               panel: "respiratory", syndrome: "resp", category: "viral" },
  mycoplasma:   { name: "Mycoplasma pneumoniae",    panel: "respiratory", syndrome: "resp", category: "bacterial" },
  pertussis:    { name: "Bordetella pertussis",     panel: "respiratory", syndrome: "resp", category: "bacterial" },
  strep_a:      { name: "Group A Streptococcus",    panel: "respiratory", syndrome: "ili",  category: "bacterial" },
  // Gastrointestinal panel
  noro_gi:      { name: "Norovirus GI",             panel: "gi", syndrome: "gi", category: "viral" },
  noro_gii:     { name: "Norovirus GII",            panel: "gi", syndrome: "gi", category: "viral" },
  rotavirus:    { name: "Rotavirus",                panel: "gi", syndrome: "gi", category: "viral" },
  sapovirus:    { name: "Sapovirus",                panel: "gi", syndrome: "gi", category: "viral" },
  salmonella:   { name: "Salmonella",               panel: "gi", syndrome: "gi", category: "bacterial" },
  campylobacter:{ name: "Campylobacter",            panel: "gi", syndrome: "gi", category: "bacterial" },
  shigella:     { name: "Shigella/EIEC",            panel: "gi", syndrome: "gi", category: "bacterial" },
  stec:         { name: "Shiga toxin E. coli (STEC)", panel: "gi", syndrome: "gi", category: "bacterial" },
  giardia:      { name: "Giardia",                  panel: "gi", syndrome: "gi", category: "parasitic" },
  crypto:       { name: "Cryptosporidium",          panel: "gi", syndrome: "gi", category: "parasitic" },
};

/* ---------------------------------------------------------------------
   Organisms grown in culture: syndrome and category for the dashboard ids.
   --------------------------------------------------------------------- */
window.LAB_ORGANISMS = {
  "Streptococcus pyogenes": { short: "Group A strep", syndrome: "ili", category: "bacterial" },
  "Salmonella enterica":    { short: "Salmonella",    syndrome: "gi",  category: "bacterial" },
  "Escherichia coli":       { short: "E. coli",       syndrome: "other", category: "bacterial" },
  "Klebsiella pneumoniae":  { short: "Klebsiella",    syndrome: "other", category: "bacterial" },
  "Staphylococcus aureus":  { short: "Staph aureus",  syndrome: "skin", category: "bacterial" },
  "Campylobacter jejuni":   { short: "Campylobacter", syndrome: "gi",  category: "bacterial" },
};

/* ---------------------------------------------------------------------
   Antibiotics and their drug categories (used for the MDR rule and for
   comparing resistance genes with the lab's susceptibility results).
   The lab reports S / I / R itself: breakpoints (CLSI or EUCAST) change
   yearly, so this app never converts MICs to S/I/R on its own.
   --------------------------------------------------------------------- */
window.LAB_DRUGS = {
  "penicillin":                    "penicillins",
  "ampicillin":                    "penicillins",
  "amoxicillin-clavulanate":       "penicillins + beta-lactamase inhibitors",
  "cefazolin":                     "1st/2nd-generation cephalosporins",
  "ceftriaxone":                   "3rd/4th-generation cephalosporins",
  "cefepime":                      "3rd/4th-generation cephalosporins",
  "meropenem":                     "carbapenems",
  "ciprofloxacin":                 "fluoroquinolones",
  "levofloxacin":                  "fluoroquinolones",
  "gentamicin":                    "aminoglycosides",
  "trimethoprim-sulfamethoxazole": "folate pathway inhibitors",
  "nitrofurantoin":                "nitrofurans",
  "tetracycline":                  "tetracyclines",
  "azithromycin":                  "macrolides",
  "erythromycin":                  "macrolides",
  "clindamycin":                   "lincosamides",
  "vancomycin":                    "glycopeptides",
  "oxacillin":                     "anti-staphylococcal beta-lactams",
};

/* ---------------------------------------------------------------------
   Resistance-gene classes (AMRFinderPlus "Class" column) -> the drug
   categories above that the gene is expected to affect. Used to check
   that the genome and the culture agree (genotype-phenotype concordance).
   Beta-lactamases depend on the gene family, so they are handled by name
   in lab.html (betaLactamCategories).
   --------------------------------------------------------------------- */
window.LAB_GENE_CLASSES = {
  "QUINOLONE":     ["fluoroquinolones"],
  "AMINOGLYCOSIDE":["aminoglycosides"],
  "SULFONAMIDE":   ["folate pathway inhibitors"],
  "TRIMETHOPRIM":  ["folate pathway inhibitors"],
  "TETRACYCLINE":  ["tetracyclines"],
  "MACROLIDE":     ["macrolides"],
  "LINCOSAMIDE":   ["lincosamides"],
  "GLYCOPEPTIDE":  ["glycopeptides"],
  "NITROFURAN":    ["nitrofurans"],
};

/* ---------------------------------------------------------------------
   Places (keep in sync with RESIDENCES in index.html)
   --------------------------------------------------------------------- */
window.LAB_PLACES = {
  "tempe-barrett": ["Barrett Honors complex", "tempe"],
  "tempe-hassayampa": ["Hassayampa Academic Village", "tempe"],
  "tempe-manzanita": ["Manzanita Hall", "tempe"],
  "tempe-tooker": ["Tooker House", "tempe"],
  "tempe-vds": ["Vista del Sol", "tempe"],
  "tempe-sonora": ["Sonora Center", "tempe"],
  "tempe-other": ["Other Tempe residence hall", "tempe"],
  "dtphx-taylor": ["Gordon Commons (formerly Taylor Place)", "downtown"],
  "dtphx-other": ["Other Downtown housing", "downtown"],
  "poly-century": ["Century Hall", "poly"],
  "poly-other": ["Other Polytechnic housing", "poly"],
  "west-casadeoro": ["Casa de Oro", "west"],
  "west-other": ["Other West Valley housing", "west"],
  "off-tempe": ["Off campus near Tempe", "tempe"],
  "off-dtphx": ["Off campus near Downtown", "downtown"],
  "off-poly": ["Off campus near Polytechnic", "poly"],
  "off-west": ["Off campus near West Valley", "west"],
  "off-home": ["At home / long commute", null],
};
window.LAB_CAMPUSES = { tempe: "Tempe", downtown: "Downtown Phoenix", poly: "Polytechnic", west: "West Valley" };
window.LAB_SYNDROMES = {
  ili: ["Influenza-like illness", "var(--s-ili)"], resp: ["Other respiratory", "var(--s-resp)"],
  gi: ["Gastrointestinal", "var(--s-gi)"], skin: ["Rash / skin", "var(--s-skin)"],
  neuro: ["Meningitis-like", "var(--s-neuro)"], other: ["Other / not syndromic", "var(--s-other)"],
};
