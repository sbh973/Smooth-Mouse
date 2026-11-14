// viz.js — demo-page visualization: raw vs stabilized trails + live metrics.
//
// Only runs on pages with <meta name="smooth-mouse-demo">. It draws on a
// full-screen transparent canvas (pointer-events: none) so you see both
// trails right where you move, and it writes the numbers into the demo page's
// "Stabilization" panel (elements with id="sm-metric-...").
//
// Metrics (over the last 1.5 s):
//   Jitter      RMS distance between the path and its own 150 ms moving
//               average = how much fast back-and-forth wobble is left.
//               Reported for raw and stabilized, plus the % reduction.
//   Added lag   how far the steady cursor trails the real one ALONG the
//               direction of travel, divided by speed = milliseconds behind.

(() => {
  const SM = window.SmoothMouse;
  const isDemoPage = () => !!document.querySelector('meta[name="smooth-mouse-demo"]');

  const VIEW_MS = 1500;
  let canvas = null, ctx = null;

  function trailsWanted() {
    const box = document.getElementById("sm-show-trails");
    return SM.enabled && SM.settings && SM.settings.stabilize && box && box.checked;
  }

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "sm-viz-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext("2d");
  }

  function draw() {
    const wanted = trailsWanted();
    if (!wanted) {
      if (canvas) canvas.hidden = true;
      return;
    }
    ensureCanvas();
    canvas.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const now = performance.now();
    const pts = SM.stabilize.trail.filter((p) => p.t >= now - VIEW_MS);
    if (pts.length < 2) return;
    const line = (key, color, width) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[key + "x"], p[key + "y"]) : ctx.moveTo(p[key + "x"], p[key + "y"])));
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    };
    line("r", "rgba(180, 68, 26, 0.75)", 2);   // raw: orange
    line("s", "rgba(15, 118, 110, 0.95)", 3.5); // stabilized: teal
  }

  // --- Metrics --------------------------------------------------------------
  function jitterRms(pts, key) {
    // Distance from each point to the average of its neighbours within ±75 ms.
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      let mx = 0, my = 0, n = 0;
      for (let j = 0; j < pts.length; j++) {
        if (Math.abs(pts[j].t - pts[i].t) <= 75) {
          mx += pts[j][key + "x"];
          my += pts[j][key + "y"];
          n++;
        }
      }
      const dx = pts[i][key + "x"] - mx / n, dy = pts[i][key + "y"] - my / n;
      sum += dx * dx + dy * dy;
    }
    return Math.sqrt(sum / pts.length);
  }

  function addedLagMs(pts) {
    let total = 0, n = 0, j = 0;
    for (let i = 0; i < pts.length; i++) {
      while (j < i && pts[j].t < pts[i].t - 50) j++; // raw position ~50 ms earlier
      const dt = (pts[i].t - pts[j].t) / 1000;
      if (dt < 0.02) continue;
      const vx = (pts[i].rx - pts[j].rx) / dt, vy = (pts[i].ry - pts[j].ry) / dt;
      const speed = Math.hypot(vx, vy);
      if (speed < 150) continue; // lag only means something while moving
      const along = ((pts[i].rx - pts[i].sx) * vx + (pts[i].ry - pts[i].sy) * vy) / speed;
      total += Math.max(0, along / speed) * 1000;
      n++;
    }
    return n ? total / n : null;
  }

  let lastLag = null;

  function updateMetrics() {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const st = SM.stabilize;
    if (!SM.enabled || !SM.settings.stabilize) {
      set("sm-metric-strength", "off");
      return;
    }
    set("sm-metric-class", SM.live.ready ? SM.live.label : "loading…");
    set("sm-metric-strength", `${Math.round(st.strength * 100)}% (${st.level})`);

    const now = performance.now();
    const pts = st.trail.filter((p) => p.t >= now - VIEW_MS);
    if (pts.length > 10) {
      const raw = jitterRms(pts, "r"), steady = jitterRms(pts, "s");
      set("sm-metric-jitter", raw < 0.5
        ? "no wobble right now"
        : `${raw.toFixed(1)} px → ${steady.toFixed(1)} px (−${Math.max(0, Math.round((1 - steady / raw) * 100))}%)`);
      const lag = addedLagMs(pts);
      if (lag !== null) lastLag = lag;
    }
    if (lastLag !== null) set("sm-metric-lag", `${Math.round(lastLag)} ms`);
  }

  // --- Start (demo page only) --------------------------------------------------
  function start() {
    if (!isDemoPage()) return;
    const loop = () => {
      draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setInterval(updateMetrics, 250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
