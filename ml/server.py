"""Smooth Mouse local server (FastAPI) on http://localhost:8000.

Start it from the repo root, with the virtual environment active:
    python ml/server.py

Two jobs, and it is NEVER in the real-time cursor loop:
  1. Calibration retraining (POST /calibrate): one request, a few seconds.
  2. Proxying Gemini calls (POST /gemini/...) so the API key stays in .env
     on this computer and never sits in extension code.

It only listens on 127.0.0.1 (this computer). The extension works without it.
"""

import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import gemini
import personalize
from features import load_config


@asynccontextmanager
async def lifespan(_app):
    # Load (or build once) the base dataset so the first calibration is fast.
    personalize.load_base(load_config())
    print(f"Ready. Gemini: {'on (' + gemini.MODEL + ')' if gemini.available() else 'off (no GEMINI_API_KEY in .env)'}", flush=True)
    yield


app = FastAPI(title="Smooth Mouse local server", lifespan=lifespan)

# Only extension pages (and local pages) may call this server.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(moz-extension|chrome-extension)://[^/]+$|^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class Sample(BaseModel):
    t: float
    x: float
    y: float


class CalibrateRequest(BaseModel):
    measurements: dict = Field(default_factory=dict)  # summary numbers measured in the browser
    profile: dict = Field(default_factory=dict)       # thresholds computed in the browser
    hold: list[Sample] = Field(default_factory=list, max_length=20000)
    reach: list[Sample] = Field(default_factory=list, max_length=60000)


@app.get("/health")
def health():
    return {"ok": True, "gemini": gemini.available(), "geminiModel": gemini.MODEL if gemini.available() else None}


@app.post("/calibrate")
def calibrate(req: CalibrateRequest):
    start = time.perf_counter()
    model, report = personalize.personalize(
        req.measurements,
        [s.model_dump() for s in req.hold],
        [s.model_dump() for s in req.reach],
    )
    report["seconds"] = round(time.perf_counter() - start, 2)
    print(f"Calibrated in {report['seconds']} s: {report}", flush=True)
    return {"model": model, "profile": req.profile, "report": report}


@app.post("/gemini/explain")
def gemini_explain(stats: dict):
    try:
        text, model = gemini.explain(stats)
        return {"text": text, "source": "gemini", "model": model}
    except gemini.GeminiUnavailable as err:
        print("Gemini explain failed:", err, flush=True)
        raise HTTPException(status_code=503, detail="Gemini unavailable")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
