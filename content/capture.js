// capture.js — records raw pointer and keyboard input on every page.
//
// This is the very first stage of the Smooth Mouse pipeline:
//   Mouse movement (x, y, t) → [features] → [classifier] → [controller] → [stabilized cursor]
//
// We listen in the CAPTURE phase on window, so we see every event before the
// website does. That matters later, when we need to block shaky clicks or
// repeated keys before the page reacts to them.
//
// Everything stays in memory on this page. Nothing is sent anywhere.

(() => {
  const SM = (window.SmoothMouse = window.SmoothMouse || {});

  // How much history we keep.
  const RECENT_MS = 3000;    // "live" buffer the real-time pipeline reads (~3 s)
  const HISTORY_MS = 60000;  // longer pointer-only buffer used by "Export recording"

  /**
   * A time-based ring buffer: keeps only items newer than `maxAgeMs`.
   * Instead of calling array.shift() for every old item (slow), we move a
   * `start` index forward and compact the array once in a while.
   * Every item must have a `t` field (milliseconds, performance.now() clock).
   */
  class TimeBuffer {
    constructor(maxAgeMs) {
      this.maxAgeMs = maxAgeMs;
      this.items = [];
      this.start = 0;
    }
    push(item) {
      this.items.push(item);
      this.trim(item.t);
    }
    trim(now) {
      const cutoff = now - this.maxAgeMs;
      while (this.start < this.items.length && this.items[this.start].t < cutoff) {
        this.start++;
      }
      // Compact when more than half the array is dead space.
      if (this.start > 1024 && this.start * 2 > this.items.length) {
        this.items = this.items.slice(this.start);
        this.start = 0;
      }
    }
    /** All items with t >= sinceT, oldest first (returns a copy). */
    since(sinceT) {
      const out = [];
      for (let i = this.start; i < this.items.length; i++) {
        if (this.items[i].t >= sinceT) out.push(this.items[i]);
      }
      return out;
    }
    get size() {
      return this.items.length - this.start;
    }
  }

  const recent = new TimeBuffer(RECENT_MS);   // pointer + click + key events
  const history = new TimeBuffer(HISTORY_MS); // pointer samples only (for export)

  const counters = { pointerSamples: 0, clicks: 0, dblclicks: 0, keys: 0 };

  // Other modules (features, controller, ...) can subscribe to new samples.
  const listeners = new Set();
  function emit(sample) {
    for (const fn of listeners) {
      try { fn(sample); } catch (err) { console.error("[Smooth Mouse]", err); }
    }
  }

  function record(sample, keepInHistory) {
    recent.push(sample);
    if (keepInHistory) history.push(sample);
    emit(sample);
  }

  // --- Pointer events -------------------------------------------------------

  function onPointer(e) {
    // Ignore events created by scripts (isTrusted = false). Later checkpoints
    // re-dispatch clicks themselves; we must not count those twice.
    if (!SM.enabled || !e.isTrusted) return;

    const type = e.type === "pointermove" ? "move" : e.type === "pointerdown" ? "down" : "up";

    // Browsers batch several hardware samples into one pointermove per frame.
    // getCoalescedEvents() gives us all of them = higher sampling rate for the ML.
    let samples = [e];
    if (type === "move" && typeof e.getCoalescedEvents === "function") {
      const coalesced = e.getCoalescedEvents();
      if (coalesced && coalesced.length) samples = coalesced;
    }

    for (const s of samples) {
      counters.pointerSamples++;
      record(
        {
          // event.timeStamp uses the same clock as performance.now().
          t: s.timeStamp || performance.now(),
          type,
          x: s.clientX,
          y: s.clientY,
          buttons: s.buttons,
          pointerType: s.pointerType || e.pointerType,
        },
        true
      );
    }
  }

  // --- Click / key events ---------------------------------------------------

  function onClick(e) {
    if (!SM.enabled || !e.isTrusted) return;
    if (e.type === "click") counters.clicks++;
    else counters.dblclicks++;
    record({ t: performance.now(), type: e.type, x: e.clientX, y: e.clientY }, false);
  }

  function onKey(e) {
    if (!SM.enabled || !e.isTrusted) return;
    if (e.type === "keydown") counters.keys++;
    // We keep the key name only in the 3-second in-memory buffer; the
    // key-repeat filter (Checkpoint 6) needs it. It is never exported or sent.
    record({ t: performance.now(), type: e.type, key: e.key, repeat: e.repeat }, false);
  }

  const opts = { capture: true, passive: true };
  window.addEventListener("pointermove", onPointer, opts);
  window.addEventListener("pointerdown", onPointer, opts);
  window.addEventListener("pointerup", onPointer, opts);
  window.addEventListener("click", onClick, opts);
  window.addEventListener("dblclick", onClick, opts);
  window.addEventListener("keydown", onKey, opts);
  window.addEventListener("keyup", onKey, opts);

  // --- Public API for the other content scripts -----------------------------

  SM.enabled = true; // main.js overwrites this from storage
  SM.capture = {
    /** Live stats for the popup's debug readout. */
    getStats() {
      const now = performance.now();
      const lastSecond = recent.since(now - 1000);
      return {
        pointerPerSec: lastSecond.filter((s) => s.type === "move").length,
        clicks: counters.clicks,
        dblclicks: counters.dblclicks,
        keys: counters.keys,
        pointerSamples: counters.pointerSamples,
        recentSize: recent.size,
        historySize: history.size,
      };
    },
    /** Every event from the last ~3 s (oldest first). */
    getRecent() {
      return recent.since(performance.now() - RECENT_MS);
    },
    /** Raw pointer samples from the last `seconds` seconds (max 60). */
    getPointerHistory(seconds) {
      const ms = Math.min(seconds * 1000, HISTORY_MS);
      return history.since(performance.now() - ms);
    },
    /** Subscribe to every new sample. Returns an unsubscribe function. */
    onSample(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    HISTORY_MS,
  };
})();
