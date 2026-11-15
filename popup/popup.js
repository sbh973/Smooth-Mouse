// popup.js — on/off switches + live debug readout for the current tab.
const api = globalThis.browser ?? globalThis.chrome;

// --- Switches: every <button data-setting="..."> toggles that key in storage.local.
// Content scripts listen for storage changes, so pages update immediately.
const DEFAULTS = window.SmoothMouseDefaults; // from shared/settings.js
const switches = [...document.querySelectorAll("[data-setting]")];

function showSwitch(btn, on) {
  btn.setAttribute("aria-checked", String(on));
  const text = btn.querySelector(".switch-text");
  if (text) text.textContent = on ? "On" : "Off";
}

api.storage.local.get(DEFAULTS).then((settings) => {
  for (const btn of switches) showSwitch(btn, settings[btn.dataset.setting]);
});

for (const btn of switches) {
  btn.addEventListener("click", async () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    showSwitch(btn, next);
    await api.storage.local.set({ [btn.dataset.setting]: next });
  });
}

// --- Sliders: every <input type="range" data-range-setting="..."> stores a number.
for (const input of document.querySelectorAll("[data-range-setting]")) {
  const key = input.dataset.rangeSetting;
  const out = document.getElementById(input.id + "-value");
  const show = (v) => {
    input.value = v;
    out.textContent = `${v}%`;
    input.setAttribute("aria-valuetext", v == 0 ? "0 percent, adaptive only" : `${v} percent`);
  };
  api.storage.local.get({ [key]: DEFAULTS[key] }).then((st) => show(st[key]));
  input.addEventListener("input", () => {
    show(Number(input.value));
    api.storage.local.set({ [key]: Number(input.value) });
  });
}

// --- Live stats: ask the content script in the active tab twice a second.
const statusEl = document.getElementById("status");
const fields = {
  movement: document.getElementById("movement"),
  modelKind: document.getElementById("model-kind"),
  pps: document.getElementById("pps"),
  clicks: document.getElementById("clicks"),
  dblclicks: document.getElementById("dblclicks"),
  keys: document.getElementById("keys"),
  recent: document.getElementById("recent"),
};

async function refresh() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const stats = await api.tabs.sendMessage(tab.id, { type: "sm:getStats" });
    if (!stats) throw new Error("no response");
    statusEl.textContent = stats.enabled ? "Capturing on this tab." : "Paused (switch is off).";
    statusEl.classList.remove("warn");
    fields.movement.textContent = stats.movement ?? "loading…";
    fields.movement.dataset.label = stats.movement ?? "";
    fields.modelKind.textContent = stats.modelKind ?? "loading…";
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

// --- When was the last calibration?
api.storage.local.get({ profile: null }).then(({ profile }) => {
  const info = document.getElementById("calibration-info");
  if (!profile) {
    info.textContent = "Not calibrated yet. Calibrating tunes Smooth Mouse to your hand.";
    return;
  }
  const when = new Date(profile.calibratedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  info.textContent = `Calibrated ${when}` + (profile.personalModel ? " (personal model)." : " (default model, tuned settings).");
});
