# Campus Sentinel

Anonymous symptom reporting and a live cluster dashboard for campus syndromic surveillance. Class project, not an official ASU service.

Built with plain HTML, CSS and JavaScript. Reports are stored in Firebase Cloud Firestore and the site is hosted free on GitHub Pages.

This project and associated documentation was generated with Anthropic’s Claude LLM.

## Files

| File | What it does |
|---|---|
| `index.html` | The whole app: survey, dashboard, method page, and all the logic |
| `firebase-config.js` | Your Firebase project settings (you fill this in) |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
| `seed.html` | Loads 38 example reports for demos |
| `wastewater-config.js` | Wastewater targets (viruses, bacteria) and sampling sites with map coordinates. Edit to match your facility |
| `wastewater-import.html` | Signed-in uploaders add a CSV of wastewater results, or example data |
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

### One-time setup: who can upload lab data

Anyone can submit a symptom report, but only listed accounts can add wastewater samples. One fake sample would show a "high" alert on every dashboard.

1. Firebase console → **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → **Enable** → choose a support email → **Save**.
3. **Settings** tab → **Authorized domains** → **Add domain** → your GitHub Pages domain, e.g. `yourname.github.io` (no `https://`, no folder).
4. In **Firestore Database → Rules**, paste `firestore.rules`, replace `YOUR-EMAIL@asu.edu` in `isLabUploader()` with the uploader's Google or ASU email (add teammates comma-separated, each in quotes), and click **Publish**. You can leave the placeholder in the GitHub copy so your email isn't public; the console copy is the one that counts.

### Loading data

1. Edit `wastewater-config.js` so the sites, coordinates and targets match your facility. The included sites and coordinates are placeholders.
2. Open `.../wastewater-import.html` and **Sign in with Google**.
3. Click **Add example wastewater data** to demo (run `seed.html` too: the examples line up with its Hassayampa and Taylor Place clusters, plus one wastewater-only Salmonella signal at West Valley). For real data, paste or upload a CSV with `date,site,target,copies_per_l,pmmov_copies_per_l`.
4. Samples already stored (same site, target and date) are skipped, so uploading twice is safe.
5. Each site and target needs at least 2 samples this week and 2 in the prior four weeks before it shows up.

Wastewater data is public to read: do not upload anything confidential.

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
6. **Dashboard rendering**, including a hand-drawn SVG epidemic curve
7. **Startup**

Only section 4 talks to Firebase. Switching to another database means rewriting just that section.
