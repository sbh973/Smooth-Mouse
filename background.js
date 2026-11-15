// background.js — the extension's only connection to the local server.
//
// Web pages (and our content scripts on them) never talk to localhost
// directly. When risky.js wants Gemini's opinion on a page's buttons, it
// sends the button LABELS (and small icon images) here; we check our cache,
// ask the local server for anything new, save the answers, and reply.
//
// If the server is off or slow, we reply with an error and risky.js quietly
// keeps using its built-in word list.

const api = globalThis.browser ?? globalThis.chrome;
const SERVER = "http://localhost:8000";
const CACHE_MAX = 800;

async function fetchWithTimeout(url, body, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Same button text + label + icon = same answer, on any site. */
const signature = (b) => [b.text, b.ariaLabel, b.title, b.nearbyText, b.iconPng ? b.iconPng.length + ":" + b.iconPng.slice(-40) : ""].join("|");

// After a failure (server off, Gemini busy or out of quota), don't ask again
// for 2 minutes: the word list covers us meanwhile.
let backoffUntil = 0;

async function classify({ buttons, pageTitle }) {
  const { riskyCache = {} } = await api.storage.local.get({ riskyCache: {} });
  const results = {};
  const todo = [];
  for (const b of buttons) {
    const hit = riskyCache[signature(b)];
    if (hit) results[b.id] = { ...hit, cached: true };
    else todo.push(b);
  }
  if (todo.length) {
    if (Date.now() < backoffUntil) throw new Error("backing off after a recent failure");
    // Pre-classification on page load: never in the click path, so we can wait a bit.
    let reply;
    try {
      reply = await fetchWithTimeout(`${SERVER}/gemini/risky`, { pageTitle, buttons: todo }, 15000);
    } catch (err) {
      backoffUntil = Date.now() + 2 * 60 * 1000;
      throw err;
    }
    for (const b of todo) {
      const r = reply.results && reply.results[b.id];
      if (!r) continue;
      results[b.id] = r;
      riskyCache[signature(b)] = { risky: r.risky, action: r.action, reason: r.reason, model: r.model };
    }
    const keys = Object.keys(riskyCache);
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete riskyCache[k];
    await api.storage.local.set({ riskyCache });
  }
  return results;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "sm:classify") return;
  classify(msg)
    .then((results) => sendResponse({ ok: true, results }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // we answer asynchronously
});
