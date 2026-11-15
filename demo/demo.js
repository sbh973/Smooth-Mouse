// demo.js — behavior for the fake email page.
// This is an ordinary web page script, NOT extension code. It talks to the
// Smooth Mouse content script through window.postMessage (see content/main.js).

// --- Fake email actions (nothing is really sent or deleted) ----------------
const composeStatus = document.getElementById("compose-status");
let sayTimer = null;
/** Show what just happened, then clear it after 4 s so old messages never linger. */
function say(text, kind = "ok") {
  composeStatus.textContent = `${text} (${new Date().toLocaleTimeString()})`;
  composeStatus.className = `status ${kind}`;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    composeStatus.textContent = "";
    composeStatus.className = "status";
  }, 4000);
}
// Smooth Mouse tells this demo page when it ignores a click, so it's obvious nothing happened.
document.addEventListener("smoothmouse:ignored", () =>
  say("Smooth Mouse ignored that click, so nothing happened.", "warn")
);
document.getElementById("compose").addEventListener("submit", (e) => {
  e.preventDefault();
  say("Message sent (demo only, nothing was really sent).");
});
document.getElementById("save").addEventListener("click", () => say("Draft saved."));
document.getElementById("discard").addEventListener("click", () => say("Draft deleted (demo only)."));
document.querySelectorAll(".toolbar button, .topbar .tiny").forEach((btn) =>
  btn.addEventListener("click", () => say(`Clicked "${btn.getAttribute("aria-label")}".`))
);

// Every button flashes when it's clicked, so it's obvious which one received
// the click, even when Smooth Mouse redirected it (no :active state then).
document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("button");
  if (!btn) return;
  btn.classList.add("just-clicked");
  setTimeout(() => btn.classList.remove("just-clicked"), 350);
});

// --- Bridge to the extension -----------------------------------------------
const extStatus = document.getElementById("ext-status");
const pending = new Map(); // reply type -> resolve function

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.source !== "smooth-mouse-ext") return;
  const payload = JSON.parse(event.data.json);
  const resolve = pending.get(payload.type);
  if (resolve) {
    pending.delete(payload.type);
    resolve(payload);
  }
});

/** Send a request to the content script and wait for its reply (or time out). */
function ask(type, replyType, extra = {}, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    pending.set(replyType, resolve);
    window.postMessage({ source: "smooth-mouse-page", type, ...extra }, "*");
    setTimeout(() => {
      if (pending.get(replyType) === resolve) {
        pending.delete(replyType);
        reject(new Error("timeout"));
      }
    }, timeoutMs);
  });
}

// Shaky hand simulator button
const simBtn = document.getElementById("sim-toggle");
function showSim(on) {
  simBtn.setAttribute("aria-pressed", String(on));
  simBtn.textContent = on ? "Turn off shaky hand" : "Turn on shaky hand";
}
simBtn.addEventListener("click", async () => {
  const on = simBtn.getAttribute("aria-pressed") !== "true";
  try {
    await ask("set-simulator", "simulator", { on });
    showSim(on);
  } catch {
    extStatus.textContent = "Not detected";
    extStatus.className = "pill warn";
  }
});

// Shake strength slider (also in the popup)
const strength = document.getElementById("sim-strength");
const strengthOut = document.getElementById("sim-strength-value");
const level = (px) => (px <= 6 ? "light" : px <= 16 ? "medium" : px <= 28 ? "strong" : "very strong");
function showStrength(px) {
  strength.value = px;
  strengthOut.textContent = `${px} px (${level(px)})`;
  strength.setAttribute("aria-valuetext", `${px} pixels, ${level(px)}`);
}
let strengthDragging = false;
strength.addEventListener("input", () => {
  strengthDragging = true;
  showStrength(Number(strength.value));
  ask("set-sim-strength", "sim-strength", { px: Number(strength.value) }).catch(() => {});
});
strength.addEventListener("change", () => (strengthDragging = false));

async function checkExtension() {
  try {
    const pong = await ask("ping", "pong");
    showSim(!!pong.simulator);
    if (!strengthDragging && pong.simAmplitudePx) showStrength(pong.simAmplitudePx);
    extStatus.textContent = pong.enabled ? "Running" : "Switched off";
    extStatus.className = pong.enabled ? "pill ok" : "pill warn";
  } catch {
    extStatus.textContent = "Not detected";
    extStatus.title = "Load the extension, then reload this page.";
    extStatus.className = "pill warn";
  }
}
checkExtension();
setInterval(checkExtension, 3000);
