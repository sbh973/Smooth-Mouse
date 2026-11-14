# Smooth Mouse

A browser extension (Firefox first, Chrome compatible) that helps people with hand tremors use the web. A small on-device ML model tells involuntary cursor fluctuations apart from intentional movement, and Smooth Mouse stabilizes the cursor only when it needs to.

> **Not a medical device.** The labels `stable`, `unstable` and `uncertain` are engineering labels for cursor movement, not medical diagnoses.

**Status:** Checkpoint 1: extension setup and raw movement capture. (See [CLAUDE.md](CLAUDE.md) for the full plan.)

## Project layout (so far)

```
manifest.json        Extension manifest (MV3, works in Firefox and Chrome)
content/capture.js   Records pointer, click and key events (capture phase, ~3 s buffer)
content/main.js      On/off switch, popup stats, demo-page "export recording" bridge
popup/               Toolbar popup: master switch + live debug readout
calibrate/           Calibration page (placeholder until Checkpoint 5)
demo/                Fake email compose page used for testing and the demo
shared/, ml/         Python ML pipeline + shared config (from Checkpoint 2)
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

## Privacy
All movement data stays in the page's memory. Nothing is sent over the network. The export only happens when you click the button, and it contains pointer data only, never keystrokes.
