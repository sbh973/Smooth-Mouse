# Smooth Mouse

A browser extension (Firefox first, Chrome compatible) that helps people with hand tremors use the web. A small on-device ML model tells involuntary cursor fluctuations apart from intentional movement, and Smooth Mouse stabilizes the cursor only when it needs to.

> **Not a medical device.** The labels `stable`, `unstable` and `uncertain` are engineering labels for cursor movement, not medical diagnoses.

**Status:** Checkpoint 7 + polish: risky buttons on every website, tested on real sites. The button magnet was removed. (See [CLAUDE.md](CLAUDE.md) for the full plan.)

## Project layout (so far)

```
manifest.json        Extension manifest (MV3, works in Firefox and Chrome)
content/capture.js   Records pointer, click and key events (capture phase, ~3 s buffer)
content/main.js      Settings, popup stats, demo-page bridge (simulator switch)
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
demo/parity.html     Checks JS features/probabilities match Python exactly (open it directly; no longer linked)
content/filters.js   One Euro filter (speed-adaptive low-pass)
content/controller.js Model probabilities → smoothing strength (hysteresis, slew, override)
content/stabilize.js Steady cursor, hides the real one while smoothing, redirects clicks
content/viz.js       Demo page: raw vs stabilized trails, jitter and lag metrics
shared/settings.js   Default values for every popup toggle
calibrate/           1-minute calibration: hold, click, type → profile + personal model
ml/personalize.py    Retrains the classifier on one user's calibration data
ml/server.py         Local FastAPI server (localhost:8000): /calibrate, /gemini/explain
ml/gemini.py         Gemini API calls (key stays in .env on this computer)
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

## Test the basics

1. Load the extension (above) and open the demo page. The Smooth Mouse panel should say **Running**.
2. Click the Smooth Mouse toolbar icon. While the popup is open, move the mouse over the page: **Pointer events / sec** jumps (often 60–250). Click and type: **Clicks** and **Keys pressed** go up.
3. Toggle the master switch **Off**: counts stop and the demo page says *Switched off*. Toggle it back **On**.

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


### How it works
1. **Synthetic data** (`synth.py`). `stable` = smooth minimum-jerk reaches (from slow moves up to fast 9,000 px/s flicks), overshoot corrections, holds and slow drags. `unstable` = the same plus a 3.5–10 Hz, 2–50 px oscillation. `uncertain` = very small oscillations (0.7–2 px) or slow intentional back-and-forth scribbles (1–2.5 Hz). Sampling copies a real Firefox recording: events every 7–10 ms, whole-ms timestamps with ±1.5 ms jitter, 0.5 px steps, no event when the cursor doesn't move.
2. **Windows** (`shared/config.json`). Each window is 400 ms, resampled to 100 Hz (40 points). Live, a new window is classified every 50 ms. We tried 250 ms first, but a 4 Hz tremor only completes one cycle in 250 ms, and accuracy was about 79% vs 88% at 400 ms.
3. **Features** (`features.py`). Mean speed, speed variance, acceleration variance, jerk RMS (all log-scaled), direction reversals, the *share* of velocity power in the 4–12 Hz band (FFT), the *strength* of that band (`band_amp`, so a 1 px wobble and a 15 px shake look different), `straightness` (net distance ÷ path length: a flick ≈ 1, a shake ≈ 0), and two combined features, `wobble` = band strength × (1 − straightness) and `travel` = speed × straightness, which let a linear model learn "fast **and** straight = intentional".
4. **Model** (`train.py`). `StandardScaler` + multinomial `LogisticRegression`. It exports to about 30 numbers that JavaScript can run in a few lines.

### Results (synthetic test set, 1,800 windows)
| | precision | recall |
|---|---|---|
| stable | 0.83 | 0.87 |
| uncertain | 0.81 | 0.79 |
| unstable | 0.96 | 0.93 |

**Accuracy: 86.4%** (decision tree for comparison: 88.2%). Most mistakes involve the borderline `uncertain` class, which only moves smoothing one step (light ↔ medium ↔ strong). Calm movement (including fast flicks) is called `unstable` about 2% of the time, and live predictions are smoothed over a few windows so a single odd window can't flip the label.

**A bug we caught (good story for judges):** our first synthetic `unstable` data also had extra random noise. The model scored 88%, but in a live test it called a smooth, real-looking 6 Hz shake `uncertain`: it had learned "noisy = unstable" instead of "oscillating = unstable." We gave every class the same noise, added the `band_amp` feature and a longer window, and now smooth shakes are caught. Lesson: a high test score on synthetic data can hide a shortcut, so test on realistic inputs too.

**A second one, found by a real user:** normal, fast mouse movement showed as `unstable`. Our synthetic "calm" reaches maxed out around 1,500 px/s, but real flicks reach 3,000–9,000 px/s, and a fast flick has the same high acceleration as a shake. We added fast flicks and overshoots to the training data, plus the `straightness` / `wobble` / `travel` features. Now simulated 800 px flicks in 180 ms read `stable`, while 5–6 Hz shakes still read `unstable`.

> **Honesty note:** these numbers are on *synthetic* data. They show the pipeline works, not that it generalizes to real tremors. That would need testing with real users.

## Test the live classifier (Checkpoint 3)

1. Serve the repo (`python3 -m http.server 5500`) and open <http://localhost:5500/demo/parity.html>. It should say **PASS: all 21 fixtures match Python**. (This page works even without the extension.)
2. Reload the extension in `about:debugging`, then open <http://localhost:5500/demo/>. A badge appears in the bottom-right corner.
3. Move calmly: the badge says **STABLE**. Wiggle the mouse quickly back and forth: it switches to **UNSTABLE**. Stop moving: back to STABLE.
4. The popup's "Movement right now" row shows the same label. The "Debug badge on all sites" switch shows the badge on any website.

## Stabilized cursor (Checkpoint 4)

```
raw pointer samples ──► One Euro filter ──► steady cursor (drawn by us)
                             ▲
model probabilities ──► controller ──► smoothing strength 0..1
(every 50 ms)              │
                           └─ fast movement in one direction → turn smoothing down
```

- **One Euro filter** (`filters.js`): a low-pass filter whose cutoff rises with speed. The controller picks its parameters, from barely-there (6 Hz cutoff) to strong (0.5 Hz, with very low speed sensitivity so even big, fast shakes are cut by about 90%).
- **Controller** (`controller.js`):
  - **Levels:** light (stable, 0), medium (uncertain, 0.75) and strong (unstable, 1).
  - **Hysteresis:** it goes up a level as soon as the model is ≥ 55% sure, but only goes down after the evidence drops below 35% for 400 ms.
  - **Gradual strength:** strength rises in about 150 ms and falls over about 600 ms, so nothing jumps.
  - **Override:** fast, *straight* movement loosens the filter whatever the model says: net displacement over 200 ms × straightness (net ÷ path length), from 400 to 1,200 px/s. A deliberate reach triggers it, which keeps the user in control. A shake, even a big, fast one, folds back on itself, so it doesn't.
- **Steady cursor** (`stabilize.js`): only while smoothing is active do we hide the real cursor and draw our own. Calm movement uses the real cursor, so it has **zero added lag**.
- **Clicks**: if the steady cursor is over a different element than the real one, the real click is cancelled and a click is sent to the element under the steady cursor.

**Simulated results** (Node test with the real extension code):

| Movement | Smoothing | Jitter (raw → steady) | Lag |
|---|---|---|---|
| Calm drag / fast flick / 800 px reach | off | unchanged | 0 px |
| 6 Hz, 8 px shake | strong | 5.4 → 0.5 px (**−91%**) | n/a |
| 5 Hz, 20 px shake | strong | 10.4 → 1.1 px (**−90%**) | n/a |
| 4 Hz, 40 px shake | strong | 14.7 → 2.0 px (**−86%**) | n/a |
| 5 Hz, 60 px shake | strong | 30.8 → 3.5 px (**−89%**) | n/a |
| 7 Hz, 35 px shake | strong | 36.9 → 2.8 px (**−92%**) | n/a |
| Sudden 70 px jerks | strong | 16.1 → 1.8 px (**−89%**) | n/a |

**Fix for big, sharp movements:** an earlier version only cut big shakes by 11–37%. Three causes: (1) the "deliberate movement" override measured only 80 ms with no straightness check, so a big shake looked like a reach and turned smoothing off; (2) the filter's speed sensitivity let fast shakes through; (3) the model had never seen shakes over 20 px. We fixed all three, plus made medium smoothing stronger.

**Minimum smoothing slider (popup, 0–100%):** by default (0%) fast, *straight* moves across the screen are treated as deliberate and not smoothed, so there's no lag. The slider sets a floor that neither the model nor the override can go below, so big, sharp moves get smoothed too: the cursor glides in behind the hand. Simulated 700 px sharp jerk: at 50% it trails by up to ~120 px and catches up within ~30–160 ms; at 100% its peak speed is cut ~3× but it takes ~1.5 s to arrive (best for severe involuntary jerks).

**Trade-off we chose:** maximum smoothing. A user *with* a tremor making a fast deliberate reach sees the steady cursor trail by up to about 70 px at peak speed. Lowering the override threshold reduces that lag but smooths sudden jerks less (−68% instead of −89%).

**Limitations:**
- **Untrusted clicks:** redirected clicks are created by a script (`isTrusted = false`). Most sites accept them, but some ignore them (e.g. file pickers, some payment and anti-bot widgets). Turn off "Click where the steady cursor is" in the popup if a site misbehaves.
- **Hover effects** (CSS `:hover`, tooltips) follow the *real* pointer, not the steady one.
- **Iframes and scrollbars** still show the real cursor, because content scripts only run in the top page.

### Test it
1. Reload the extension in `about:debugging`, then refresh <http://localhost:5500/demo/>.
2. Move calmly: the badge says *Smoothing: 0% (light)*, the real cursor is visible and *Added lag* stays near 0 ms.
3. Shake the mouse: smoothing climbs to *strong*, the cursor becomes our drawn arrow, the teal (steady) trail is much calmer than the orange (raw) one, and *Jitter* shows a big reduction.
4. While shaking, click **Send**: the click goes to whatever the *steady* cursor is on.
5. Every part has a popup toggle: *Stabilize cursor* and *Click where the steady cursor is*.

## Calibration and personal model (Checkpoint 5)

### Start the local server (optional, but needed for the personal model and Gemini)
```bash
cd ~/SmoothMouse/Smooth-Mouse
source .venv/bin/activate
cp .env.example .env        # first time only; then put your Gemini key in .env
python ml/server.py         # leave this terminal open; Ctrl+C stops it
```
It listens only on `127.0.0.1:8000`. The first start builds a cache of the base training data (about a minute); after that it starts in a second or two. **The extension works without it.**

### What calibration does
Open the popup → **Calibrate (1 minute)**:
1. **Hold** the cursor on a dot for 10 s → resting fluctuation size (px) and frequency (times per second).
2. **Click 5 targets** of different sizes, then **right-click 3** → real reaching movement, and how long real clicks vs accidental clicks (outside the circles) are held.
3. **Type a sentence** → typing rhythm and accidental double key presses (the sentence has no doubled letters, so any double is accidental).

Then:
- **A profile** is computed in the browser (always works): key-repeat window, double-click window and shaky-press threshold. These are used by Checkpoint 6.
- **A personal model** is trained by the server in about 1–2 s (`ml/personalize.py`):
  - Your 10 s hold is the yardstick. If your cursor stays steady (< 1.5 px), everything you did during calibration was intentional, so all of it becomes `stable` training data. This fixes "my normal fast movement shows as unstable."
  - If you have a measurable wobble, your hold windows become real `unstable` examples. Reach windows much calmer than your hold become `stable`.
  - Extra synthetic `unstable` data is generated at **your** measured size and frequency.
  - Weights: your real windows ×4, personalized synthetic ×2, base data ×1.
  - The results screen shows before vs after on your own movement, e.g. *"calm movements flagged as unstable: 31% with the default model → 3% with your personal model"*.
- **Gemini** turns the summary numbers into a short, plain-language explanation, tagged *Explained by Gemini*. If Gemini is off, slow (> 10 s) or failing, you get a pre-written explanation instead.
- Everything is saved in `storage.local` and used on every page right away. The popup shows **Model in use: personal / default** and has a **Use my personal model** switch.

**Without the server:** calibration still finishes, the profile is still tuned to you, and the results say *"Personal model needs the local ML server. Using the default model."*

### Gemini setup
Put your key in `.env` (never in `.env.example`, which is committed): `GEMINI_API_KEY=...`. We use `gemini-3.6-flash` (about 1 s per answer in our tests), and `gemini-3.5-flash` is tried automatically if it's busy. The newest model, `gemini-3.8-flash`, returned "high demand" errors when we tested. **Gemini only ever receives summary numbers**, such as "7 px, 6 times a second, 3 missed clicks". It never receives raw movement, keystrokes or typed text.

## Hold period: ignoring accidental clicks

A shaky hand often produces **quick accidental taps**. With protection on, a click only counts if the button is **held for the hold period**. Left, right and middle each have their own switch.

- **The AI picks the hold period during calibration** (`calibrate.js → bestHold`). In the circle steps (5 left-clicks, then 3 right-clicks) it times how long the button is held on every press:
  - **real clicks:** presses that hit a circle
  - **accidental clicks:** every press that lands *outside* a circle (shaky taps, slips)
  - **Rule 1, never block real clicks:** the hold time stays below 85% of your quickest real click.
  - **Rule 2, catch the quick taps:** within that limit, it goes halfway between your longest quick accidental tap and your quickest real click.
  - No quick taps? Then it's 80% of your quickest real click. Kept between 0.03 and 0.5 s.
  - *Bug we fixed:* an earlier "fewest mistakes" rule chose 0.5 s for a very shaky tester (39 clicks outside the circles), which would have blocked all 5 of their real clicks. Rule 1 makes that impossible; the same data now gives 0.05 s.
- **While you hold** a protected button, a ring around the cursor fills up (orange → teal). Let go after it's full and the click counts.
- **Quick taps are ignored** with a message: "Smooth Mouse ignored a quick left click. Hold for 0.09 s to click." The popup counts them.
- **Popup → Accidental clicks:** switches for left, right and middle, the hold period with the reason calibration chose it, a slider to override it, and *Use calibrated value* to undo the override.
- **How it works:** the press goes through untouched. We cancel the browser's finished-click event (`click`, `auxclick`, `contextmenu`, all fired on release) if the press was too short, so real clicks stay real, trusted events and work on every site. Keyboard clicks (Enter/Space) are never blocked.
- **Limitation (right-click on macOS/Linux):** the browser opens the right-click menu as soon as the button goes *down*, before the hold time is known, so it can't be held back. In Firefox, set `ui.context_menus.after_mouseup` to `true` in `about:config` to make the menu open on release; then right-click protection works there too.

Simulated tests: 9/9 cases pass, e.g. a 60 ms tap is ignored, a 200 ms press clicks, Enter on a button always works, an unprotected button is never touched, and a user override of 0.4 s blocks a 0.3 s press.

### Test it
1. Reload the extension, then run **Calibrate** from the popup (the click step now ends with 3 right-clicks). The results list the hold period and why.
2. In the popup, turn on **Ignore quick left clicks** if calibration left it off.
3. On the demo page, tap **Send** very quickly: nothing is sent, and a message says the click was ignored. Press and hold until the ring turns teal, then release: "Message sent".
4. Drag the **Hold period** slider to change it; press **Use calibrated value** to go back.

## Calibration results: your protections

The results screen shows a short summary (from Gemini when available), then **one card per protection** with **On/Off**, **What it does** (with your setting in plain words) and **Why** (based on your calibration). The raw numbers are under *Details*. Calibration switches each protection on or off for you; you can change any of them in the popup.

| Protection | Turned on when calibration sees… | Your setting comes from… |
|---|---|---|
| Steady cursor | always on (adapts live) | your personal ML model |
| Ignore quick clicks | shaking, or accidental taps quicker than your real clicks | how long you held real vs accidental clicks |
| Ignore repeated keys | shaking, or a double key press while typing | 45% of your typical time between keys (0.06–0.3 s) |
| Ignore sliding clicks | shaking | 2 × how far your cursor usually slides during a click (8–40 px) |

## Checkpoint 6: key protection, sliding clicks

> **Note:** the button magnet described below was later removed to keep Smooth Mouse simple.

- **Ignore repeated keys** (`keyguard.js`): a second press of the same key is dropped (so "hhello" becomes "hello") when either:
  1. it came **extremely fast**, within your calibrated window (a bounce; nobody types a real double letter that fast), or
  2. it came **fairly fast** (within 2× your normal time between keys) **and the double doesn't belong in a word**: a doubled letter at the start of a word ("hhello", "ttoday"), a letter English almost never doubles (hh, jj, kk, qq, vv, ww, xx, yy, ii, uu, aa), or a double space.

  Real double letters inside words ("hello", "book", "coffee") are kept, even when typed fast. *Why rule 2 exists:* a fast typist's accidental "hh" can be just as quick as their real "ll", so timing alone can't tell them apart; where the double appears can. The word rules assume English, and rare words starting with a double letter ("aardvark") lose a letter. It never touches held keys, Backspace/Enter/arrows, shortcuts like Cmd+C, digits/punctuation, or input-method typing. Tests: 12/12 (e.g. "hhello" → "hello", "thhe" → "the", "coffee" stays, "hhello" typed slowly on purpose stays).
- **Ignore sliding clicks** (`clickhold.js`): if the cursor slid further than your limit between pressing and releasing, the click is ignored. It's measured on the *steady* cursor when smoothing is active, so raw shaking alone doesn't count.
- **Button magnet** (`assist.js`): when the cursor isn't on anything clickable but is within your magnet radius of a button or link, the nearest one gets a teal outline and catches the click (focused, then clicked at its centre). It stays out of the way when you're already on something clickable.
- **Why we don't block every click during "unstable" movement:** for someone with a constant tremor, that would mean they could never click. With the steady cursor, their clicks land where they're aiming instead. (Risky buttons get a confirmation dialog in Checkpoint 7.)
- **Popup:** switches for each protection and counters: *Accidental clicks ignored*, *Repeated keys ignored*, *Clicks caught by the magnet*.

Simulated tests: 12/12 pass (accidental "hh" 40 ms apart is dropped, a real "ll" 150 ms apart is kept, held keys, Backspace and Cmd+C are untouched, a 60 px slide is ignored, an 8 px one isn't, a click 10 px from a small button goes to the button, one 60 px away or directly on it is normal).

### Test it
1. Reload the extension, then **Calibrate** (or switch protections on in the popup).
2. **Repeated keys:** in the demo message, quickly double-tap "h" then type "ello". You get "hello" and a message.
3. **Magnet:** move near the tiny ⚙ / ? or **B** / *I* / U buttons without touching them; one lights up. Click: the status line names that button.
4. **Sliding clicks:** press on **Save draft**, slide far away while holding, release: ignored, with a message.
5. The popup counters go up as each protection helps.

## Checkpoint 7: risky clicks (with Gemini) and the shaky-hand simulator

**"Did you mean to click 'Send'?"** If a click lands on a risky button while the hand is shaking (the model said unstable/uncertain in the last second, the steady cursor is on, or the simulator is running), Smooth Mouse pauses and asks, with big **No, go back** (the default) and **Yes, send it** buttons. Esc = No, Tab stays inside the dialog, and calm clicks go straight through.

**Which buttons are risky?** Our model understands the user's *hands*; Gemini understands the *page*.
1. **Word list first** (instant, offline): send, delete, remove, trash, buy, purchase, pay, place order, checkout, submit, confirm, transfer, unsubscribe, post, publish (in the label, aria-label, title, value, class or id).
2. **Gemini for everything the list can't decide.** When a page loads, `risky.js` sends the undecided buttons, as **labels only**, in **one batch** to `background.js` → local server → `POST /gemini/risky`. **Icon-only buttons** (no text) are drawn into a small 48×48 PNG so Gemini can *see* the icon (e.g. a trash can). Gemini returns `{risky, action, reason}` per button using structured JSON output.
3. **Never waits at click time:** the dialog only uses answers we already have. With the server off or Gemini down, the word list still works.
4. **Cached twice:** in the extension (`storage.local`) and on the server (`ml/cache/gemini_cache.json`), so a button is asked about once, ever. Busy (503/429) answers are retried once, then the backup model is tried.
5. **The dialog shows "Checked by Gemini"** and Gemini's one-line reason when Gemini made the call.

**Gemini page scan** (demo page panel) lists what was flagged and by whom. On the demo page, Gemini catches **Complete booking · $249**, **Wire $500 to Alex**, **Close my account** and an **icon-only 🗑 button**, none of which the word list matches, and correctly leaves Bold, Add to wishlist and View details alone.

**Shaky-hand simulator** (popup → Demo, or the button on the demo page): adds a fake tremor (~5 times a second; **Shake strength** slider from 2 px "light" to 40 px "very strong", default 12 px, plus noise) to the mouse *before* Smooth Mouse sees it, keeps shaking while the mouse is still, hides the real cursor and shows a shaky orange one, makes clicks land where the shaky cursor is, and sometimes adds an accidental extra tap. It works with Smooth Mouse switched off too, to show the "before".

**Privacy:** Gemini receives button labels, nearby button labels, the page title and small icon images, never typed text, page content or movement.

**Tested in a real Firefox** (Selenium driving the actual extension): the scan flags exactly those 4 buttons; a calm click on Send sends; a shaky click on Send opens the dialog and Esc cancels it (nothing sent); a shaky click on the trash icon shows Gemini's reason with "Checked by Gemini", and clicking *Yes, delete it* with the shaky mouse deletes; a shaky click on *View details* goes straight through.

### Test it
1. Make sure the server is running (`python ml/server.py`), reload the extension, then refresh the demo page. After a few seconds the **Gemini page scan** panel lists the risky buttons.
2. Press **Turn on shaky hand** on the demo page. Your cursor turns into a shaky orange arrow; after a moment Smooth Mouse's steady cursor takes over.
3. Click **Send**: the dialog asks first. Press **No, go back** (or Esc): nothing is sent.
4. Click the **🗑** button in the trip card: the dialog says *Did you mean to delete this?* with Gemini's reason and the **Checked by Gemini** tag.
5. Click **View details**: no dialog.
6. Turn Smooth Mouse **off** in the popup with the simulator still on: now it's hard to hit anything. That's the "before".

## Risky buttons on every website, an accurate magnet, real-site tests

**Every website, not just the demo:** the scan runs on every page. Open the popup on any site to see **Risky buttons on this page**, each with who flagged it (word list or Gemini) and why. A shaky click on any of them shows the "Did you mean to…?" dialog.
- The word list knows real shop wording ("Place your order", "Buy now", "Check out", "Pay now", "Order now", "Book now", "Donate") and reads labels kept in another element (`aria-labelledby`, like Amazon's **Buy Now**). Risky **links** count too (e.g. a "Checkout" link).
- **Fewer false alarms:** generic code names like `submit`/`confirm` in class/id no longer count (Amazon's search **Go** button was flagged before), and search buttons are never risky.
- **Gemini quota saver:** only on-screen buttons the word list can't decide are sent, at most 25 per request and one request every 5 s per page; obviously safe buttons (Search, Menu, Close, Next, Sign in, Add to cart, page numbers…) are never sent; after a failure (server off, busy, out of quota) Smooth Mouse waits 2 minutes before asking again, using the word list meanwhile.

**More accurate magnet** (`assist.js`): only real targets count (links, buttons, checkboxes/radios, selects, ARIA buttons/links/tabs), not big boxes with `tabindex`/`onclick`, labels or text fields; it never acts when the cursor is already on something interactive; it skips huge elements (cards, banners), invisible ones and ones covered by something else; wrapped links are measured line by line and only the nearest line is outlined; and if two targets are about equally close, it doesn't guess. The pull distance is capped at 36 px.

**Tested in a real Firefox** (Selenium driving the actual extension):
| Test | Result |
|---|---|
| Magnet, 80 random spots on a Wikipedia article | lit up only 9 times, always on the truly nearest link (2–17 px away); 0 false outlines |
| Magnet on the demo page | near ⚙ → ⚙; below Send → Send; between B and I → nothing; empty space / text field → nothing |
| Demo store (saucedemo.com) cart | "Checkout" and "Remove" flagged; shaky click on Checkout → dialog |
| Amazon/Target-style buy box (their real markup) | "Buy Now" (aria-labelledby), "Check out", "Place your order" flagged; "Add to Cart" and search "Go" not; shaky click on Buy Now → dialog, the page never got the click |
| Demo page | Send changes colour on hover and press; shaky Send → dialog → No (clicked 20 px off) → nothing sent; → Yes → sent |

*Limits:* Amazon and Target show a bot-check page to automated browsers, so we tested their real button markup on a local copy; a person using normal Firefox gets the real page.

## Privacy
All movement data stays in the page's memory. Raw movement only ever goes to the local server on your own computer (for calibration). Gemini only receives button labels, small icon images and summary numbers, never movement, keystrokes or typed text.
