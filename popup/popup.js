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

/** Words for the simulator's shake strength. */
function shakeLevel(px) {
  return px <= 6 ? "light" : px <= 16 ? "medium" : px <= 28 ? "strong" : px <= 50 ? "very strong" : "extreme";
}

// --- Sliders: every <input type="range" data-range-setting="..."> stores a number.
for (const input of document.querySelectorAll("[data-range-setting]")) {
  const key = input.dataset.rangeSetting;
  const out = document.getElementById(input.id + "-value");
  const unit = input.dataset.unit || "%";
  const show = (v) => {
    input.value = v;
    out.textContent = unit === "px" ? `${v} px (${shakeLevel(v)})` : `${v}%`;
    input.setAttribute("aria-valuetext", unit === "px" ? `${v} pixels, ${shakeLevel(v)}`
      : v == 0 ? "0 percent, adaptive only" : `${v} percent`);
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
  clicksIgnored: document.getElementById("clicks-ignored"),
  keysFiltered: document.getElementById("keys-filtered"),
  recent: document.getElementById("recent"),
};

// --- Risky buttons found on this page (word list + Gemini), on ANY website.
let lastRiskyKey = "";
function renderRisky(r) {
  const status = document.getElementById("risky-status");
  const list = document.getElementById("risky-list");
  if (!r) { status.textContent = "Not available on this page."; list.innerHTML = ""; return; }
  const geminiText = {
    idle: "", asking: " Asking Gemini about the rest…",
    ok: ` Gemini checked ${r.checkedByGemini} other button${r.checkedByGemini === 1 ? "" : "s"}.`,
    off: " Gemini is off (start the local server), so only the word list is used.",
  }[r.state] || "";
  status.textContent = (r.flagged.length
    ? `${r.flagged.length} risky button${r.flagged.length === 1 ? "" : "s"} on this page. A shaky click on these asks first.`
    : "No risky buttons found on this page.") + geminiText;
  const key = JSON.stringify(r.flagged);
  if (key === lastRiskyKey) return; // don't rebuild the list twice a second
  lastRiskyKey = key;
  list.innerHTML = "";
  for (const f of r.flagged) {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = f.label;
    const src = document.createElement("span");
    src.className = "src" + (f.source === "gemini" ? " gemini" : "");
    src.textContent = f.source === "gemini" ? "Gemini" : "word list";
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = f.reason;
    li.append(name, src, why);
    list.appendChild(li);
  }
}

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
    fields.clicksIgnored.textContent = stats.clicksIgnored ?? 0;
    fields.keysFiltered.textContent = stats.keysFiltered ?? 0;
    renderRisky(stats.risky);
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

// --- Hold period: chosen by calibration, with a manual override slider.
const holdSlider = document.getElementById("hold-slider");
const holdValue = document.getElementById("hold-value");
const holdSource = document.getElementById("hold-source");
const holdReset = document.getElementById("hold-reset");
const DEFAULT_HOLD_MS = 150;

async function showHold() {
  const { profile, holdOverrideMs } = await api.storage.local.get({ profile: null, holdOverrideMs: null });
  const calibrated = profile && profile.clickHold ? profile.clickHold : null;
  const ms = typeof holdOverrideMs === "number" ? holdOverrideMs : calibrated ? calibrated.left : DEFAULT_HOLD_MS;
  holdSlider.value = ms;
  holdValue.textContent = `${(ms / 1000).toFixed(2)} s`;
  holdSlider.setAttribute("aria-valuetext", `${(ms / 1000).toFixed(2)} seconds`);
  if (typeof holdOverrideMs === "number") {
    holdSource.textContent = calibrated
      ? `Set by you. Calibration chose ${(calibrated.left / 1000).toFixed(2)} s.`
      : "Set by you.";
    holdReset.hidden = !calibrated;
  } else if (calibrated) {
    holdSource.textContent = `Chosen by calibration. ${calibrated.reason}`;
    holdReset.hidden = true;
  } else {
    holdSource.textContent = "Standard value. Calibrate so Smooth Mouse can pick one for your hand.";
    holdReset.hidden = true;
  }
}
holdSlider.addEventListener("input", () => {
  const ms = Number(holdSlider.value);
  holdValue.textContent = `${(ms / 1000).toFixed(2)} s`;
  api.storage.local.set({ holdOverrideMs: ms }).then(showHold);
});
holdReset.addEventListener("click", () => api.storage.local.set({ holdOverrideMs: null }).then(showHold));
showHold();
