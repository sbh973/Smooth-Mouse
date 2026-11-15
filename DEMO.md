# Smooth Mouse: 2-minute demo video

The video mixes two kinds of footage:

- **Animated scenes** (title, statistics, feature cards): open [`video/scenes.html`](video/scenes.html) in a browser, press **F** for full screen, then press **1–9** to play each scene while you screen-record it.
- **Real screen recordings** of Smooth Mouse in Firefox (calibration, the demo page, a shopping site).

Total: **2:00**. The voice-over is about 230 words, a calm speaking pace.

---

## The script

| Time | On screen | Voice-over |
|---|---|---|
| **0:00–0:12** | **Scene 1: cold open.** A shaky cursor tries to click "No thanks", slips onto "Buy now", and the screen reads "Order placed! $1,899 · non-refundable". It cuts to black: "For millions of people with hand tremors, this happens every day." | *(no voice for the first 8 s: just a click sound and a "cha-ching")* … "For millions of people with hand tremors, this happens every day." |
| **0:12–0:29** | **Scene 2: statistics.** Four big numbers count up, then "The web wasn't built for shaky hands." | "More than eight and a half million people live with Parkinson's, twice as many as 25 years ago. About seven million Americans have essential tremor. And for three out of four people with Parkinson's, tremor is part of everyday life. One small slip can buy, delete or send the wrong thing." |
| **0:29–0:34** | **Scene 3: title.** A shaky line calms into a straight one: "Smooth Mouse". | "So we built Smooth Mouse." |
| **0:34–0:38** | **Scene 4: calibration card.** | "It starts with one minute of calibration." |
| **0:38–0:52** | **Recording A: calibration** at 2–3× speed: hold the dot, click the 5 circles, type the sentence. **Slow down** for the results cards and scroll through them. | "You hold still, click five circles and type one sentence. Our on-device model learns what *your* shake looks like, then Smooth Mouse recommends the protections you need, in plain words. You stay in control: every setting can be changed in the popup." |
| **0:52–0:55** | **Scene 5: Feature 01 card** (smoothing). | *(music beat)* |
| **0:55–1:06** | **Recording B: smoothing.** Demo page, **shaky hand on**, live view trails visible. Wiggle over the compose form: orange = your hand, teal = steady cursor. Then make one big fast move across the screen to show it stays quick. | "Here's a simulated tremor. Our classifier spots shaking in real time and smooths the cursor only when it needs to. Big, intentional moves stay fast." |
| **1:06–1:09** | **Scene 6: Feature 02 card** (timed clicks). | |
| **1:09–1:18** | **Recording C: timed clicks.** Quick tap on **Save draft**: toast "ignored", status line says nothing happened. Then press and hold until the ring turns teal: "Draft saved." | "Timed clicks. Calibration measures how long your accidental taps last, so quick, shaky taps are ignored and real clicks go through." |
| **1:18–1:21** | **Scene 7: Feature 03 card** (repeated keys). | |
| **1:21–1:29** | **Recording D: repeated keys.** In the message box, type "hhello" → "hello". Then type "hello" normally to show the double L stays. | "Repeated keys. A shaky double press like 'h-h-hello' becomes 'hello', but real double letters stay." |
| **1:29–1:32** | **Scene 8: Feature 04 card** (risky buttons). | |
| **1:32–1:48** | **Recording E: risky buttons.** ① Demo page, shaky hand on: click the icon-only 🗑 → "Did you mean to…?" with **Checked by Gemini**. Click "No, go back". ② **Callback to the cold open:** a shopping site product page, click **Buy now** with the shaky hand → the dialog asks first. | "And risky buttons. Gemini reads the page, even icon-only buttons like this trash can, which a word list would miss. If your hand is shaking, Smooth Mouse asks before you delete, send… or buy a $1,900 TV." |
| **1:48–2:00** | **Scene 9: outro.** "Our model understands your hands. Gemini understands the page." The four features, then the logo. | "Our model understands your hands. Gemini understands the page. Smooth Mouse: steady clicks for shaky hands." |

**Why this keeps people watching:**
- It opens on a funny, relatable mistake instead of a title card.
- The numbers come in as big animations, not a slide of text.
- Every feature gets a 3-second card, then a short clip, so the pace never drags.
- The ending pays off the opening: the same "Buy now" moment, but this time Smooth Mouse catches it.

---

## Before recording

1. **Run the local server** so Gemini works: `source .venv/bin/activate` then `python ml/server.py` (leave that terminal open). Open the demo page once *before* recording so Gemini's answers are cached and appear instantly.
2. **Reload the extension** in `about:debugging`, and run calibration once as a practice take.
3. **Popup settings for the recordings:** Smooth Mouse on, Steady cursor on, Ignore quick clicks on, Ignore repeated keys on, Risky buttons on, Use Gemini on. Shake strength about 16 px, so the shake reads clearly on video.
4. **Clean screen:** hide the bookmarks bar, close other tabs, turn on Do Not Disturb, zoom the page to 125% so text is readable on a phone.

## How to record

- **Mac:** press **Cmd + Shift + 5** → "Record Selected Portion" (or the whole screen) → Options → choose your mic if you want to record the voice at the same time.
- Alternatively, use **OBS** (free) at 1920×1080, 30 fps.
- For `video/scenes.html`: open it in a browser, press **F** for full screen, start recording, then press the scene number. Each scene holds its last frame. Press **Esc** to go back to the menu.
- Record each clip separately; it's much easier to edit than one long take.

## Editing (iMovie, CapCut or DaVinci Resolve, all free)

1. Lay out the clips in the order of the table above.
2. Speed up the calibration clip (2–3×), but keep the results screen at normal speed.
3. **Record the voice-over last**, reading the script while watching the video. Speak slowly; leave short pauses at the feature cards.
4. **Music:** a light, upbeat royalty-free track at low volume (YouTube Audio Library or CapCut's built-in library), dropped by about 70% under the voice. Let it rise during the scene cards.
5. **Sound effects** add a lot to the cold open: a mouse click when the cursor slips, a "cha-ching" on "Order placed!", and a record scratch on the cut to black.
6. **Captions:** turn on auto-captions (CapCut) and fix any mistakes. Many judges watch with the sound off.
7. Export at 1080p. Check that the final length is **under 2:00**.

## Statistics and sources

Say these numbers exactly as written in the script; they match the sources.

| Claim | Source |
|---|---|
| Over 8.5 million people worldwide live with Parkinson's (2019) | [WHO Parkinson disease technical brief, 2022](https://www.who.int/news/item/14-06-2022-launch-of-who-s-parkinson-disease-technical-brief) |
| Parkinson's prevalence has doubled in the past 25 years | Same WHO brief |
| About 7 million Americans have essential tremor, the most common movement disorder | [Louis & Ottman, 2014](https://pmc.ncbi.nlm.nih.gov/articles/PMC4137360) |
| About 3 in 4 people with Parkinson's have tremor | Clinical studies report roughly 75%, and up to 88% in one large cohort |

Extra facts you can use on Devpost or in Q&A:
- Nearly 90,000 Americans are diagnosed with Parkinson's every year ([Parkinson's Foundation](https://www.parkinson.org/blog/research/incidence-2022)).
- Parkinson's cases worldwide are projected to reach about 25 million by 2050 (BMJ, 2025).

## Honesty notes (keep these true in the video)

- The shaky cursor in the demo is our **simulator**, not a real tremor; say "simulated tremor" when it's on screen.
- The base model is trained on synthetic data; calibration personalizes it.
- "Stable / unstable" are engineering labels, **not a diagnosis**, and Smooth Mouse is not a medical device.
