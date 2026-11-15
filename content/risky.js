// risky.js — "Did you mean to click 'Send'?"
//
// Some buttons are dangerous to click by accident: Send, Delete, Buy, Transfer…
// If a click lands on one of those while the hand is shaking (the ML model
// said unstable/uncertain in the last second, or the steady cursor is on),
// we pause and ask first, with big "Yes" / "No, go back" buttons.
//
// Which buttons are risky?
//   1. A built-in WORD LIST (send, delete, buy, pay, …) decides instantly.
//   2. Everything the list can't decide is sent, as labels only, to GEMINI
//      (through background.js and the local server) when the page loads, in
//      one batch. Icon-only buttons (e.g. a trash can) are sent as a small
//      image so Gemini can recognise them. Answers are cached.
// At click time we only look up answers we already have: the dialog never
// waits on the network. With the server off, the word list still works.
//
// Privacy: Gemini gets button labels, nearby button labels and icon images,
// never typed text, page content or movement data.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  const BUTTONS = 'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';
  const OURS = ".sm-dialog, .sm-badge, .sm-toast, .sm-cursor, .sm-hold-ring";

  // --- 1. Word list ------------------------------------------------------------
  // Also the wording real shops use ("Place your order", "Buy now", "Check out", "Pay now"…).
  const RISKY_WORDS = /\b(send|delete|remove|trash|buy|purchase|pay|place (?:your )?order|order now|book now|checkout|check out|submit|confirm|transfer|unsubscribe|post|publish|donate)\b/i;
  // In class/id names only specific words count: "submit"/"confirm" are used for
  // every form button (e.g. Amazon's search "Go"), so they only count in visible labels.
  const RISKY_TOKENS = new Set(["send", "delete", "remove", "trash", "buy", "purchase", "pay", "checkout", "transfer", "unsubscribe", "publish", "donate"]);
  // Never risky: search boxes. Never worth asking Gemini about: obviously safe buttons.
  const isSearch = (el) => !!(el.closest('[role="search"], search') ||
    /search/i.test(`${el.id} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("name") || ""} ${el.getAttribute("aria-label") || ""}`));
  const OBVIOUSLY_SAFE = /^(search|go|menu|close|×|x|next|previous|prev|back|more|less|show more|see more|see all|view all|sign in|log in|login|sign up|register|help|share|like|follow|filter|sort|cancel|ok|got it|accept|dismiss|open|expand|collapse|play|pause|mute|unmute|zoom|add to cart|add to bag|add to list|add to wishlist|wishlist|save|view|details|learn more|read more|skip|home|account|cart)$/i;
  const ACTION_OF = [
    [/send|post|publish/i, "send"],
    [/delete|remove|trash|unsubscribe/i, "delete"],
    [/buy|purchase|pay|order|checkout|check out|transfer|donate/i, "purchase"],
    [/submit|confirm/i, "submit"],
  ];

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
  function labelOf(el) {
    // aria-labelledby: the label lives in another element (e.g. Amazon's "Buy Now" button).
    const ids = el.getAttribute("aria-labelledby");
    const labelled = ids ? ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(" ") : "";
    return clean(el.getAttribute("aria-label") || labelled || el.innerText || el.value || el.getAttribute("title") ||
      (el.querySelector && el.querySelector("img[alt]") && el.querySelector("img[alt]").alt) || "");
  }

  function wordListVerdict(el) {
    if (isSearch(el)) return null;
    const words = [labelOf(el), el.getAttribute("title"), el.getAttribute("aria-label"), el.value].filter(Boolean).join(" ");
    let match = words.match(RISKY_WORDS);
    if (!match) {
      // class / id like "btn-delete" ("post" skipped here: "post-title" is common)
      const tokens = `${el.id} ${typeof el.className === "string" ? el.className : ""}`.toLowerCase().split(/[^a-z]+/);
      const tok = tokens.find((t) => RISKY_TOKENS.has(t));
      if (tok) match = [tok];
    }
    if (!match) return null;
    const action = (ACTION_OF.find(([re]) => re.test(match[0])) || [null, "other"])[1];
    return { risky: true, action, reason: `The label contains "${match[0].toLowerCase()}".`, source: "words" };
  }

  // --- What we know about each button ------------------------------------------
  const verdicts = new WeakMap(); // element → { risky, action, reason, source }
  const asked = new WeakSet();    // elements already sent to Gemini
  let geminiState = "idle";       // idle | asking | ok | off
  const scanLog = [];             // for the demo page's "Gemini page scan" panel

  function verdictFor(el) {
    if (verdicts.has(el)) return verdicts.get(el);
    const v = wordListVerdict(el);
    if (v) verdicts.set(el, v);
    return v;
  }

  // --- 2. Gemini pre-classification (labels + icons only) ----------------------
  function nearbyText(el) {
    // Labels of up to 3 sibling buttons + the nearest heading: context, not content.
    const parent = el.parentElement;
    const sibs = parent ? [...parent.querySelectorAll(BUTTONS)].filter((b) => b !== el).slice(0, 3).map(labelOf) : [];
    const section = el.closest("section, form, aside, article, [role=dialog]");
    const heading = section && section.querySelector("h1, h2, h3, legend");
    return clean([heading && heading.textContent, ...sibs].filter(Boolean).join(" · "));
  }

  /** Small PNG of an icon-only button's SVG, so Gemini can see what it is. */
  function iconPng(el) {
    const svg = el.querySelector("svg");
    if (!svg) return Promise.resolve("");
    return new Promise((resolve) => {
      try {
        const copy = svg.cloneNode(true);
        copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        copy.setAttribute("width", "48");
        copy.setAttribute("height", "48");
        copy.setAttribute("color", getComputedStyle(el).color || "#000");
        const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement("canvas");
            c.width = c.height = 48;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, 48, 48);
            ctx.drawImage(img, 0, 0, 48, 48);
            resolve(c.toDataURL("image/png").split(",")[1]);
          } catch { resolve(""); }
        };
        img.onerror = () => resolve("");
        img.src = url;
      } catch { resolve(""); }
    });
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > -300 && r.top < innerHeight + 300 &&
      !el.disabled && !el.closest(OURS);
  };
  const GEMINI_GAP_MS = 5000; // at most one Gemini request per page every 5 s
  const GEMINI_BATCH = 25;
  let lastGeminiAt = -Infinity;

  let scanTimer = null;
  function scheduleScan(delay = 1200) {
    if (scanTimer) return; // already scheduled: don't keep postponing it
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  async function scan() {
    if (!SM.enabled || !SM.settings || !SM.settings.riskyConfirm) return;
    // The word list is instant, so it checks EVERY button on screen; only the
    // Gemini batch is limited (big shops have hundreds of buttons).
    const fresh = [...document.querySelectorAll(BUTTONS)].filter((el) => visible(el) && !asked.has(el));
    // Word-list matches are decided locally; only the undecided ones go to Gemini.
    const undecided = [];
    for (const el of fresh) {
      asked.add(el);
      const v = verdictFor(el);
      if (v) scanLog.push({ label: labelOf(el) || "Icon-only button", ...v });
      else undecided.push(el);
    }
    renderScan();
    // Nothing to classify: no label and no icon.
    const askable = undecided.filter((el) => {
      if (isSearch(el)) return false;
      const label = labelOf(el);
      if (!label) return !!el.querySelector("svg");          // icon-only: Gemini looks at the icon
      return label.length > 1 && !OBVIOUSLY_SAFE.test(label) && !/^\d+$/.test(label); // skip "Next", "3", …
    });
    if (!askable.length || !SM.settings.useGemini) return;
    const wait = lastGeminiAt + GEMINI_GAP_MS - performance.now();
    if (wait > 0) {
      askable.forEach((el) => asked.delete(el)); // ask about these next time
      scheduleScan(wait);
      return;
    }
    if (askable.length > GEMINI_BATCH) askable.slice(GEMINI_BATCH).forEach((el) => asked.delete(el));
    undecided.length = 0;
    undecided.push(...askable.slice(0, GEMINI_BATCH));
    lastGeminiAt = performance.now();

    const ids = new Map();
    const buttons = await Promise.all(undecided.map(async (el, i) => {
      const id = "b" + i;
      ids.set(id, el);
      const text = clean(el.innerText || el.value);
      return {
        id, text,
        ariaLabel: clean(el.getAttribute("aria-label")),
        title: clean(el.getAttribute("title")),
        nearbyText: nearbyText(el),
        iconPng: text ? "" : await iconPng(el), // only icon-only buttons need a picture
      };
    }));
    geminiState = "asking";
    renderScan();
    let reply = null;
    try {
      reply = await api.runtime.sendMessage({ type: "sm:classify", pageTitle: clean(document.title), buttons });
    } catch { reply = null; }
    if (!reply || !reply.ok) {
      geminiState = "off";
      renderScan();
      return;
    }
    geminiState = "ok";
    for (const [id, r] of Object.entries(reply.results)) {
      const el = ids.get(id);
      if (!el) continue;
      const v = { risky: !!r.risky, action: r.action || "other", reason: r.reason || "", source: "gemini" };
      verdicts.set(el, v);
      scanLog.push({ label: labelOf(el) || "Icon-only button (no text)", ...v });
    }
    renderScan();
  }

  // Scan on load, when the user scrolls to new buttons, and whenever the page adds some.
  window.addEventListener("scroll", () => scheduleScan(800), { passive: true, capture: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scheduleScan(800));
  else scheduleScan(800);
  // Only real page changes count: ignore Smooth Mouse's own badge, cursor, toasts…
  // (the debug badge alone changes 20 times a second).
  const isOursNode = (n) => n.nodeType !== 1 ? (n.parentElement && n.parentElement.closest(OURS + ", .sm-viz-canvas")) : n.closest(OURS + ", .sm-viz-canvas");
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target.closest && m.target.closest(OURS + ", .sm-viz-canvas")) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !isOursNode(n)) return scheduleScan();
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  (SM.settingsListeners = SM.settingsListeners || []).push(() => scheduleScan(300));

  // --- Was the hand shaking just now? ------------------------------------------------
  let lastShakyAt = -Infinity;
  SM.live.onUpdate((live) => {
    if (live.label !== "stable") lastShakyAt = live.updatedAt;
  });
  const shakyNow = () =>
    performance.now() - lastShakyAt < 1000 || (SM.stabilize && SM.stabilize.engaged) || (SM.simulator && SM.simulator.on);

  // --- The dialog ---------------------------------------------------------------------
  const YES = { send: "Yes, send it", delete: "Yes, delete it", purchase: "Yes, pay", submit: "Yes, submit it", other: "Yes, continue" };
  let dialog = null;

  function confirmClick(el, verdict, onYes) {
    if (dialog) return; // one at a time
    const label = labelOf(el);
    const back = document.activeElement;
    dialog = document.createElement("div");
    dialog.className = "sm-dialog";
    dialog.innerHTML = `
      <div class="sm-dialog-box" role="alertdialog" aria-modal="true" aria-labelledby="sm-dialog-title" aria-describedby="sm-dialog-reason">
        <h2 id="sm-dialog-title"></h2>
        <p id="sm-dialog-reason"></p>
        <p class="sm-dialog-source"></p>
        <div class="sm-dialog-buttons">
          <button type="button" class="sm-dialog-no">No, go back</button>
          <button type="button" class="sm-dialog-yes"></button>
        </div>
      </div>`;
    // Icon-only buttons have no label: say what the button does instead.
    const DO = { send: "send this", delete: "delete this", purchase: "pay for this", submit: "submit this", other: "click this button" };
    dialog.querySelector("h2").textContent = label
      ? `Did you mean to click "${label}"?`
      : `Did you mean to ${DO[verdict.action] || DO.other}?`;
    dialog.querySelector("#sm-dialog-reason").textContent =
      verdict.source === "gemini" ? verdict.reason : "Your hand looked shaky, and this button can be hard to undo.";
    const src = dialog.querySelector(".sm-dialog-source");
    if (verdict.source === "gemini") {
      src.innerHTML = '<span class="sm-tag">Checked by Gemini</span>';
    } else {
      src.textContent = "Smooth Mouse spotted a risky word in this button.";
    }
    const yes = dialog.querySelector(".sm-dialog-yes");
    const no = dialog.querySelector(".sm-dialog-no");
    yes.textContent = YES[verdict.action] || YES.other;
    document.documentElement.appendChild(dialog);
    no.focus(); // the safe choice is the default

    const close = (doIt) => {
      dialog.remove();
      dialog = null;
      document.removeEventListener("keydown", onKey, true);
      if (back && back.focus) back.focus();
      if (doIt) onYes();
      else if (SM.toast) SM.toast("Okay, nothing was clicked.");
      SM.risky.confirmations++;
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(false); }
      else if (e.key === "Tab") { // keep focus inside the dialog
        e.preventDefault();
        (document.activeElement === yes ? no : yes).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    yes.addEventListener("click", () => close(true));
    no.addEventListener("click", () => close(false));
  }

  /** Click `el` now, unless it's risky and the hand was shaking: then ask first. */
  function guardedClick(el, x, y) {
    const target = el.closest ? el.closest(BUTTONS) || el : el;
    const v = SM.settings && SM.settings.riskyConfirm && !el.closest(OURS) ? verdictFor(target) : null;
    const click = () => {
      if (target.matches && target.matches("input, textarea, select, button, a[href], [tabindex]")) target.focus();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, detail: 1 }));
    };
    if (v && v.risky && shakyNow()) confirmClick(target, v, click);
    else click();
  }

  // Real clicks that nobody redirected (this listener runs after the
  // steady-cursor listener, which calls guardedClick itself).
  window.addEventListener("click", (e) => {
    if (!e.isTrusted || e.detail === 0 || e.button !== 0 || !SM.enabled || !SM.settings.riskyConfirm) return;
    if (e.target.closest && e.target.closest(OURS)) return;
    // Buttons, and also links that read like an action ("Checkout", "Buy now").
    const target = e.target.closest ? e.target.closest(BUTTONS + ", a[href]") : null;
    if (!target) return;
    const v = verdictFor(target);
    if (!v || !v.risky || !shakyNow()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    confirmClick(target, v, () => target.click());
  }, true);

  // --- Demo page: "Gemini page scan" panel --------------------------------------------
  function renderScan() {
    const box = document.getElementById("sm-gemini-scan");
    if (!box) return;
    const status = document.getElementById("sm-gemini-status");
    const fromGemini = scanLog.filter((r) => r.source === "gemini");
    if (status) {
      status.textContent = {
        idle: "Waiting to scan this page…",
        asking: "Asking Gemini about this page's buttons…",
        ok: `Gemini checked ${fromGemini.length} button${fromGemini.length === 1 ? "" : "s"} the word list couldn't decide and flagged ${fromGemini.filter((r) => r.risky).length} as risky.`,
        off: "Gemini isn't available (is the local server running?), so only the word list is used.",
      }[geminiState];
    }
    box.innerHTML = "";
    const rows = scanLog.filter((r) => r.risky);
    for (const r of rows) {
      const li = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = r.label;
      const tag = document.createElement("span");
      tag.className = r.source === "gemini" ? "scan-tag gemini" : "scan-tag words";
      tag.textContent = r.source === "gemini" ? "Gemini" : "word list";
      const why = document.createElement("span");
      why.className = "scan-why";
      why.textContent = r.reason;
      li.append(name, " ", tag, why);
      box.appendChild(li);
    }
  }

  /** For the popup: what the scan found on this page. */
  function summary() {
    const flagged = scanLog.filter((r) => r.risky).slice(0, 12).map(({ label, source, reason }) => ({ label, source, reason }));
    return { state: geminiState, checkedByGemini: scanLog.filter((r) => r.source === "gemini").length, flagged };
  }

  SM.risky = { guardedClick, verdictFor, summary, confirmations: 0 };
})();
