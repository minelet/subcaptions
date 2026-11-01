"""server.py -- HTTP wrapper (FastAPI). Run:  ALIGN_SECRET=... uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1"""
import json, os, threading
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
import align_core as core
import service_logic as logic

SECRET = os.environ.get("ALIGN_SECRET", "")
VERIFICATION_FILE = os.environ.get("ALIGN_VERIFICATION", os.path.join(os.path.dirname(__file__), "verification.json"))
app = FastAPI(title="Litix aligner")
_backend = None
_lock = threading.Lock()          # one alignment at a time: the model is large and CPU-bound

def backend():
    global _backend
    if _backend is None:
        from mms_backend import MMSBackend
        _backend = MMSBackend(os.environ.get("ALIGN_DEVICE", "cpu"))
    return _backend

def verification() -> dict:
    try:
        with open(VERIFICATION_FILE, encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def check(secret):
    if not SECRET: raise HTTPException(503, "ALIGN_SECRET is not configured")
    if secret != SECRET: raise HTTPException(401, "bad secret")

@app.get("/health")
def health(x_align_secret: str = Header(default="")):
    check(x_align_secret)
    v = verification()
    return {"ok": True, "model_loaded": _backend is not None,
            "languages": {k: {**s, "verified": bool(v.get(k, {}).get("passed"))} for k, s in core.LANGUAGE_SUPPORT.items()}}

@app.post("/align")
async def align(audio: UploadFile = File(...), words: str = Form(...), language: str = Form(...),
                x_align_secret: str = Header(default="")):
    check(x_align_secret)
    try: wl = json.loads(words)
    except Exception: raise HTTPException(400, "words must be JSON")
    data = await audio.read()
    def work():
        with _lock:
            return logic.align_request(data, wl, language, backend(), verified=verification())
    try: return await run_in_threadpool(work)
    except logic.RequestError as e: raise HTTPException(e.status, str(e))
    except core.AlignmentContractError as e: raise HTTPException(500, f"contract violation: {e}")
