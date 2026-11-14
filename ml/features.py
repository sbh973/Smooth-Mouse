"""Feature extraction for Smooth Mouse.

Turns a short window of raw pointer samples (t in ms, x, y in CSS px) into a
small vector of numbers the classifier can use.

IMPORTANT: content/features.js (Checkpoint 3) must do EXACTLY the same steps,
in the same order, with the same constants. Any change here must be copied
there, and `python ml/train.py` re-run so shared/fixtures.json is refreshed.
The parity test page (demo/parity.html) checks that the two versions agree.

Pipeline for one window:
  1. clean_samples   sort by time, drop duplicate timestamps (keep the last one)
  2. resample        linear interpolation onto a fixed 100 Hz grid ending at t_end
  3. compute_features
        velocity      v = diff(position) / dt                     (px/s)
        acceleration  a = diff(v) / dt                            (px/s^2)
        jerk          j = diff(a) / dt                            (px/s^3)
     -> mean_speed     log(1 + mean |v|)
     -> speed_var      log(1 + variance of |v|)
     -> accel_var      log(1 + var(ax) + var(ay))
     -> jerk_rms       log(1 + sqrt(mean(jx^2 + jy^2)))
     -> reversals      how often vx or vy flips sign (ignoring near-zero speeds)
     -> hf_ratio       share of velocity power inside the tremor band (4-12 Hz)

Why log(1 + ...)? Speeds and variances range over several orders of magnitude
(a still cursor vs a fast flick). Logs squash that range so a linear model can
use them, and log(1 + 0) = 0 keeps a perfectly still cursor well defined.
"""

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "shared" / "config.json"

FEATURE_NAMES = [
    "mean_speed",
    "speed_var",
    "accel_var",
    "jerk_rms",
    "reversals",
    "hf_ratio",
]


def load_config():
    return json.loads(CONFIG_PATH.read_text())


def window_samples(cfg):
    """Number of points on the resampled grid (250 ms at 100 Hz -> 25)."""
    return int(round(cfg["windowMs"] * cfg["sampleRateHz"] / 1000))


def clean_samples(t, x, y):
    """Sort by time and keep only the LAST sample of any equal-timestamp run.

    Browsers sometimes deliver two samples with the same (rounded) timestamp.
    Interpolation needs strictly increasing times.
    """
    t = np.asarray(t, dtype=float)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    order = np.argsort(t, kind="stable")
    t, x, y = t[order], x[order], y[order]
    keep = np.append(t[1:] != t[:-1], True)  # True where the next t is different
    return t[keep], x[keep], y[keep]


def resample(t, x, y, t_end, cfg):
    """Linear interpolation onto an evenly spaced grid that ends at t_end.

    Grid points before the first sample take the first sample's value, and
    points after the last sample take the last value (np.interp clamps).
    That is what we want: no events = the cursor did not move.
    """
    n = window_samples(cfg)
    dt_ms = 1000.0 / cfg["sampleRateHz"]
    grid = t_end - dt_ms * np.arange(n - 1, -1, -1)
    return np.interp(grid, t, x), np.interp(grid, t, y)


def hann(m):
    """Hann window, same formula as np.hanning (written out for JS parity)."""
    if m == 1:
        return np.ones(1)
    n = np.arange(m)
    return 0.5 - 0.5 * np.cos(2 * np.pi * n / (m - 1))


def band_power(signal, rate_hz, lo_hz, hi_hz):
    """Return (power inside [lo, hi] Hz, total power excluding the 0 Hz bin).

    We remove the mean (a constant drift is not a tremor), taper the ends with
    a Hann window so the window edges don't create fake high frequencies, then
    take the power spectrum |FFT|^2.
    """
    m = len(signal)
    s = (signal - signal.mean()) * hann(m)
    power = np.abs(np.fft.rfft(s)) ** 2
    freqs = np.arange(len(power)) * rate_hz / m  # same as np.fft.rfftfreq(m, 1/rate)
    in_band = (freqs >= lo_hz) & (freqs <= hi_hz)
    return power[in_band].sum(), power[1:].sum()


def count_reversals(v, min_speed):
    """Count sign flips in a velocity component, skipping |v| < min_speed.

    Tremor makes the cursor go back and forth many times per second. The
    min_speed dead-band stops tiny sensor noise from counting as reversals.
    """
    count = 0
    last_sign = 0
    for value in v:
        if abs(value) < min_speed:
            continue
        sign = 1 if value > 0 else -1
        if last_sign != 0 and sign != last_sign:
            count += 1
        last_sign = sign
    return count


def compute_features(xr, yr, cfg):
    """Feature vector (ordered like FEATURE_NAMES) for a resampled window."""
    rate = cfg["sampleRateHz"]
    dt = 1.0 / rate

    vx, vy = np.diff(xr) / dt, np.diff(yr) / dt
    ax, ay = np.diff(vx) / dt, np.diff(vy) / dt
    jx, jy = np.diff(ax) / dt, np.diff(ay) / dt
    speed = np.sqrt(vx**2 + vy**2)

    mean_speed = np.log1p(speed.mean())
    speed_var = np.log1p(speed.var())  # population variance (ddof=0), like JS
    accel_var = np.log1p(ax.var() + ay.var())
    jerk_rms = np.log1p(np.sqrt(np.mean(jx**2 + jy**2)))

    min_speed = cfg["reversalMinSpeedPxPerSec"]
    reversals = count_reversals(vx, min_speed) + count_reversals(vy, min_speed)

    lo, hi = cfg["tremorBandHz"]
    bx, tx = band_power(vx, rate, lo, hi)
    by, ty = band_power(vy, rate, lo, hi)
    total = tx + ty
    # A perfectly still cursor has no power at all; call that 0, not 0/0.
    hf_ratio = (bx + by) / total if total > 1e-9 else 0.0

    return np.array([mean_speed, speed_var, accel_var, jerk_rms, float(reversals), hf_ratio])


def window_features(t, x, y, t_end, cfg):
    """Raw samples -> features. Only samples inside [t_end - windowMs - marginMs, t_end] are used."""
    t, x, y = clean_samples(t, x, y)
    start = t_end - cfg["windowMs"] - cfg["marginMs"]
    mask = (t >= start) & (t <= t_end)
    t, x, y = t[mask], x[mask], y[mask]
    if len(t) == 0:
        # No movement at all in the window: a still cursor.
        return np.zeros(len(FEATURE_NAMES))
    xr, yr = resample(t, x, y, t_end, cfg)
    return compute_features(xr, yr, cfg)
