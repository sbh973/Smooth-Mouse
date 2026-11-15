# Smooth Mouse: build prompt for Claude Code (v3, with a Python ML pipeline and the Gemini API)

You are helping our 2-person team build **Smooth Mouse** at the Emory Hacks hackathon. **Submissions are due Sunday Nov 15 at 8:00 AM ET.** We work in hourly checkpoints. We're new to hackathons and vibe coding, so keep the code simple, explain what you build, and tell us exactly how to test each piece.

Save this whole prompt as `CLAUDE.md` in the project root. Then do **only the current checkpoint** and stop (see "How to work" at the bottom).

## 1. What we're building

**Smooth Mouse** is a browser extension (Firefox first, Chrome compatible) that helps people with hand tremors use the web. It uses a **small, focused ML component**, not a big AI system, to solve one real engineering problem:

> **How do we tell involuntary cursor fluctuations apart from intentional movement, without making the cursor sluggish or taking control away from the user?**

The ML is central to the project and the presentation, not an add-on. We don't add AI just because judges like AI.

### Architecture
```
Mouse movement (x, y, t)
   → feature extraction on short sliding windows
     (velocity, velocity variance, acceleration variance, direction reversals, high-frequency power)
   → ML movement classifier → P(stable), P(unstable), P(uncertain)
   → adaptive controller → chooses stabilization strength (One Euro filter parameters)
   → stabilized cursor: keeps intended movement, reduces unwanted motion
   → click / key protection and target assistance use the same signal
```

### Class labels
`stable`, `unstable` and `uncertain` are **engineering labels, not medical diagnoses.** Say this in the UI and the README.

### Honesty
The base model is trained on **synthetic** movement data. That demonstrates the pipeline, but real user testing would be needed to show it generalizes to real tremors. Say this in the README and in `DEVPOST.md`.

Features users see:
1. **Calibration** (about 1 minute) personalizes the model.
2. **Adaptive cursor stabilization** that gets stronger only when movement looks unstable.
3. **Click and key protection:** blocks shaky accidental clicks, merges accidental double-clicks, drops repeated keystrokes.
4. **Target assistance:** clickable elements magnetize to the stabilized cursor.
5. **Risky-click confirmation:** "Did you mean to click 'Send'?" when a click on a risky button happens during unstable movement.
6. **Demo tools:** a "shaky hand" simulator, live raw-vs-stabilized visualization, and a before/after test.
7. **Gemini-powered understanding** (see section 2b):
   - Gemini decides which buttons are risky on any website.
   - Gemini explains calibration results in plain language.
   - Gemini drafts a doctor-friendly summary.

Tracks: Coder for Good (Impact, Technical Innovation, UX & Design, Project Completion) and Healthcare. We are also entering the **Best Use of Google Gemini API** side challenge, so Gemini's role must be visible and impressive in the demo.

**Division of labor (use this line in the pitch):** our own on-device model understands the user's *hands*; Gemini understands the *page*, so Smooth Mouse knows which clicks are dangerous.

## 2. Technical rules

### Split between Python and JavaScript
- **Python (`ml/`)** is used for the ML work: synthetic data generation, signal processing, training, evaluation and charts. Use **NumPy, SciPy, scikit-learn, matplotlib**.
- **FastAPI** runs a small **local** service (`ml/server.py`, on `http://localhost:8000`) with two jobs: **calibration retraining** (one batch request, a few seconds) and **proxying Gemini API calls** so the API key never sits in extension code. **It is never in the real-time cursor loop.**
- **JavaScript (in the extension)** does all **real-time** work: capture, feature extraction, inference with the exported model, filtering and UI. Sending every mouse event to Python would add latency and break if the server isn't running.
- **The extension must work with the Python server off.** It uses the bundled base model (or the last personalized one saved in storage). Calibration falls back gracefully: "Personal model needs the local ML server. Using the default model."

### Model choice
Use a scikit-learn `Pipeline(StandardScaler, LogisticRegression(multinomial))`, so it **exports cleanly to JSON** (scaler mean/scale, coefficients, intercepts, class names, window settings) and the JS side can run it in a few lines. If time allows, compare it against a small `DecisionTreeClassifier` and report both, but ship logistic regression.

### Feature parity
The **#1 risk** is Python and JS computing features slightly differently. Define the window setup once in `shared/config.json` (resample rate, window length, step, frequency band). Python exports `shared/fixtures.json` (raw sample windows plus the expected feature values). A JS parity test page must match them within a small tolerance before we trust live predictions.

### Extension
- WebExtension **Manifest V3**. **Firefox first** (`about:debugging` → Load Temporary Add-on). Must also load in Chrome (`chrome://extensions` → Load unpacked). If the manifests must differ, keep `manifest.json` (Firefox) and `manifest.chrome.json`.
- **Plain JS, HTML and CSS. No bundler or build step.** Use `const api = globalThis.browser ?? globalThis.chrome;`.
- Avoid a background script unless needed. Use `storage.local`.
- Call FastAPI **only from extension pages** (e.g. `calibrate.html`), not from content scripts on websites. Add `host_permissions` for `http://localhost:8000/*` and enable CORS in FastAPI.
- No other network calls. Movement data stays on the user's computer (localhost only).
- Don't load Google Fonts in extension pages. Use a system font stack.

## 2b. Gemini API integration (side challenge)
- **SDK and key:** use Google's official Python SDK for the Gemini API (the `google-genai` package) in `ml/server.py`. Use a fast Gemini model from Google AI Studio; check the current model name in Google's docs and put it in `.env` as `GEMINI_MODEL`. Load `GEMINI_API_KEY` from `.env`.
- **Repo safety:** add `.env` to `.gitignore` and commit an `.env.example` with placeholder values. **Never put the key in extension code or on GitHub.**
- **Endpoints** (all return JSON; ask Gemini for structured JSON output):
  - `POST /gemini/risky`: input `{text, ariaLabel, title, nearbyText, pageTitle, iconImageBase64?}`. Output `{risky: bool, action: "send"|"delete"|"purchase"|"submit"|"other", reason: string}`. "Risky" means hard to undo or with real consequences (sending, deleting, paying, publishing, transferring). The optional small icon image lets Gemini classify icon-only buttons (e.g. a trash can).
  - `POST /gemini/explain`: input = profile and stats **numbers only**. Output = a short, warm, plain-language explanation of the user's results (2–3 sentences, no medical claims, include the "not a diagnosis" note).
  - `POST /gemini/report` (stretch): input = aggregated trend numbers. Output = a short doctor-friendly summary.
- **Privacy rule:** never send raw movement data, keystrokes or typed text. Send only button labels, nearby button text and summary numbers. Say this in the README and the demo.
- **Speed and cost:**
  - Check the local word list first; only ask Gemini about buttons the list can't decide.
  - Pre-classify the visible buttons on page load (batched), not at click time, so the confirmation dialog never waits on the network.
  - Cache results per site + button in `storage.local`.
- **Fallbacks:** if the server or Gemini fails or takes more than ~2 s, silently use the word list or pre-written text. The demo must work offline.
- **Visibility for judges:** show a small "Checked by Gemini" tag in the risky-click dialog when Gemini made the call, with its one-line reason ("This button places an order"). Add a "Gemini page scan" panel on the demo page that lists the buttons Gemini flagged as risky.

### Accessibility and general rules
- Accessibility: targets ≥ 44 px, real `<button>` elements, keyboard support, visible focus, contrast ≥ 4.5:1, `aria-label`s, Esc closes dialogs.
- Every feature has an on/off toggle in the popup so we can switch off anything broken during the demo.
- `git` commit at the end of every checkpoint.

### Suggested structure
```
smooth-mouse/
  manifest.json, manifest.chrome.json
  shared/       config.json, model.json (exported), fixtures.json
  content/      capture.js, features.js, model.js, controller.js, stabilize.js,
                filters.js, assist.js, risky.js, simulator.js, main.js, smooth-mouse.css
  popup/        popup.html/.js/.css
  calibrate/    calibrate.html/.js/.css
  demo/         index.html (fake email page + visualization + click test), parity.html
  ml/           requirements.txt, synth.py, features.py, train.py, evaluate.py,
                personalize.py, server.py, gemini.py, plots/ (saved charts for slides)
  .env.example, .gitignore
  README.md, DEVPOST.md, DEMO.md, CLAUDE.md
```

## 3. Hourly checkpoints

We started around 10:30 AM Saturday. Clock targets are in brackets. Each checkpoint has a **Done when** list. Don't move on until it passes, and don't start the next one until we say "next checkpoint."

### Checkpoint 1 [~11:30 AM]: Extension setup and movement capture
- Folder structure, `manifest.json` (Firefox MV3), content scripts on all URLs, popup, extension pages.
- `capture.js`: capture-phase listeners for `pointermove`, `pointerdown`, `pointerup`, `click`, `dblclick`, `keydown`, `keyup`. Keep a ring buffer of the last ~3 s with `performance.now()` timestamps.
- Popup: master on/off and a live debug readout (pointer events/sec, clicks, keys).
- `demo/index.html`: a fake email compose page (To, Subject, body, **Send**, **Delete draft**), mixed-size buttons, a text box.
- **New:** an "Export recording" button on the demo page that downloads the last N seconds of raw pointer events as JSON, so we can inspect real movement in Python.
- README with load instructions. `git init` and commit.

**Done when:** it loads in Firefox, the popup stats update live, and the export downloads a valid JSON file.

### Checkpoint 2 [~1:30 PM]: Python synthetic data, features and classifier
- `ml/requirements.txt` (numpy, scipy, scikit-learn, matplotlib, fastapi, uvicorn, google-genai, python-dotenv) and README setup steps (venv + pip). Create `.gitignore` (including `.env`) and `.env.example`.
- `shared/config.json`: resample to a fixed rate (e.g. 100 Hz), window ≈ 250 ms, step ≈ 50 ms, tremor band ≈ 4–12 Hz.
- `synth.py`: generate raw movement windows.
  - **Stable:** smooth intentional reaches (minimum-jerk paths) and steady holds.
  - **Unstable:** the same paths plus an oscillation (4–10 Hz, 2–20 px) plus noise.
  - **Uncertain:** borderline cases (small amplitude, fast intentional direction changes such as scribbles).
  - Generate balanced data (several thousand windows), with a fixed random seed.
- `features.py`: per window: mean speed, speed variance, acceleration variance, direction reversals, high-frequency power ratio (band power in the tremor band divided by total, via FFT on the resampled window). Optionally jerk RMS.
- `train.py`: train/test split, the pipeline above, accuracy, a confusion matrix and per-class precision/recall. Save the charts to `ml/plots/`. **Export `shared/model.json`** and **`shared/fixtures.json`** (about 20 windows with expected features and probabilities).

**Done when:** `python ml/train.py` runs end to end, prints metrics (test accuracy on synthetic data ≥ 85%), and writes `model.json`, `fixtures.json` and the plots.

### Checkpoint 3 [~2:30 PM]: JS features, parity test and live inference
- `content/features.js`: mirrors `features.py` exactly, using `shared/config.json`.
- `content/model.js`: loads `model.json` and returns class probabilities.
- `demo/parity.html`: runs the fixtures through the JS code and shows PASS/FAIL per window for features and probabilities.
- Live inference on sliding windows (every ~50 ms). Show the current class and probabilities in a small debug badge on the demo page.

**Done when:** all parity fixtures PASS, and the live badge switches between stable and unstable when we move calmly vs shake the mouse.

### Checkpoint 4 [~4:30 PM]: Adaptive controller and stabilized cursor
- `stabilize.js`: a **One Euro filter**; hide the real cursor on the page, draw a smoothed cursor element (`pointer-events: none`), and re-dispatch clicks at the smoothed position (`elementFromPoint`).
- `controller.js`: map class probabilities to filter strength. Stable → light smoothing (low lag). Unstable → strong smoothing. Uncertain → medium. Add **hysteresis** and smooth transitions so strength doesn't flicker. Large, fast, consistent movement should always stay responsive, so the user stays in control.
- Demo page visualization: **raw trail vs stabilized trail** on a canvas, the live class, and two live metrics: **jitter reduction** (RMS of high-frequency deviation, raw vs stabilized) and **added lag** (ms).
- README note: re-dispatched clicks are "untrusted" events, so some sites may ignore them. Keep a toggle.

**Done when:** shaking produces a visibly steadier stabilized trail, calm movement shows near-zero added lag, and clicks land at the stabilized position.

### Checkpoint 5 [~5:30 PM]: Calibration and personalization (FastAPI)
- `calibrate/calibrate.html`: a friendly 3-step flow with a progress bar:
  1. **Hold the cursor on a dot** (10 s)
  2. **Click 10 targets** of varied sizes
  3. **Type a sentence**
- From step 1, measure the user's resting fluctuation (amplitude and dominant frequency). From step 2, collect their real reaching windows and click behavior. From step 3, measure repeated-key gaps.
- `ml/personalize.py` + `ml/server.py`: `POST /calibrate` with the recorded data. Generate **personalized synthetic data** using the user's measured fluctuation parameters, combine it with their real windows (weighted higher), retrain, and return a new `model.json` plus a profile (key-repeat window, double-click window, magnet radius, plain-language summary).
- Store the personal model and profile in `storage.local`, and use them everywhere. If the server is off, keep the base model, still compute the simple profile thresholds in JS, and tell the user.
- Results screen in plain language (e.g. "Your cursor fluctuates about 14 px at about 5 times per second"), plus the "engineering labels, not a diagnosis" note.
- **Gemini:** add `ml/gemini.py` and the `POST /gemini/explain` endpoint. Show Gemini's plain-language explanation on the results screen with a small "Explained by Gemini" tag. Fall back to a template sentence if it's unavailable.

**Done when:** with the server running, calibration returns and saves a personal model and shows Gemini's explanation. With it off, calibration still finishes using the fallbacks.

### Checkpoint 6 [~6:30 PM]: Click and key protection, plus target assistance
- Clicks during strongly `unstable` windows, or with large movement during the press → block and show a small toast ("Smooth Mouse ignored a shaky click"). Use a configurable threshold.
- Merge accidental double-clicks within the personal window.
- Key-repeat filter (capture-phase `keydown`): the same key within the personal window → `preventDefault`. Ignore modifiers and intentional held keys.
- `assist.js`: within the magnet radius of a clickable element, highlight it and route the click to it.
- Counters for clicks blocked, keys filtered and assists, shown in the popup.

**Done when:** shaky clicks are blocked, calm clicks always work, "hhello" from a shaky double press comes out as "hello," and small buttons are easier to hit.

### Checkpoint 7 [~7:30 PM]: Risky-click confirmation (with Gemini) and shaky-hand simulator
- `risky.js`: first check the **word list**. An element is risky if its text, `aria-label`, `title`, `value`, class or ID matches send, delete, remove, trash, buy, purchase, pay, place order, checkout, submit, confirm, transfer, unsubscribe, post or publish.
- For buttons the list can't decide, use **`POST /gemini/risky`** (section 2b). Pre-classify visible buttons on page load, batched and cached; never wait on the network at click time.
- Risky + (unstable or uncertain at click time) → an accessible dialog: "Did you mean to click 'Send'?" with large "Yes, send it" / "No, go back" buttons, focus trap, Esc = cancel. Show "Checked by Gemini" plus its reason when Gemini made the call.
- Demo page: add buttons the word list would miss (e.g. "Place order," "Confirm transfer," an icon-only trash button) and a **"Gemini page scan"** panel listing what Gemini flagged.
- `simulator.js`: a "Shaky hand" toggle that adds simulated tremor (≈5 Hz sine, ±12 px, plus noise) and occasional extra clicks **before** Smooth Mouse's pipeline, so judges without tremors can feel the problem.

**Done when:** with the simulator on, clicking Send triggers the dialog. Gemini correctly flags the icon-only trash and "Place order" buttons, and the word list still works with the server off. With the simulator off, calm clicks go straight through.

### Checkpoint 8 [~9:30 PM]: Evaluation, tuning and charts for the presentation
- **Before/after test** on the demo page: 20 targets one at a time. Record accidental clicks, wrong-target clicks, time per target and repeated keys, with Smooth Mouse off vs on (simulator on for both). Show a side-by-side results card.
- `ml/evaluate.py`: charts for the slides: confusion matrix, feature distributions (stable vs unstable), raw vs stabilized trajectory from an exported recording, and the jitter-reduction vs added-lag tradeoff for different controller settings.
- Tune the thresholds and controller. Test calm, normal use carefully: it must never feel sluggish. Load and test once in Chrome.

**Done when:** the before/after card clearly shows fewer errors with Smooth Mouse, the charts are saved in `ml/plots/`, and normal use feels unchanged.

### Checkpoint 9 [~11:00 PM]: Polish and submission prep
- Polish the popup, calibration, dialog and demo page. Calm look: teal `#0F766E`, ink `#102A43`, background `#F3F6F7`, orange `#B4441A` for warnings only.
- Keyboard-only and contrast pass.
- `README.md`: the problem, the architecture diagram (text), why ML is the right tool here, model and features, the Python/JS split and why real-time stays in the browser, privacy (local only), install steps (extension + optional Python server), evaluation results, limitations (synthetic training data, browser-only, untrusted events, not a medical device), and future work (real-user data with consent, desktop version, Safari).
- README: add a **"How we use Gemini"** section (risky-button understanding including icon images, plain-language explanations, privacy: labels and summary numbers only) and how to set up `.env`.
- `DEVPOST.md` draft (with a clear Gemini section for the side challenge) and a 2-minute `DEMO.md` script that puts the ML front and center and includes one clear Gemini "whoa" moment (e.g. it catches an icon-only trash button the word list missed).

**Done when:** a fresh install → calibrate → demo works end to end without touching code.

### Stretch (only if everything is stable)
Tremor trends page (by day and time of day, a "report for my doctor"), the DecisionTree comparison, Safari packaging notes.

## 4. How to work
- **One checkpoint at a time.** At the end of each: summarize in bullets, give exact test steps (Firefox, and Python commands where relevant), commit, then **stop and wait** for "next checkpoint."
- **Timebox.** If a checkpoint runs over, tell us, cut the least important part, and leave a TODO.
- Simple, working code over clever code. Never leave the demo page broken. Keep earlier features working.
- If you hit a browser or latency limitation, say so plainly and suggest the simplest workaround.
- Comment the non-obvious parts (especially features, the controller and the model export) so we can explain them to judges.

---

# Direction change (Saturday evening)
We tried a 5-filter library + auto-tuner + Filter lab and **removed it**: too complicated, nobody would use it.
The priority instead: features users actually feel, set automatically by calibration.
- **Done:** hold period + ignoring accidental clicks per button (left/right/middle), chosen by calibration (`content/clickhold.js`, `calibrate.js → chooseClickHold`), with popup switches and an override slider.
- **Done (CP6):** repeated-key filter, sliding-click blocking, button magnet; calibration decides every protection (on/off + setting) and the results screen explains each in plain words (`decideProtections`). Calibration uses 5 circles + 3 right-clicks; every click outside a circle counts as accidental; the hold time never blocks real clicks.
- **Done (CP7):** risky-click dialog (word list + Gemini batch pre-classification incl. icon images, cached; background.js is the only link to the server), Gemini page scan panel, shaky-hand simulator. Tested in real Firefox with Selenium.
- **Removed:** the button magnet (`assist.js`), at the user's request.
- **Still to do:** before/after test (CP8), polish + README/DEVPOST/DEMO (CP9).
