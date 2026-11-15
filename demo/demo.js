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
document.getElementById("delete").addEventListener("click", () => say("Draft deleted (demo only)."));
document.querySelectorAll(".toolbar button, .topbar .tiny").forEach((btn) =>
  btn.addEventListener("click", () => say(`Clicked "${btn.getAttribute("aria-label")}".`))
);

// --- Bridge to the extension -----------------------------------------------
const extStatus = document.getElementById("ext-status");
const exportStatus = document.getElementById("export-status");
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

async function checkExtension() {
  try {
    const pong = await ask("ping", "pong");
    extStatus.textContent = pong.enabled
      ? "Smooth Mouse is running on this page."
      : "Smooth Mouse is installed but switched off in the popup.";
    extStatus.className = pong.enabled ? "status ok" : "status warn";
  } catch {
    extStatus.textContent = "Smooth Mouse not detected. Load the extension, then reload this page.";
    extStatus.className = "status warn";
  }
}
checkExtension();
setInterval(checkExtension, 3000);

// --- Export recording --------------------------------------------------------
document.getElementById("export").addEventListener("click", async () => {
  const seconds = Number(document.getElementById("export-seconds").value);
  try {
    const { recording } = await ask("export-request", "export-response", { seconds });
    if (!recording.sampleCount) {
      exportStatus.textContent = `No pointer samples in the last ${seconds} s. Move the mouse over this page first. (Samples since load: ${recording.debug.pointerSamplesSinceLoad})`;
      exportStatus.className = "status warn";
      return;
    }
    const blob = new Blob([JSON.stringify(recording, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smooth-mouse-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportStatus.textContent = `Exported ${recording.sampleCount} pointer samples from the last ${seconds} s.`;
    exportStatus.className = "status ok";
  } catch {
    exportStatus.textContent = "Couldn't reach Smooth Mouse. Is the extension loaded and switched on?";
    exportStatus.className = "status warn";
  }
});
