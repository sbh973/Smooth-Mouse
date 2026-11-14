// features.js — JavaScript twin of ml/features.py.
//
// It MUST compute exactly the same numbers as the Python version, step for
// step, or the model (trained in Python) will see different inputs in the
// browser. demo/parity.html checks this against shared/fixtures.json.
// If you change anything here, change ml/features.py the same way (and vice versa).
//
// Steps for one window:
//   1. cleanSamples   sort by time, drop duplicate timestamps (keep the last one)
//   2. resample       linear interpolation onto a fixed 100 Hz grid ending at tEnd
//   3. computeFeatures
//        mean_speed, speed_var, accel_var, jerk_rms  (log(1 + x) scaled)
//        reversals    sign flips of vx / vy, ignoring slow speeds
//        hf_ratio     share of velocity power in the 4-12 Hz tremor band
//        band_amp     log(1 + sqrt(band power)): how STRONG the 4-12 Hz movement is

(() => {
  const SM = (window.SmoothMouse = window.SmoothMouse || {});

  const FEATURE_NAMES = ["mean_speed", "speed_var", "accel_var", "jerk_rms", "reversals", "hf_ratio", "band_amp"];

  function windowSamples(cfg) {
    // Python: int(round(windowMs * rate / 1000)). Our values are never x.5, so Math.round matches.
    return Math.round((cfg.windowMs * cfg.sampleRateHz) / 1000);
  }

  // --- small array helpers (numpy equivalents) -----------------------------
  const diff = (a, scale) => {
    const out = new Array(a.length - 1);
    for (let i = 0; i < out.length; i++) out[i] = (a[i + 1] - a[i]) * scale;
    return out;
  };
  const mean = (a) => {
    let s = 0;
    for (const v of a) s += v;
    return s / a.length;
  };
  // Population variance (numpy's default, ddof = 0), computed in two passes like numpy.
  const variance = (a) => {
    const m = mean(a);
    let s = 0;
    for (const v of a) s += (v - m) * (v - m);
    return s / a.length;
  };

  /** Sort by time (stable) and keep only the LAST sample of equal-timestamp runs. */
  function cleanSamples(t, x, y) {
    const idx = t.map((_, i) => i).sort((a, b) => t[a] - t[b]); // Array.sort is stable
    const ct = [], cx = [], cy = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const next = idx[k + 1];
      if (next !== undefined && t[next] === t[i]) continue; // a later sample has the same time
      ct.push(t[i]); cx.push(x[i]); cy.push(y[i]);
    }
    return [ct, cx, cy];
  }

  /** Same as numpy.interp: linear between samples, clamped at both ends. */
  function interp(g, t, v) {
    const n = t.length;
    if (g <= t[0]) return v[0];
    if (g >= t[n - 1]) return v[n - 1];
    // binary search: t[lo] <= g < t[lo + 1]
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= g) lo = mid;
      else hi = mid;
    }
    const slope = (v[lo + 1] - v[lo]) / (t[lo + 1] - t[lo]);
    return slope * (g - t[lo]) + v[lo];
  }

  function resample(t, x, y, tEnd, cfg) {
    const n = windowSamples(cfg);
    const dtMs = 1000 / cfg.sampleRateHz;
    const xr = new Array(n), yr = new Array(n);
    for (let k = 0; k < n; k++) {
      const g = tEnd - dtMs * (n - 1 - k);
      xr[k] = interp(g, t, x);
      yr[k] = interp(g, t, y);
    }
    return [xr, yr];
  }

  function hann(m) {
    if (m === 1) return [1];
    const w = new Array(m);
    for (let n = 0; n < m; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (m - 1));
    return w;
  }

  /**
   * [power inside [lo, hi] Hz, total power excluding 0 Hz].
   * Python uses np.fft.rfft; with only ~24 points a direct DFT is just as fast
   * and gives the same numbers (within floating-point rounding).
   */
  function bandPower(signal, rateHz, loHz, hiHz) {
    const m = signal.length;
    const mu = mean(signal);
    const w = hann(m);
    const s = signal.map((v, i) => (v - mu) * w[i]);
    let band = 0, total = 0;
    for (let k = 0; k <= Math.floor(m / 2); k++) {
      let re = 0, im = 0;
      for (let n = 0; n < m; n++) {
        const angle = (2 * Math.PI * k * n) / m;
        re += s[n] * Math.cos(angle);
        im -= s[n] * Math.sin(angle);
      }
      const p = re * re + im * im;
      const freq = (k * rateHz) / m;
      if (freq >= loHz && freq <= hiHz) band += p;
      if (k >= 1) total += p;
    }
    return [band, total];
  }

  function countReversals(v, minSpeed) {
    let count = 0, lastSign = 0;
    for (const value of v) {
      if (Math.abs(value) < minSpeed) continue;
      const sign = value > 0 ? 1 : -1;
      if (lastSign !== 0 && sign !== lastSign) count++;
      lastSign = sign;
    }
    return count;
  }

  function computeFeatures(xr, yr, cfg) {
    const rate = cfg.sampleRateHz;
    const vx = diff(xr, rate), vy = diff(yr, rate); // diff / dt  ==  diff * rate
    const ax = diff(vx, rate), ay = diff(vy, rate);
    const jx = diff(ax, rate), jy = diff(ay, rate);
    const speed = vx.map((v, i) => Math.sqrt(v * v + vy[i] * vy[i]));

    const meanSpeed = Math.log1p(mean(speed));
    const speedVar = Math.log1p(variance(speed));
    const accelVar = Math.log1p(variance(ax) + variance(ay));
    const jerkRms = Math.log1p(Math.sqrt(mean(jx.map((v, i) => v * v + jy[i] * jy[i]))));

    const minSpeed = cfg.reversalMinSpeedPxPerSec;
    const reversals = countReversals(vx, minSpeed) + countReversals(vy, minSpeed);

    const [lo, hi] = cfg.tremorBandHz;
    const [bx, tx] = bandPower(vx, rate, lo, hi);
    const [by, ty] = bandPower(vy, rate, lo, hi);
    const total = tx + ty;
    const hfRatio = total > 1e-9 ? (bx + by) / total : 0;
    const bandAmp = Math.log1p(Math.sqrt(bx + by));

    return [meanSpeed, speedVar, accelVar, jerkRms, reversals, hfRatio, bandAmp];
  }

  /** Raw samples (t in ms, x, y in px) -> feature array, ordered like FEATURE_NAMES. */
  function windowFeatures(t, x, y, tEnd, cfg) {
    let [ct, cx, cy] = cleanSamples(t, x, y);
    const start = tEnd - cfg.windowMs - cfg.marginMs;
    const keep = ct.map((v) => v >= start && v <= tEnd);
    ct = ct.filter((_, i) => keep[i]);
    cx = cx.filter((_, i) => keep[i]);
    cy = cy.filter((_, i) => keep[i]);
    if (ct.length === 0) return FEATURE_NAMES.map(() => 0); // still cursor
    const [xr, yr] = resample(ct, cx, cy, tEnd, cfg);
    return computeFeatures(xr, yr, cfg);
  }

  SM.features = { FEATURE_NAMES, windowFeatures, cleanSamples, resample, computeFeatures };
})();
