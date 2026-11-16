/* =====================================================================
   CAMPUS SENTINEL: who is using the app
   ---------------------------------------------------------------------
   Shared by every page (index.html, lab.html, demo-data.html), so the
   role you pick follows you from page to page.

   Two ways in:
     - Sign in with Google. Your role comes from the email lists in
       lab-config.js (clinicians, researchers); everyone else is a Student.
       The real protection is in firestore.rules, which checks the same lists.
     - Demo: pick a role, no account needed. Remembered for this browser
       tab only (sessionStorage), and only example data is shown or changed.
   ===================================================================== */
window.Session = (function () {
  "use strict";
  const KEY = "sentinel-session";
  const NAMES = { student: "Student", clinician: "Clinician", researcher: "Researcher" };
  let current = null;            // { mode: "demo" | "live", role, email, name, demoPatientId }
  let auth = null, db = null, problem = null, started = false;
  const listeners = [];

  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } };
  const write = v => { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) { /* private mode: the demo still works on this page */ } };
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function roleFor(email) {
    const e = String(email || "").toLowerCase(), C = window.LAB_CONFIG || {};
    const has = list => (list || []).map(x => String(x).toLowerCase()).includes(e);
    return has(C.clinicians) ? "clinician" : has(C.researchers) ? "researcher" : "student";
  }
  function getConfig() {
    if (window.FIREBASE_CONFIG) return window.FIREBASE_CONFIG;
    try { return firebaseConfig; } catch (e) { return null; }   // eslint-disable-line no-undef
  }

  // Connect to Firebase once (if it's set up), then report the current user to every page listener.
  function init() {
    if (started) return; started = true;
    const c = getConfig();
    if (!window.firebase) problem = "the Firebase library didn't load. Check your internet connection or content blocker, and reload.";
    else if (!c) problem = "firebase-config.js is missing or has a typo. It must sit next to index.html and start with window.FIREBASE_CONFIG = {";
    else if (!c.projectId || String(c.projectId).startsWith("PASTE")) problem = "firebase-config.js still has the PASTE_ placeholder values.";
    if (!problem) {
      if (!firebase.apps.length) firebase.initializeApp(c);
      db = firebase.firestore();
      if (firebase.auth) auth = firebase.auth();
    }
    const saved = read();
    if (saved && saved.mode === "demo" && NAMES[saved.role]) current = saved;
    if (auth) {
      auth.onAuthStateChanged(user => {
        if (current && current.mode === "demo") return emit();          // a demo stays a demo until you leave it
        current = user ? { mode: "live", role: roleFor(user.email), email: (user.email || "").toLowerCase(), name: user.displayName || user.email } : null;
        emit();
      });
    } else setTimeout(emit, 0);
  }
  function emit() { renderChip(); listeners.forEach(f => f(current)); }

  function startDemo(role) {
    const old = read() || {};
    current = { mode: "demo", role: NAMES[role] ? role : "student", demoPatientId: old.demoPatientId || null };
    write(current); emit();
  }
  function setDemoPatient(id) { if (current && current.mode === "demo") { current.demoPatientId = id; write(current); } }
  function leave() {
    if (current && current.mode === "demo") {
      write(null);
      const u = auth && auth.currentUser;
      current = u ? { mode: "live", role: roleFor(u.email), email: (u.email || "").toLowerCase(), name: u.displayName || u.email } : null;
      return emit();
    }
    if (auth) auth.signOut();
  }
  async function signIn() {
    if (!auth) throw new Error(problem || "Sign-in isn't available.");
    write(null);
    if (current && current.mode === "demo") current = null;
    const provider = new firebase.auth.GoogleAuthProvider();
    try { await auth.signInWithPopup(provider); }
    catch (err) {
      if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") return auth.signInWithRedirect(provider);
      throw new Error({ "auth/unauthorized-domain": "this website isn't on Firebase's list. Add it under Authentication > Settings > Authorized domains.",
        "auth/operation-not-allowed": "Google sign-in is turned off. Turn it on under Authentication > Sign-in method.",
        "auth/popup-closed-by-user": "the sign-in window was closed before finishing." }[err.code] || err.message);
    }
  }

  // The small "who am I" control in the page header (an element with id="session").
  function renderChip() {
    const el = document.getElementById("session");
    if (!el) return;
    if (!current) { el.innerHTML = `<a class="chip-link" href="./#start">Sign in or try the demo</a>`; return; }
    if (current.mode === "demo") {
      el.innerHTML = `<span class="who-mode">Demo</span>
        <select id="sessionRole" aria-label="Demo role">${Object.entries(NAMES).map(([k, v]) => `<option value="${k}"${k === current.role ? " selected" : ""}>${v}</option>`).join("")}</select>
        <button type="button" class="chip-btn" id="sessionLeave">Exit</button>`;
      document.getElementById("sessionRole").onchange = e => startDemo(e.target.value);
    } else {
      el.innerHTML = `<span class="who-mode" title="${esc(current.email)}">${esc(NAMES[current.role])}</span>
        <span class="who-email">${esc(current.email)}</span><button type="button" class="chip-btn" id="sessionLeave">Sign out</button>`;
    }
    document.getElementById("sessionLeave").onclick = () => { leave(); if (!/index\.html$|\/$/.test(location.pathname)) location.href = "./#start"; };
  }

  return {
    init, startDemo, signIn, leave, setDemoPatient, roleFor, NAMES,
    onChange: f => { listeners.push(f); },
    current: () => current, db: () => db, auth: () => auth, problem: () => problem,
  };
})();
