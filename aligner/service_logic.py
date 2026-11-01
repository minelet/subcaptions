"""service_logic.py -- request handling with NO web framework and NO ML import, so it is unit-testable."""
from __future__ import annotations
import io, json, wave
from typing import List, Optional, Sequence
import numpy as np
import align_core as core

MAX_AUDIO_SEC = 130.0
MAX_WORDS = 2500

class RequestError(Exception):
    def __init__(self, status: int, message: str): super().__init__(message); self.status = status

def read_wav_mono16k(data: bytes) -> np.ndarray:
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
    except Exception as e:
        raise RequestError(400, f"audio must be a PCM WAV file ({e})")
    if sw != 2 or ch != 1 or sr != 16000:
        raise RequestError(400, f"audio must be 16-bit mono 16000 Hz WAV (got {sw*8}-bit, {ch} ch, {sr} Hz)")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if len(x) / 16000.0 > MAX_AUDIO_SEC: raise RequestError(413, f"audio longer than {MAX_AUDIO_SEC:.0f} s")
    return x

class Backend:
    """Interface: align(samples, flat_tokens) -> list (one per flat token) of core.TokenSpan or None."""
    name = "abstract"
    def align(self, samples: np.ndarray, flat_tokens: Sequence[str]) -> List[Optional[core.TokenSpan]]:
        raise NotImplementedError

def align_request(wav_bytes: bytes, words: Sequence[str], lang: str, backend: Backend,
                  min_score: float = core.MIN_SCORE_DEFAULT, verified: Optional[dict] = None) -> dict:
    if lang not in core.LANGUAGE_SUPPORT:
        raise RequestError(422, f"language {lang!r} is not supported; supported: {sorted(core.LANGUAGE_SUPPORT)}")
    if not isinstance(words, (list, tuple)) or not all(isinstance(w, str) for w in words):
        raise RequestError(400, "words must be a JSON array of strings")
    if len(words) > MAX_WORDS: raise RequestError(413, f"more than {MAX_WORDS} words")
    samples = read_wav_mono16k(wav_bytes)
    dur = len(samples) / 16000.0
    prepared = core.prepare_words(words, lang)
    flat, ranges = core.flatten_tokens(prepared)
    spans: List[Optional[core.TokenSpan]] = [None] * len(flat)
    align_error = None
    if flat and dur >= 0.2:
        try:
            got = backend.align(samples, flat)
            if len(got) != len(flat): raise RuntimeError(f"backend returned {len(got)} spans for {len(flat)} tokens")
            spans = list(got)
        except Exception as e:           # alignment failed for the whole chunk: every word is FLAGGED, none deleted, none timed
            align_error = f"{type(e).__name__}: {e}"
    out = core.assemble(prepared, ranges, spans, dur, lang, min_score)
    if align_error:
        for e in out:
            if e["status"] != "unaligned": e.update(start=None, end=None, score=None, status="unaligned", reason="alignment_failed")
    core.validate_output(list(words), out, dur)              # the contract: raises -> HTTP 500, never a silently wrong answer
    v = (verified or {}).get(lang)
    return {"words": out, "summary": core.summarize(out), "audio_sec": round(dur, 3), "language": lang,
            "language_status": core.LANGUAGE_SUPPORT[lang]["status"], "verified": bool(v and v.get("passed")),
            "backend": backend.name, "error": align_error}
