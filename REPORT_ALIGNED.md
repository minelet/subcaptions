# Litix: aligned-subtitle pipeline -- report

**STATUS: NOT YET VERIFIED ON REAL SPEECH. Do not call it fixed until `aligner/tools/verify_real_audio.py` passes on your real clips.**
Built from `litix_site_updated_28` (all newer site features kept). The old v3 copy was not used.

## The architecture (what you asked for)
1. **Recogniser = text only.** Groq Whisper is called with an explicit `language` (the old code never sent one, so Hindi/Hinglish relied on
   auto-detect) and **no timestamp granularities**. Only segment *metadata* (no-speech / repetition scores) is used to drop hallucinated text.
2. **Forced alignment = every time.** The exact text + audio go to `aligner/` (MMS CTC aligner). Whisper times are never requested or read.
3. **One word list.** Output is exactly one entry per transcript word, same order and text (`aligner/align_core.py::validate_output`, enforced
   again in the browser and by the Vercel proxy path). Captions are built from those words directly: no matching, claiming, de-duplication or repair.
4. **Failure is visible.** A word that cannot be aligned is `unaligned` (time `null`) or `low_confidence`; it is kept, flagged, listed in
   `window.__litixAlign.flaggedWords`, and announced. For on-screen placement only, an untimed word borrows the gap between its timed
   neighbours (`placed:true`) -- it is never given a fabricated *recorded* time.
5. **Silence-cut chunks, no overlap**, so nothing is transcribed twice and no stitching/dedupe is needed. Pure-silence pieces never reach the recogniser.
6. **Preview and every export** still call the same `resolveActiveSubtitle` on the same clock (unchanged).
7. **Hindi / English / Romanized Hinglish are explicit** (`LANGUAGE_SUPPORT`): en supported, hi and hi-en *experimental*, anything else refused.
   Digits in Hindi/Hinglish are flagged, not guessed. Display romanization of Devanagari is a deterministic 1:1 map -- not an LLM rewrite.

## Components replaced, and why (nothing is deleted yet)
In aligned mode these are **skipped** by `!aligned` guards. The legacy path remains as an *announced* fallback (notice + console warning) only
when the aligner is not configured/reachable. **Delete after the gate passes** (list, so you can review):
| Component | Why it goes |
|---|---|
| Whisper `timestamp_granularities` word/segment times | The unreliable part; replaced by alignment. |
| 100 s chunks with 5 s overlap + `usableEnd` dedupe | Stitching created duplicates/gaps; replaced by silence-cut, no overlap. |
| `auditTimeBase`, `tgVerifyAgainstAudio` (timing guard), `refineWordBoundariesWithAudio`, leading-word drop | All exist to repair Whisper times; unnecessary when times come from alignment. |
| `normalizeLanguageOutput` (LLM Hindi/Hinglish rewrite) | It rewrote text and its prompt *translated English words into Hindi* -- violates "preserve the spoken language". |
| In the builder: `anchorSegmentWordsByText`, orphan handling, `redistributeSqueezedRuns`, `clampWordDurationOutliers`, fuzzy LCS | Only needed while sentence text and word list can disagree. (Aligned input bypasses them; legacy input still uses them.) |
**Kept:** the decoder timestamp fix (real bug, verified in Chrome), grouping/line-budget/templates, preview/export, credits/reconcile.

## Verified here (automated: `./run_tests.sh`, all pass)
* Contract layer (Python): 300 randomized runs incl. emoji, digits, Devanagari, failing/partial backends: nothing lost/duplicated/reordered/rewritten; 8 mutation tests prove the validator catches dropped, duplicated, reordered, rewritten, fabricated, out-of-range and overlapping entries.
* Vercel proxy: auth/credit/size/type checks and secret forwarding against a fake upstream; explicit 503/504 when unconfigured/unreachable.
* Client: chunk planner tiles audio exactly once (60 random lengths + **real audio from your /branding files** looped to 6 min); pipeline with mock recogniser+aligner keeps every word in order across pieces; service responses that drop, reorder or fabricate are rejected; through your **real caption builder** 120 randomized runs (14,841 words): 0 lost/duplicated/reordered, aligned word starts moved by 0.000 s.
* Earlier work still passing: decoder timestamp fix in real Chrome (late start 52% -> 100%, 10 s hole 82% -> 100%), caption test on your real Groq fixture, builder fuzz, timing guard.
* Page loads in real Chrome with no script errors.

## NOT verified (honest list)
* **Recognition accuracy** (Whisper's words) on any real audio. No model can guarantee every word is right; the caption editor is still the safety net.
* **Alignment accuracy on real speech** -- the MMS aligner was never run: this sandbox has no network, no torch, no models, no speech clips. `mms_backend.py` is written against torchaudio's documented API but has **never been executed**. Expect to fix small integration errors on first run.
* Hindi/Hinglish alignment quality, the romanization map's fit to the acoustic model, `hi-en` prompt effect on Whisper (Roman vs Devanagari output).
* CPU speed/memory of the aligner; Vercel 60 s limit per piece (pieces are <= ~55 s of audio; slow CPUs may time out -> explicit 504, use a GPU or smaller pieces via `ALIGN.TARGET_CHUNK_SEC`).
* No end-to-end click-through in the page. AAC/MP4 decode in a browser.
* The gate's thresholds (90% of marks within 0.30 s, p95 <= 0.6 s, <= 10% flagged, >= 3 clips and >= 30 marks per language) are my choice; adjust at the top of `verify_real_audio.py`.

## What you do next (about an hour, no coding)
1. Deploy `aligner/` (see `aligner/README.md`), set `ALIGNER_URL` + `ALIGN_SECRET` on Vercel.
2. Make >= 3 short clips per language you care about (en, hi, hi-en), real speech, mark ~10 word start times each, run the gate.
3. Only if a language PASSES, treat it as verified; `/health` then reports `verified:true`. Then ask me to delete the legacy components above.
Force modes while testing: `localStorage.litixAlignMode = 'service'` (error instead of fallback) or `'legacy'`.
