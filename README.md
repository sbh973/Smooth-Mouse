# Smooth Mouse

A browser extension (Firefox first, Chrome compatible) that helps people with hand tremors use the web. A small on-device ML model tells involuntary cursor fluctuations apart from intentional movement, and Smooth Mouse stabilizes the cursor only when it needs to.

> **Not a medical device.** The labels `stable`, `unstable` and `uncertain` are engineering labels for cursor movement, not medical diagnoses.

**Status:** Checkpoint 3: JS features, parity test and live inference. (See [CLAUDE.md](CLAUDE.md) for the full plan.)

## Project layout (so far)

```
manifest.json        Extension manifest (MV3, works in Firefox and Chrome)
content/capture.js   Records pointer, click and key events (capture phase, ~3 s buffer)
content/main.js      On/off switch, popup stats, demo-page "export recording" bridge
popup/               Toolbar popup: master switch + live debug readout
calibrate/           Calibration page (placeholder until Checkpoint 5)
demo/                Fake email compose page used for testing and the demo
shared/config.json   Window settings shared by Python and JS (rate, window, band)
shared/model.json    Trained classifier, exported for the browser
shared/fixtures.json Test windows + expected outputs for the JS parity test
ml/synth.py          Generates synthetic movement windows
ml/features.py       Window -> feature vector (mirrored later in content/features.js)
ml/train.py          Trains, evaluates, exports model + fixtures + charts
ml/plots/            Charts for the slides
content/features.js  JavaScript twin of ml/features.py
content/model.js     Runs model.json in the browser (standardize → logits → softmax)
content/live.js      Classifies the last 400 ms every 50 ms; debug badge
demo/parity.html     Checks JS features/probabilities match Python exactly
```

## Load the extension

### Firefox (main target)
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.
3. Pin the extension: click the puzzle-piece icon in the toolbar → gear → **Pin to Toolbar**.
4. After you change any code, click **Reload** on the about:debugging page, then reload the web page you're testing on.

If the popup says "Not running on this tab" on a normal website, open `about:addons` → Smooth Mouse → **Permissions** and turn on "Access your data for all websites."

### Chrome
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Chrome shows a harmless warning about `browser_specific_settings` (a Firefox-only key). Ignore it.

## Run the demo page

Content scripts don't run on extension pages, so serve the demo as a normal web page:

```bash
cd Smooth-Mouse            # the repo root
python3 -m http.server 5500
```

Then open <http://localhost:5500/demo/>.

## Test Checkpoint 1

1. Load the extension (above) and open the demo page. The right panel should say **"Smooth Mouse is running on this page."**
2. Click the Smooth Mouse toolbar icon. While the popup is open, move the mouse over the page:
   - **Pointer events / sec** should jump (often 60–250, depending on your mouse and browser).
   - Click and type in the email body; **Clicks** and **Keys pressed** go up.
   - (The popup closes when you click the page; reopen it to see updated totals.)
3. Toggle the switch **Off**: counts stop increasing and the demo page says it's switched off. Toggle it back **On**.
4. Wiggle the mouse for a few seconds, pick "Last 10 s", click **Export recording**. A `smooth-mouse-recording-….json` file downloads. Check that it's valid JSON:
   ```bash
   python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['sampleCount'], 'samples'); print(d['samples'][:3])" ~/Downloads/smooth-mouse-recording-*.json
   ```

### Recording format (`raw-pointer-v1`)
```json
{
  "app": "Smooth Mouse", "format": "raw-pointer-v1", "seconds": 10,
  "page": { "width": 1440, "height": 800, "devicePixelRatio": 2 },
  "sampleCount": 1234,
  "samples": [ { "t": 0, "x": 512, "y": 300, "type": "move", "buttons": 0, "pointerType": "mouse" } ]
}
```
`t` is milliseconds since the first sample. `x`/`y` are CSS pixels in the viewport. We use `getCoalescedEvents()` so we get every hardware sample, not just one per animation frame.

## Python ML pipeline

### One-time setup
From the repo root:
```bash
python3 -m venv .venv
source .venv/bin/activate          # do this in every new terminal
pip install -r ml/requirements.txt
```
If pip fails while "Building wheel for cryptography" (it tries to compile and needs Apple's developer tools), run `pip install --only-binary=:all: cryptography` and then the install line again.

### Train the model
```bash
python ml/train.py
```
Takes about a minute. It generates 9,000 synthetic windows (3,000 per class, fixed seed 42), trains, prints the metrics, and writes `shared/model.json`, `shared/fixtures.json` and `ml/plots/*.png`.

You can also pass exported recordings to see what the model thinks of real movement:
```bash
python ml/train.py ~/Downloads/smooth-mouse-recording-*.json
```

### How it works
1. **Synthetic data** (`synth.py`). `stable` = smooth minimum-jerk reaches (from slow moves up to fast 9,000 px/s flicks), overshoot corrections, holds and slow drags. `unstable` = the same plus a 4–10 Hz, 2–20 px oscillation. `uncertain` = very small oscillations (0.7–2 px) or fast intentional scribbles. Sampling copies a real Firefox recording: events every 7–10 ms, whole-ms timestamps with ±1.5 ms jitter, 0.5 px steps, no event when the cursor doesn't move.
2. **Windows** (`shared/config.json`). Each window is 400 ms, resampled to 100 Hz (40 points). Live, a new window is classified every 50 ms. We tried 250 ms first, but a 4 Hz tremor only completes one cycle in 250 ms, and accuracy was about 79% vs 88% at 400 ms.
3. **Features** (`features.py`). Mean speed, speed variance, acceleration variance, jerk RMS (all log-scaled), direction reversals, the *share* of velocity power in the 4–12 Hz band (FFT), the *strength* of that band (`band_amp`, so a 1 px wobble and a 15 px shake look different), `straightness` (net distance ÷ path length: a flick ≈ 1, a shake ≈ 0), and two combined features, `wobble` = band strength × (1 − straightness) and `travel` = speed × straightness, which let a linear model learn "fast **and** straight = intentional".
4. **Model** (`train.py`). `StandardScaler` + multinomial `LogisticRegression`. It exports to about 30 numbers that JavaScript can run in a few lines.

### Results (synthetic test set, 1,800 windows)
| | precision | recall |
|---|---|---|
| stable | 0.85 | 0.91 |
| uncertain | 0.81 | 0.78 |
| unstable | 0.91 | 0.88 |

**Accuracy: 85.6%** (decision tree for comparison: 87.1%). Most mistakes involve the borderline `uncertain` class, which only moves smoothing one step (light ↔ medium ↔ strong). Calm movement (including fast flicks) is called `unstable` about 2% of the time, and live predictions are smoothed over a few windows so a single odd window can't flip the label.

**A bug we caught (good story for judges):** our first synthetic `unstable` data also had extra random noise. The model scored 88%, but in a live test it called a smooth, real-looking 6 Hz shake `uncertain`: it had learned "noisy = unstable" instead of "oscillating = unstable." We gave every class the same noise, added the `band_amp` feature and a longer window, and now smooth shakes are caught. Lesson: a high test score on synthetic data can hide a shortcut, so test on realistic inputs too.

**A second one, found by a real user:** normal, fast mouse movement showed as `unstable`. Our synthetic "calm" reaches maxed out around 1,500 px/s, but real flicks reach 3,000–9,000 px/s, and a fast flick has the same high acceleration as a shake. We added fast flicks and overshoots to the training data, plus the `straightness` / `wobble` / `travel` features. Now simulated 800 px flicks in 180 ms read `stable`, while 5–6 Hz shakes still read `unstable`.

> **Honesty note:** these numbers are on *synthetic* data. They show the pipeline works, not that it generalizes to real tremors. That would need testing with real users.

## Test the live classifier (Checkpoint 3)

1. Serve the repo (`python3 -m http.server 5500`) and open <http://localhost:5500/demo/parity.html>. It should say **PASS: all 21 fixtures match Python**. (This page works even without the extension.)
2. Reload the extension in `about:debugging`, then open <http://localhost:5500/demo/>. A badge appears in the bottom-right corner.
3. Move calmly: the badge says **STABLE**. Wiggle the mouse quickly back and forth: it switches to **UNSTABLE**. Stop moving: back to STABLE.
4. The popup's "Movement right now" row shows the same label. The "Debug badge on all sites" switch shows the badge on any website.

## Privacy
All movement data stays in the page's memory. Nothing is sent over the network. The export only happens when you click the button, and it contains pointer data only, never keystrokes.
