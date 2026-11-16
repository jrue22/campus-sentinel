/* =====================================================================
   Campus Sentinel Lab portal: SYNTHETIC demo data
   ---------------------------------------------------------------------
   Every patient and result here is made up. Names end in "(demo)" and every
   record carries demo: true. The stories match the surveillance dashboard's
   example data, so the two can be shown together:
     - norovirus at Hassayampa (GI PCR panels)
     - influenza A at Gordon Commons (respiratory PCR panels)
     - Salmonella near West Valley (cultures + bacterial genomes: an outbreak cluster)
     - SARS-CoV-2 lineage XFG on the Tempe campus (viral genomes)
     - strep throat (throat cultures)
     - a multidrug-resistant E. coli urinary infection (culture + genome: ST131, CTX-M-15)
   Dates are relative to "today", so the demo never goes stale.
   ===================================================================== */

window.LAB_DEMO = (function () {
  // Small seeded random generator, so the demo is the same every time.
  function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

  function build(today) {
    const rand = rng(461);
    const addDays = (d, n) => { const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
    const now = new Date().toISOString();
    const year = Number(today.slice(0, 4));
    const patients = [], results = [];

    const P = (n, name, age, residence) => {
      const p = { id: "demo-p" + n, code: "P-" + (1000 + n), name: name + " (demo)", birthYear: year - age,
        residence, ownerEmail: "", demo: true, createdAt: now, createdBy: "demo" };
      patients.push(p); return p;
    };
    let rn = 0;
    const R = (p, kind, daysAgo, specimen, data, opts = {}) => {
      rn++;
      const collected = addDays(today, -daysAgo);
      const r = { id: "demo-r" + rn, patientId: p.id, patientCode: p.code, ownerEmail: "", kind, collected, specimen,
        status: opts.signed ? "signed" : "analyzed", data,
        provenance: { source: "demo", tool: opts.tool || "", file: opts.file || "", importedBy: "demo", importedAt: now },
        note: opts.note || "", signedBy: opts.signed ? "Dr. Demo Clinician" : "", signedAt: opts.signed ? now : "",
        demo: true, history: [{ at: now, by: "demo", action: "imported" }] };
      if (opts.signed) r.history.push({ at: now, by: "Dr. Demo Clinician", action: "signed" });
      results.push(r); return r;
    };
    const RESP = ["flu_a", "flu_b", "sars_cov_2", "rsv", "rhino_entero", "hmpv", "adenovirus", "mycoplasma", "pertussis", "strep_a"];
    const GI = ["noro_gi", "noro_gii", "rotavirus", "sapovirus", "salmonella", "campylobacter", "shigella", "stec", "giardia", "crypto"];
    const panel = (ids, hits) => ids.map(id => hits[id] !== undefined
      ? { id, result: "detected", ct: hits[id] } : { id, result: "not_detected", ct: null });

    // cgMLST-style allele profiles (50 loci, demo scheme). Outbreak isolates differ at 0-2 loci.
    const LOCI = Array.from({ length: 50 }, (_, i) => "locus_" + String(i + 1).padStart(3, "0"));
    const baseProfile = () => Object.fromEntries(LOCI.map(l => [l, 1 + Math.floor(rand() * 40)]));
    const vary = (base, n) => { const p = { ...base }; for (let i = 0; i < n; i++) { const l = LOCI[Math.floor(rand() * LOCI.length)]; p[l] = 41 + Math.floor(rand() * 60); } return p; };
    const salBase = baseProfile(), ecoBase = baseProfile();

    // --- Norovirus at Hassayampa: GI panels ---
    const hass = [P(1, "Avery K.", 19, "tempe-hassayampa"), P(2, "Jordan M.", 18, "tempe-hassayampa"), P(3, "Riley S.", 19, "tempe-hassayampa"),
                  P(4, "Casey T.", 20, "tempe-hassayampa"), P(5, "Morgan L.", 18, "tempe-hassayampa")];
    R(hass[0], "pcr", 4, "stool", { panel: "gi", targets: panel(GI, { noro_gii: 24.1 }) }, { signed: true, tool: "GI multiplex PCR", note: "Norovirus GII. Supportive care and hydration; avoid preparing food for others for 48 hours after symptoms stop." });
    R(hass[1], "pcr", 3, "stool", { panel: "gi", targets: panel(GI, { noro_gii: 22.7 }) }, { signed: true, tool: "GI multiplex PCR" });
    R(hass[2], "pcr", 3, "stool", { panel: "gi", targets: panel(GI, { noro_gii: 27.9 }) }, { tool: "GI multiplex PCR" });
    R(hass[3], "pcr", 2, "stool", { panel: "gi", targets: panel(GI, { noro_gii: 36.8 }) }, { tool: "GI multiplex PCR" });          // late Ct
    R(hass[4], "pcr", 2, "stool", { panel: "gi", targets: panel(GI, { noro_gii: 25.3, sapovirus: 31.2 }) }, { tool: "GI multiplex PCR" }); // co-detection

    // --- Influenza A at Gordon Commons: respiratory panels ---
    const gc = [P(6, "Taylor B.", 19, "dtphx-taylor"), P(7, "Jamie R.", 20, "dtphx-taylor"), P(8, "Quinn D.", 18, "dtphx-taylor"), P(9, "Drew P.", 21, "dtphx-taylor")];
    R(gc[0], "pcr", 3, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, { flu_a: 21.4 }) }, { signed: true, tool: "Respiratory multiplex PCR" });
    R(gc[1], "pcr", 2, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, { flu_a: 19.8 }) }, { signed: true, tool: "Respiratory multiplex PCR" });
    R(gc[2], "pcr", 1, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, { flu_a: 23.5, sars_cov_2: 33.0 }) }, { tool: "Respiratory multiplex PCR" });
    R(gc[3], "pcr", 1, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, {}) }, { tool: "Respiratory multiplex PCR" });

    // --- SARS-CoV-2 genomes, Tempe campus (Nextclade-style results) ---
    const tc = [P(10, "Sam W.", 22, "tempe-manzanita"), P(11, "Alex J.", 19, "tempe-tooker"), P(12, "Rowan F.", 20, "off-tempe")];
    const subs = n => Array.from({ length: n }, () => "C" + (1000 + Math.floor(rand() * 28000)) + "T");
    R(tc[0], "pcr", 6, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, { sars_cov_2: 18.2 }) }, { signed: true, tool: "Respiratory multiplex PCR" });
    R(tc[0], "viral_genome", 5, "nasopharyngeal swab", { virus: "SARS-CoV-2", lineage: "XFG", clade: "", coverage: 98.6, qcStatus: "good",
      substitutions: 104, missing: 412, frameShifts: 0, aaSubstitutions: ["S:T22N", "S:F59S", "S:G184S", "S:K478T", "ORF1a:K1795Q"] }, { signed: true, tool: "Nextclade", file: "nextclade.tsv" });
    R(tc[1], "viral_genome", 4, "nasopharyngeal swab", { virus: "SARS-CoV-2", lineage: "XFG", clade: "", coverage: 96.1, qcStatus: "good",
      substitutions: 106, missing: 1170, frameShifts: 0, aaSubstitutions: ["S:T22N", "S:F59S", "S:G184S", "S:K478T"] }, { tool: "Nextclade", file: "nextclade.tsv" });
    R(tc[2], "viral_genome", 3, "nasopharyngeal swab", { virus: "SARS-CoV-2", lineage: "LP.8.1", clade: "", coverage: 78.4, qcStatus: "mediocre",
      substitutions: 88, missing: 6450, frameShifts: 1, aaSubstitutions: subs(3) }, { tool: "Nextclade", file: "nextclade.tsv" });

    // --- Salmonella near West Valley: cultures + genomes (two isolates in one cluster, one unrelated) ---
    const wv = [P(13, "Parker N.", 21, "west-casadeoro"), P(14, "Emerson G.", 20, "off-west"), P(15, "Reese H.", 23, "off-tempe")];
    const salAst = (cipro) => [
      { drug: "ampicillin", mic: ">32", interp: "R" }, { drug: "ceftriaxone", mic: "<=0.25", interp: "S" },
      { drug: "ciprofloxacin", mic: cipro === "I" ? "0.25" : "<=0.06", interp: cipro }, { drug: "trimethoprim-sulfamethoxazole", mic: "<=0.5", interp: "S" },
      { drug: "azithromycin", mic: "4", interp: "S" }];
    const salAmr = [{ gene: "blaTEM-1", cls: "BETA-LACTAM", subclass: "BETA-LACTAM", identity: 100, coverage: 100, type: "AMR" },
                    { gene: "gyrA_D87Y", cls: "QUINOLONE", subclass: "QUINOLONE", identity: 100, coverage: 100, type: "AMR" }];
    R(wv[0], "culture", 5, "stool", { organism: "Salmonella enterica", ast: salAst("I") }, { signed: true, tool: "Culture + AST" });
    R(wv[0], "bacterial_genome", 3, "isolate", { species: "Salmonella enterica", scheme: "senterica", st: "11", amr: salAmr, profile: vary(salBase, 1), isolate: "WV-01" },
      { signed: true, tool: "AMRFinderPlus + mlst + chewBBACA", file: "WV-01_amrfinder.tsv" });
    R(wv[1], "culture", 4, "stool", { organism: "Salmonella enterica", ast: salAst("I") }, { tool: "Culture + AST" });
    R(wv[1], "bacterial_genome", 2, "isolate", { species: "Salmonella enterica", scheme: "senterica", st: "11", amr: salAmr, profile: vary(salBase, 2), isolate: "WV-02" },
      { tool: "AMRFinderPlus + mlst + chewBBACA", file: "WV-02_amrfinder.tsv" });
    R(wv[2], "culture", 9, "stool", { organism: "Salmonella enterica", ast: salAst("S") }, { signed: true, tool: "Culture + AST" });
    R(wv[2], "bacterial_genome", 7, "isolate", { species: "Salmonella enterica", scheme: "senterica", st: "19",
      amr: [{ gene: "blaTEM-1", cls: "BETA-LACTAM", subclass: "BETA-LACTAM", identity: 99.9, coverage: 100, type: "AMR" }], profile: vary(baseProfile(), 0), isolate: "TE-03" },
      { signed: true, tool: "AMRFinderPlus + mlst + chewBBACA", file: "TE-03_amrfinder.tsv" });

    // --- Strep throat ---
    const st = [P(16, "Hayden C.", 19, "poly-century"), P(17, "Kendall V.", 18, "tempe-barrett")];
    R(st[0], "culture", 3, "throat swab", { organism: "Streptococcus pyogenes", ast: [
      { drug: "penicillin", mic: "<=0.03", interp: "S" }, { drug: "erythromycin", mic: "<=0.25", interp: "S" }, { drug: "clindamycin", mic: "<=0.25", interp: "S" }] },
      { signed: true, tool: "Culture + AST", note: "Group A strep. Penicillin or amoxicillin for 10 days." });
    R(st[1], "culture", 2, "throat swab", { organism: "Streptococcus pyogenes", ast: [
      { drug: "penicillin", mic: "<=0.03", interp: "S" }, { drug: "erythromycin", mic: ">2", interp: "R" }, { drug: "clindamycin", mic: "<=0.25", interp: "S" }] },
      { tool: "Culture + AST" });

    // --- Multidrug-resistant E. coli urinary infection (culture + genome) ---
    const ec = P(18, "Blake O.", 22, "tempe-vds");
    R(ec, "culture", 5, "urine", { organism: "Escherichia coli", ast: [
      { drug: "ampicillin", mic: ">32", interp: "R" }, { drug: "cefazolin", mic: ">32", interp: "R" }, { drug: "ceftriaxone", mic: ">64", interp: "R" },
      { drug: "ciprofloxacin", mic: ">4", interp: "R" }, { drug: "trimethoprim-sulfamethoxazole", mic: ">320", interp: "R" },
      { drug: "nitrofurantoin", mic: "<=16", interp: "S" }, { drug: "meropenem", mic: "<=0.25", interp: "S" }, { drug: "gentamicin", mic: "<=1", interp: "S" }] },
      { tool: "Culture + AST" });
    R(ec, "bacterial_genome", 3, "isolate", { species: "Escherichia coli", scheme: "ecoli_achtman_4", st: "131", amr: [
      { gene: "blaCTX-M-15", cls: "BETA-LACTAM", subclass: "CEPHALOSPORIN", identity: 100, coverage: 100, type: "AMR" },
      { gene: "blaOXA-1", cls: "BETA-LACTAM", subclass: "BETA-LACTAM", identity: 100, coverage: 100, type: "AMR" },
      { gene: "gyrA_S83L", cls: "QUINOLONE", subclass: "QUINOLONE", identity: 100, coverage: 100, type: "AMR" },
      { gene: "parC_S80I", cls: "QUINOLONE", subclass: "QUINOLONE", identity: 100, coverage: 100, type: "AMR" },
      { gene: "sul1", cls: "SULFONAMIDE", subclass: "SULFONAMIDE", identity: 100, coverage: 100, type: "AMR" },
      { gene: "dfrA17", cls: "TRIMETHOPRIM", subclass: "TRIMETHOPRIM", identity: 100, coverage: 100, type: "AMR" },
      { gene: "aac(6')-Ib-cr5", cls: "AMINOGLYCOSIDE/QUINOLONE", subclass: "AMIKACIN/KANAMYCIN/QUINOLONE/TOBRAMYCIN", identity: 99.6, coverage: 86.0, type: "AMR" }],
      profile: vary(ecoBase, 0), isolate: "VD-01" }, { tool: "AMRFinderPlus + mlst + chewBBACA", file: "VD-01_amrfinder.tsv" });

    // --- A few more negatives and signed results, for realistic counts ---
    R(P(19, "Logan E.", 19, "tempe-sonora"), "pcr", 8, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, { rhino_entero: 26.4 }) }, { signed: true, tool: "Respiratory multiplex PCR" });
    R(P(20, "Skyler A.", 20, "poly-other"), "pcr", 6, "nasopharyngeal swab", { panel: "respiratory", targets: panel(RESP, { rsv: 24.9 }) }, { signed: true, tool: "Respiratory multiplex PCR" });
    R(P(21, "Cameron I.", 18, "tempe-hassayampa"), "pcr", 9, "stool", { panel: "gi", targets: panel(GI, {}) }, { signed: true, tool: "GI multiplex PCR" });

    return { patients, results };
  }

  return { build };
})();
