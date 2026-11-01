# Litix aligner service (backend requirements)

Forced alignment needs a Python + PyTorch process. It **cannot run inside a Vercel function** (size/time limits), so it is a
separate small service that your Vercel app calls through `/api/align` (already added to `api/use-credits.js` + `vercel.json`).

## What you must provide
| Need | Details |
|---|---|
| A host that runs a Docker container | Fly.io, Render, Railway, a VPS, or a Hugging Face Space (Docker). **Not Vercel.** |
| Memory / CPU | Plan for **>= 4 GB RAM**. The MMS model is ~1.2 GB in fp32. CPU alignment of a 40 s piece is expected to take seconds to tens of seconds (**not measured here**). A GPU is optional. |
| Env on the aligner | `ALIGN_SECRET` (long random string). Optional: `ALIGN_DEVICE=cuda`, `ALIGN_VERIFICATION=/path/verification.json`. |
| Env on Vercel | `ALIGNER_URL=https://your-aligner-host` and `ALIGN_SECRET=<same string>` |
| Existing | `GROQ_API_KEYS` stays: Groq Whisper is still used for TEXT ONLY. |

## Run it
    cd aligner
    docker build -t litix-aligner .
    docker run -p 8000:8000 -e ALIGN_SECRET=changeme litix-aligner
    curl -H "X-Align-Secret: changeme" localhost:8000/health

First `/align` call downloads the model (needs internet once). Cold start is slow; keep one instance warm.

## Contract (POST /align, multipart)
`audio` = 16-bit mono 16 kHz WAV (<= 130 s), `words` = JSON array of the transcript words, `language` = `en` | `hi` | `hi-en`.
Response: exactly one entry per word, same order and text: `{index,text,start,end,score,status,reason[,roman]}`;
`status` is `ok`, `low_confidence` (timed from audio, flagged) or `unaligned` (start/end are `null`, never invented).
The server validates this contract on every response and returns HTTP 500 rather than a wrong answer.

## Language support (stated plainly)
* `en`: supported by the aligner; accuracy on your audio **unverified** until the gate passes.
* `hi`: **experimental**. Devanagari is romanized with a built-in map (approximate pronunciation). Digits are flagged (no Hindi number words).
* `hi-en`: **experimental**. Romanized Hinglish is aligned as spelled; spelling varies, so low-confidence words get flagged.
* anything else: refused (HTTP 422) -- never pretended.

## The gate (run this before trusting any language)
    python tools/verify_real_audio.py --number "paste transcript here"      # numbered words, to help you mark times
    python tools/verify_real_audio.py --clips ./clips --out verification.json
See the docstring in `tools/verify_real_audio.py` for the clip/truth format. Copy the resulting `verification.json` next to `server.py`.
