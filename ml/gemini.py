"""Gemini API calls for Smooth Mouse (Google's official google-genai SDK).

The API key is read from .env on the server and NEVER reaches the extension.

Privacy rule: we only ever send summary NUMBERS and BUTTON LABELS (plus small
icon images of icon-only buttons). Never raw movement data, keystrokes, typed
text or page content.

Answers are cached (in memory and in ml/cache/gemini_cache.json, git-ignored),
so the same question is never sent twice. That keeps us under the free-tier
rate limit and makes repeat visits instant.

Every function raises GeminiUnavailable on any problem; server.py turns that
into an error response and the extension silently falls back to pre-written text.
"""

import base64
import hashlib
import json
import os
import threading
import time
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel

from features import ROOT

load_dotenv(ROOT / ".env")

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash")
# The API rejects deadlines under 10 s. The extension gives up sooner on its own
# (and falls back to pre-written text), so this only bounds the server side.
TIMEOUT_MS = 10000

_client = None


class GeminiUnavailable(Exception):
    pass


def available():
    key = os.getenv("GEMINI_API_KEY", "")
    return bool(key) and key != "your-key-here"


def _get_client():
    global _client
    if not available():
        raise GeminiUnavailable("GEMINI_API_KEY is not set in .env")
    if _client is None:
        from google import genai
        from google.genai import types

        _client = genai.Client(
            api_key=os.environ["GEMINI_API_KEY"],
            http_options=types.HttpOptions(timeout=TIMEOUT_MS),
        )
    return _client


# ---------------------------------------------------------------------------
# Cache: question → answer, kept across server restarts
# ---------------------------------------------------------------------------
CACHE_PATH = ROOT / "ml" / "cache" / "gemini_cache.json"
_cache_lock = threading.Lock()
try:
    _cache = json.loads(CACHE_PATH.read_text())
except Exception:
    _cache = {}


def cache_key(kind, payload):
    return kind + ":" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:32]


def cache_get(key):
    with _cache_lock:
        return _cache.get(key)


def cache_put(key, value):
    with _cache_lock:
        _cache[key] = value
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(_cache))


def _busy(err):
    text = str(err)
    return any(code in text for code in ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED"))


def _generate_json(prompt, schema):
    """Ask Gemini for JSON matching a pydantic schema; returns (parsed, model_used).

    Fast settings: thinking level LOW (about 1 s in our tests). If a model is
    busy (503/429) we wait a moment and retry it once; if it still fails we try
    the fallback model.
    """
    from google.genai import types

    client = _get_client()
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=schema,
        temperature=0.4,
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
    )
    errors = []
    for model in dict.fromkeys([MODEL, FALLBACK_MODEL]):  # de-duplicated, in order
        for attempt in range(2):
            try:
                response = client.models.generate_content(model=model, contents=prompt, config=config)
                if response.parsed is not None:
                    return response.parsed, model
                errors.append(f"{model}: no structured output")
                break
            except Exception as err:
                errors.append(f"{model}: {str(err)[:200]}")
                if attempt == 0 and _busy(err):
                    time.sleep(0.7)  # busy: one quick retry
                    continue
                break
    raise GeminiUnavailable(" | ".join(errors))


# ---------------------------------------------------------------------------
# /gemini/explain: plain-language calibration results
# ---------------------------------------------------------------------------

class Explanation(BaseModel):
    text: str


EXPLAIN_PROMPT = """You are the friendly voice of Smooth Mouse, a browser extension that steadies
the mouse cursor for people whose hands shake. A user just finished a one-minute
calibration. Explain their results to them.

Rules:
- 2 or 3 short sentences, warm and encouraging, plain everyday language
  (no jargon like "Hz", "RMS", "classifier" or "amplitude").
- Be SPECIFIC: use their actual numbers in everyday words. For example
  restingFluctuationPx 7 and restingFluctuationPerSecond 6 -> "your cursor moved
  about 7 pixels back and forth, about 6 times a second, while you held it still".
  If restingFluctuationPx is under 1.5, say their cursor stayed steady instead.
- Say what Smooth Mouse will do: steady the cursor when it sees that kind of
  movement and stay out of the way when they move on purpose. If the
  calmMovesWronglyFlagged numbers are present and went down, mention that their
  personal model now mistakes far fewer of their normal movements for shaking.
  Never write percentages or arrows like "13% -> 5%"; if you give these numbers,
  say "about 13 out of every 100 ... now about 5 out of 100".
- Mention missed clicks or accidental double presses only if they are above 0,
  and say Smooth Mouse can help catch those.
- If accidentalClickProtectionOn is true, say that a click now counts when they
  hold the button for about clickHoldSeconds seconds, so quick accidental taps are ignored.
- Make NO medical claims and do not guess at causes or conditions.
- End with exactly this sentence: "These are measurements of cursor movement, not a medical diagnosis."

Calibration numbers (JSON; null means not measured):
{stats}
"""


def explain(stats):
    """stats: dict of summary numbers only. Returns (explanation, model). Cached."""
    numbers = {k: v for k, v in stats.items() if v is None or isinstance(v, (int, float, bool))}
    key = cache_key("explain", numbers)
    hit = cache_get(key)
    if hit:
        return hit["text"], hit["model"]
    result, model = _generate_json(EXPLAIN_PROMPT.format(stats=json.dumps(numbers, indent=2)), Explanation)
    cache_put(key, {"text": result.text.strip(), "model": model})
    return result.text.strip(), model


# ---------------------------------------------------------------------------
# /gemini/risky: which buttons on a page are risky to click by accident?
# ---------------------------------------------------------------------------

class ButtonVerdict(BaseModel):
    id: str
    risky: bool
    action: Literal["send", "delete", "purchase", "submit", "other"]
    reason: str


RISKY_PROMPT = """You help Smooth Mouse, a browser extension for people whose hands shake.
Before a shaky click lands on a dangerous button, Smooth Mouse asks "Did you mean
to click this?". Decide which of these buttons need that check.

A button is RISKY if clicking it by accident would be hard to undo or would have
real consequences: sending or posting a message, deleting or emptying something,
buying, paying, booking or transferring money, publishing, closing an account,
leaving a group, unsubscribing, or submitting a form.
NOT risky: navigation, formatting (bold, italic), opening menus or settings,
search, previews, saving a draft, adding to a wishlist or cart, help.

For each button return:
- id: exactly as given
- risky: true or false
- action: "send", "delete", "purchase" (anything with money), "submit", or "other"
- reason: ONE short sentence starting with "This button", at most 12 words,
  e.g. "This button places an order and charges your card."
Some buttons have no text; their icon image is attached, labelled with the id.

Page title: {page_title}
Buttons (JSON):
{buttons}
"""


def classify_buttons(buttons, page_title):
    """buttons: [{id, text, ariaLabel, title, nearbyText, iconPng(base64)?}].
    Returns {id: {risky, action, reason, model}}. Cached per button."""
    from google.genai import types

    results, todo = {}, []
    for b in buttons:
        signature = {k: b.get(k) or "" for k in ("text", "ariaLabel", "title", "nearbyText", "iconPng")}
        b["_key"] = cache_key("risky", signature)
        hit = cache_get(b["_key"])
        if hit:
            results[b["id"]] = {**hit, "cached": True}
        else:
            todo.append(b)
    if not todo:
        return results

    described = [{k: b.get(k) for k in ("id", "text", "ariaLabel", "title", "nearbyText")} | {"hasIcon": bool(b.get("iconPng"))}
                 for b in todo]
    contents = [RISKY_PROMPT.format(page_title=(page_title or "")[:120], buttons=json.dumps(described, indent=1))]
    for b in todo:
        if b.get("iconPng"):
            contents.append(f"Icon for button id {b['id']}:")
            contents.append(types.Part.from_bytes(data=base64.b64decode(b["iconPng"]), mime_type="image/png"))

    verdicts, model = _generate_json(contents, list[ButtonVerdict])
    by_id = {v.id: v for v in verdicts}
    for b in todo:
        v = by_id.get(b["id"])
        if v is None:
            continue
        answer = {"risky": v.risky, "action": v.action, "reason": v.reason.strip(), "model": model}
        cache_put(b["_key"], answer)
        results[b["id"]] = answer
    return results
