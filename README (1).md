# Campus Sentinel

Anonymous symptom reporting and a live cluster dashboard for campus syndromic surveillance. Class project, not an official ASU service.

Built with plain HTML, CSS and JavaScript. Reports are stored in Firebase Cloud Firestore and the site is hosted free on GitHub Pages.

This project and associated documentation was generated with Anthropic’s Claude LLM.

## Files

| File | What it does |
|---|---|
| `index.html` | The whole app: survey, dashboard (including the Research export tab), method page, and all the logic |
| `firebase-config.js` | Your Firebase project settings (you fill this in) |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
| `seed.html` | Loads 38 example reports for demos |
| `feed.html` | Demo social feed classmates post to during the live demo |
| `worker/` | Python NLP worker (see `worker/README.md`) |
| `wastewater-config.js` | Wastewater targets (viruses, bacteria) and sampling sites with map coordinates. Edit to match your facility |
| `wastewater-import.html` | Signed-in uploaders add wastewater results and SARS-CoV-2 lineage results (CSV), or example data |
| `lab.html` | **Lab portal**: sign-in page for clinic lab results (patients, clinicians, researchers) |
| `lab-app.js` | Lab portal logic: data store, interpretation rules, file readers, views, printed reports |
| `lab-config.js` | Lab portal settings: clinician and researcher emails, PCR targets, antibiotics, thresholds |
| `lab-demo.js` | 21 synthetic demo patients and their results |
| `manifest.webmanifest`, `icon-*.png` | Make "Add to Home Screen" work like an app |

## Setup (about 15 minutes)

### 1. Create the database (Firebase)

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project**. Name it `campus-sentinel`. You can turn off Google Analytics.
3. In the left menu, open **Build → Firestore Database** and click **Create database**.
   - Pick a location close to Arizona, such as `us-west2 (Los Angeles)`. You can't change this later.
   - Choose **Start in production mode**.
4. Open the **Rules** tab. Delete what's there, paste everything from `firestore.rules`, and click **Publish**.
5. Click the gear icon → **Project settings**. Under **Your apps**, click the web icon `</>`. Name it `sentinel` and skip Firebase Hosting.
6. Firebase shows a `firebaseConfig` block. Copy its values into `firebase-config.js`, replacing each `PASTE_...` value.

Firebase's menus change now and then, so the labels may differ slightly.

### 2. Put the site online (GitHub Pages)

1. Create a free account at <https://github.com> if you don't have one.
2. Click **New repository**. Name it `campus-sentinel`, set it to **Public**, and create it.
3. Click **uploading an existing file** and drag in every file from this folder, including your edited `firebase-config.js`. Click **Commit changes**.
4. Go to **Settings → Pages**. Under **Branch**, choose `main` and `/ (root)`, then **Save**.
5. After a minute or two your site is live at `https://YOUR-USERNAME.github.io/campus-sentinel/`.

### 3. Try it

1. Open `https://YOUR-USERNAME.github.io/campus-sentinel/seed.html` and click **Add 38 example reports**.
2. Open the main address and go to the **Dashboard** tab. You should see "Live" in the top corner and the example clusters.
3. On an iPhone: open the site in **Safari** → **Share** → **Add to Home Screen**. It opens full screen with its own icon.

## Wastewater surveillance

The dashboard has a **Wastewater signals** panel with a map. For each sampling site and target, it compares the geometric mean of the last 7 days with the 28 days before. A 2x rise is *elevated* and 4x is *high*; a first detection after only non-detects is *elevated*. When a signal has the same syndrome and place as a symptom cluster, the cluster card shows **+ wastewater**. A signal with no matching cluster is a possible early warning.

The map (Leaflet + OpenStreetMap) shows one circle per sampling site, colored by its strongest signal. Tap a circle for details. Site locations are the `lat` and `lng` values in `wastewater-config.js`.

### More wastewater features

- **Sparklines:** each row of the wastewater table shows the last 5 weeks of samples (log scale), with the baseline as a dashed line.
- **Lead time ("Did wastewater see it first?"):** for each symptom cluster with a matching wastewater signal, the days from the wastewater rise (first sample at 2x baseline or more) to the first symptom onset, with a mini timeline. Rising signals with no matching cluster are listed as possible early warnings.
- **SARS-CoV-2 genomics** (collapsible panel): lineage shares per sample from sequencing (Freyja), as stacked bars per site, plus genetic diversity: the effective number of lineages, e^H, where H is the Shannon index.
- **At a glance:** a short plain-language summary at the bottom of the dashboard, built by rules from the numbers above it.

Lineage names shown in color are listed in `WW_LINEAGES` in `wastewater-config.js` (up to 5, in color order); others count as "Other". To load lineage data, use the second section of `wastewater-import.html`: a CSV with `date,site,lineage,abundance` (one row per lineage, abundance as a fraction), or **Add example lineage data**. The example lineage names are real 2025 Pango lineages used for illustration only; they are not current results.

### One-time setup: who can upload lab data

Anyone can submit a symptom report, but only listed accounts can add wastewater samples. One fake sample would show a "high" alert on every dashboard.

1. Firebase console → **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → **Enable** → choose a support email → **Save**.
3. **Settings** tab → **Authorized domains** → **Add domain** → your GitHub Pages domain, e.g. `yourname.github.io` (no `https://`, no folder).
4. In **Firestore Database → Rules**, paste `firestore.rules` (it now covers `reports`, `wastewater` and `lineages`), replace `YOUR-EMAIL@asu.edu` in `isLabUploader()` with the uploader's Google or ASU email (add teammates comma-separated, each in quotes), and click **Publish**. You can leave the placeholder in the GitHub copy so your email isn't public; the console copy is the one that counts.

### Loading data

1. Edit `wastewater-config.js` so the sites, coordinates and targets match your facility. The included sites and coordinates are placeholders.
2. Open `.../wastewater-import.html` and **Sign in with Google**.
3. Click **Add example wastewater data** and **Add example lineage data** to demo (run `seed.html` too: the examples line up with its Hassayampa and Taylor Place clusters, plus one wastewater-only Salmonella signal at West Valley). For real data, paste or upload a CSV with `date,site,target,copies_per_l,pmmov_copies_per_l`.
4. Samples already stored (same site, target and date) are skipped, so uploading twice is safe.
5. Each site and target needs at least 2 samples this week and 2 in the prior four weeks before it shows up.

Wastewater data is public to read: do not upload anything confidential.

## Social & media signals (NLP)

The dashboard's **Social & media signals** panel shows illness posts found by natural language processing in a demo social feed (`feed.html`), news, school notices and other sources. A Python worker in the `worker/` folder reads each post with OpenAI (or a keyword method as a fallback), extracts symptoms, place, timing and any named disease, and writes only those fields to Firestore (`media_extracted`). The dashboard labels them with the same syndrome and pathogen rules as survey reports, and marks when symptom reports and wastewater agree. Setup and commands: `worker/README.md`.

## Research data export

The dashboard's **Research** tab lets someone studying specific illnesses and places pull everything the system holds on them.

1. **Pick syndromes** (all six are selected by default) and **places** (grouped by campus; tick a whole group or single halls).
2. **Pick a date range** (presets for 30 days to a year, or any dates) and the **sources**: symptom reports, wastewater samples, SARS-CoV-2 lineages, social posts, news stories.
3. Click **Pull data**. The page reads every matching record straight from Firestore, so it is not limited to the last 70 or 14 days the live dashboard keeps.
4. Preview the first rows, then download CSV files one at a time, or **Download everything (.zip)**.

What you get:

| File | One row per | Notes |
|---|---|---|
| `symptom_reports.csv` | survey report | onset date and MMWR week, residence, campuses, syndrome, pathogen category and confidence, symptoms, severity, exposures |
| `wastewater_samples.csv` | site, target and date | copies per L, PMMoV and the PMMoV-normalized value, site location and scope |
| `sars2_lineages.csv` | sample and lineage | reported and rescaled share, diversity of the sample |
| `social_posts.csv` | illness post | extracted fields only (the post text is never stored) |
| `news_stories.csv` | illness story | outlet, headline, link, region, case count |
| `daily_summary.csv` | date and syndrome | counts from reports, social posts and news |
| `data_dictionary.csv`, `query.json` | (ZIP only) | what every column means, and the exact filters used, so the pull can be repeated and cited |

How the filters work:

- **Syndrome:** reports, posts and stories use their assigned syndrome. A wastewater target is included when it is linked to a selected syndrome in `wastewater-config.js` (for example norovirus, rotavirus, Salmonella and Cryptosporidium for Gastrointestinal). Lineage data is included when SARS-CoV-2's linked syndromes are selected.
- **Place:** reports match the residence chosen. Posts and stories match the place their text names; one that names only a campus counts when you pick an on-campus residence there, and `place_level` says which it was. A wastewater site is included when its sewer line covers a selected residence, or its whole campus when the site is campus-wide.
- **Example data** is left out unless you tick the box. If every syndrome and place is selected, nothing is filtered on them, so posts with no named place are kept.
- Only illness-related posts and stories have a syndrome, so only those are exported.

Notes:

- No Firestore rule changes are needed: the tab only reads collections that are already public.
- Each pull reads every matching document (the free plan allows 50,000 reads a day), so keep ranges as narrow as the question allows.
- Text cells that start with `=`, `+`, `-` or `@` get a leading apostrophe so spreadsheets can't run them as formulas.
- Reports are anonymous, but a count of 1 to 4 in one residence can point to real people. Combine places or weeks, or suppress small counts, before publishing.
- The ZIP uses JSZip from cdnjs. If it doesn't load, the individual CSV buttons still work.

## Lab portal (lab.html)

A private, sign-in page where **patients and clinicians** work with clinic lab results, and **researchers** see de-identified totals. It is modeled on the KDI system in Servant et al., *Bioinformatics for precision medicine in oncology: principles and application to the SHIVA clinical trial* (Front. Genet. 2014), scaled to a campus clinic.

**Use synthetic data only.** This is a class project. Real patient data would need institutional approval (privacy office, IRB) and a HIPAA-covered setup.

| KDI (paper) | Lab portal |
|---|---|
| Integrates clinical, IHC, microarray and NGS data in one system | PCR panels, cultures with susceptibility, viral genomes and bacterial genomes in one record per patient |
| Pipelines (alignment, variant calling, copy number) produce results | Standard tools run elsewhere (Nextclade, AMRFinderPlus, mlst, chewBBACA); the portal imports their output files |
| Filters on frequency, coverage and strand ratio; "need discussion" list | Rules flag late PCR detections, low genome coverage, partial gene matches, co-detections and genome/culture disagreements as **Needs discussion** |
| Report for the Molecular Biology Board (patient info, color-coded summary, details) | Printable **technical report** for clinicians and a plain-language **patient summary** |
| Bioinfo-Board tracks each patient's progress | **Worklist**: every result's status (needs discussion, ready to sign, signed) |
| Controlled access, anonymous identifiers, traceability | Role-based Firestore rules, patient codes, and a record of who imported and signed each result |

**Roles**

| Role | Who | Sees |
|---|---|---|
| Clinician | Emails in `isClinician()` (firestore.rules) and `LAB_CONFIG.clinicians` (lab-config.js) | Every patient; worklist; import; outbreak analysis; technical reports |
| Researcher | Emails in `isResearcher()` and `LAB_CONFIG.researchers` | De-identified results only (collection week, age band, campus; counts under 5 hidden) |
| Patient | Anyone else who signs in | Only their own record, only signed results, in plain language, with a print button |

A clinician links a patient's record to their Google email on the patient page. Signing a result also writes a de-identified copy (`lab_deid`) for researchers.

**Importing results** (Import results tab; everything is checked and previewed before saving)

| Result | File | Notes |
|---|---|---|
| PCR panel | CSV: `patient_code,collected_date,specimen,panel,target,result,ct` | One row per target; target ids are listed in `lab-config.js` |
| Culture + susceptibility | CSV: `patient_code,collected_date,specimen,organism,antibiotic,mic,interpretation` | S/I/R as the lab reports it (breakpoints change yearly, so the app never converts MICs itself) |
| Viral genome | Nextclade `--output-tsv` file | Lineage, coverage, QC status, mutations. Compared with the campus wastewater lineages |
| Bacterial genome | AMRFinderPlus output, plus optional `mlst` output and chewBBACA `results_alleles.tsv` | Resistance genes, sequence type, and cgMLST allele profile for outbreak clusters |

**Rules** (thresholds are in `lab-config.js`)

- PCR detection with Ct above 35, or more than one target detected: needs discussion.
- Viral genome coverage under 90%, or Nextclade QC "bad": needs discussion.
- Resistance gene hit under 90% identity or 90% coverage: needs discussion (partial match).
- Genome predicts resistance but the culture says susceptible: needs discussion.
- Not susceptible in 3 or more drug categories: multidrug resistant (Magiorakos et al. 2012). Resistance to 3rd-generation cephalosporins in E. coli or Klebsiella: possible ESBL.
- Two isolates of the same species differing at 5 or fewer cgMLST loci: likely the same outbreak strain.
- A result that needs discussion can only be signed with a note explaining the decision.

**Setup**

1. Firebase console → Authentication → Sign-in method: Google is already on (wastewater uploads use it).
2. Put the clinician (and researcher) emails in `firestore.rules` **and** `lab-config.js`, then publish the rules.
3. Upload `lab.html`, `lab-app.js`, `lab-config.js` and `lab-demo.js` next to `index.html`.
4. Open `lab.html`, sign in as a clinician, Patients tab → **Add demo patients**. To show a patient login, type a classmate's Google email on one demo patient's page; when they sign in, they see that patient's signed results.

No account needed for the demo: `lab.html#demo-clinician`, `#demo-patient` or `#demo-researcher` open it with synthetic data kept in the browser tab.

## Running the live demo

1. Put the **Dashboard** on the projector. It shows a QR code that opens the survey.
2. Classmates scan it and submit reports on their phones.
3. Each report appears on the dashboard within seconds. When three people pick the same residence and similar symptoms, a cluster alert appears.

Tip: to set off an alert on purpose, ask everyone to pick the same residence hall and tap vomiting and diarrhea.

## Before and after the presentation

- The example data uses dates relative to the day you load it, so run `seed.html` on the day of the demo.
- To clear all reports: Firebase console → Firestore Database → Data → the `reports` collection → **⋮ → Delete collection**.
- The free Firebase plan allows 50,000 reads and 20,000 writes a day, which is far more than a class demo needs.

## Security notes

- The values in `firebase-config.js` are meant to be public. They name your project; they don't grant access.
- Access is controlled by `firestore.rules`: anyone can read reports and add a well-formed report; only listed, signed-in accounts can add wastewater samples; nobody can edit or delete either from the website.
- Anyone with the link could still submit fake reports. A real deployment would add sign-in (for example ASU single sign-on) and rate limits.

## How the code is organized

`index.html` has a numbered script:

1. **Config**: campuses, residences, symptoms (edit these lists to change the survey)
2. **Classifier**: symptoms → syndrome, and point-based rules → pathogen category
3. **Cluster detection**: counts by residence and campus over a 7-day window
4. **Data storage**: Firebase `add()` to save and `onSnapshot()` for live updates
5. **Survey form**
6. **Dashboard rendering**, including a hand-drawn SVG epidemic curve; section 6b is the research export (filtering, CSV and ZIP files)
7. **Startup**

Only section 4 talks to Firebase (including `fetchResearchData()` for the research export). Switching to another database means rewriting just that section.
