# Campus Sentinel

Anonymous symptom reporting and a live cluster dashboard for campus syndromic surveillance. Class project, not an official ASU service.

Built with plain HTML, CSS and JavaScript. Reports are stored in Firebase Cloud Firestore and the site is hosted free on GitHub Pages.

## Files

| File | What it does |
|---|---|
| `index.html` | The whole app: survey, dashboard, method page, and all the logic |
| `firebase-config.js` | Your Firebase project settings (you fill this in) |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
| `seed.html` | Loads 38 example reports for demos |
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
- Access is controlled by `firestore.rules`: anyone can read reports and add a well-formed report, and nobody can edit or delete them from the website.
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
