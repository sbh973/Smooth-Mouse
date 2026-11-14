// popup.js — master on/off switch + live debug readout for the current tab.
const api = globalThis.browser ?? globalThis.chrome;

const masterBtn = document.getElementById("master");
const masterLabel = document.getElementById("master-label");
const statusEl = document.getElementById("status");
const fields = {
  pps: document.getElementById("pps"),
  clicks: document.getElementById("clicks"),
  dblclicks: document.getElementById("dblclicks"),
  keys: document.getElementById("keys"),
  recent: document.getElementById("recent"),
};

// --- Master switch (stored in storage.local; content scripts listen for changes)
function showEnabled(enabled) {
  masterBtn.setAttribute("aria-checked", String(enabled));
  masterLabel.textContent = enabled ? "On" : "Off";
}

api.storage.local.get({ enabled: true }).then(({ enabled }) => showEnabled(enabled));

masterBtn.addEventListener("click", async () => {
  const next = masterBtn.getAttribute("aria-checked") !== "true";
  showEnabled(next);
  await api.storage.local.set({ enabled: next });
});

// --- Live stats: ask the content script in the active tab twice a second.
async function refresh() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const stats = await api.tabs.sendMessage(tab.id, { type: "sm:getStats" });
    if (!stats) throw new Error("no response");
    statusEl.textContent = stats.enabled ? "Capturing on this tab." : "Paused (switch is off).";
    statusEl.classList.remove("warn");
    fields.pps.textContent = stats.pointerPerSec;
    fields.clicks.textContent = stats.clicks;
    fields.dblclicks.textContent = stats.dblclicks;
    fields.keys.textContent = stats.keys;
    fields.recent.textContent = stats.recentSize;
  } catch {
    // Happens on browser pages (about:, chrome://, the add-ons store) where
    // extensions can't run, or on tabs opened before the extension was loaded.
    statusEl.textContent = "Not running on this tab. Try reloading the page.";
    statusEl.classList.add("warn");
    for (const el of Object.values(fields)) el.textContent = "–";
  }
}
refresh();
setInterval(refresh, 500);

document.getElementById("calibrate").addEventListener("click", () => {
  api.tabs.create({ url: api.runtime.getURL("calibrate/calibrate.html") });
  window.close();
});
