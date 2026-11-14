"""Gemini API calls for Smooth Mouse (Google's official google-genai SDK).

The API key is read from .env on the server and NEVER reaches the extension.

Privacy rule: we only ever send summary NUMBERS (and, from Checkpoint 7,
button labels). Never raw movement data, keystrokes or typed text.

Every function raises GeminiUnavailable on any problem; server.py turns that
into an error response and the extension silently falls back to pre-written text.
"""

import json
import os

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


def _generate_json(prompt, schema):
    """Ask Gemini for JSON matching a pydantic schema; returns (parsed, model_used).

    Fast settings: thinking level LOW (about 1 s in our tests). If the main
    model is busy or fails, we try the fallback model once.
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
        try:
            response = client.models.generate_content(model=model, contents=prompt, config=config)
            if response.parsed is not None:
                return response.parsed, model
            errors.append(f"{model}: no structured output")
        except Exception as err:
            errors.append(f"{model}: {str(err)[:200]}")
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
- Mention missed clicks or accidental double presses only if they are above 0,
  and say Smooth Mouse can help catch those.
- Make NO medical claims and do not guess at causes or conditions.
- End with exactly this sentence: "These are measurements of cursor movement, not a medical diagnosis."

Calibration numbers (JSON; null means not measured):
{stats}
"""


def explain(stats):
    """stats: dict of summary numbers only. Returns a short explanation string."""
    numbers = {k: v for k, v in stats.items() if v is None or isinstance(v, (int, float, bool))}
    result, model = _generate_json(EXPLAIN_PROMPT.format(stats=json.dumps(numbers, indent=2)), Explanation)
    return result.text.strip(), model
