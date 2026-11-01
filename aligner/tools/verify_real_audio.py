#!/usr/bin/env python3
"""
verify_real_audio.py -- THE GATE. Nothing is "fixed" until this passes on REAL speech that a human has hand-marked.

For each clip put two files in one folder:
    talk1.wav (or .mp4/.mp3/.m4a -- anything ffmpeg reads, <= 120 s)
    talk1.truth.json  ->
        { "language": "en" | "hi" | "hi-en",
          "transcript": "the exact words as spoken, as you want them displayed",
          "marks": [ {"index": 0, "start": 0.42}, {"index": 7, "start": 3.41}, ... ] }
    optional: talk1.asr.txt -> what your site's recogniser produced for the same clip (measures recognition separately)

  "index" = position of the word in transcript.split(). Print the numbered words with:
      python tools/verify_real_audio.py --number "the transcript text"
  "start" = the second you hear that word BEGIN (use any audio editor; mark >= 10 words per clip, spread across the clip,
  including words right after pauses and near the end).

Run:  python tools/verify_real_audio.py --clips ./clips --out verification.json
It runs the REAL acoustic aligner (needs torch + torchaudio), prints per-clip and per-language results, and writes
verification.json, which the service reports in /health. A language is marked passed only if ALL hold:
    >= MIN_CLIPS clips and >= MIN_MARKS marks;  >= 90% of marks within TOL seconds;  p95 error <= 0.6 s;
    flagged words <= 10%;  contract violations = 0;  (if .asr.txt given) word error rate is REPORTED, not gated.
"""
from __future__ import annotations
import argparse, glob, json, os, subprocess, sys, tempfile, datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import numpy as np
import align_core as core
import service_logic as logic

TOL = 0.30; MIN_WITHIN = 0.90; MAX_P95 = 0.60; MAX_FLAG_RATE = 0.10; MIN_CLIPS = 3; MIN_MARKS = 30

def to_wav16k(path: str) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "a.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", out], check=True)
        return open(out, "rb").read()

def edit_map(truth: list, hyp: list):
    """Word-level edit alignment -> (wer, {hyp_index: truth_index} for matched words)."""
    n, m = len(truth), len(hyp)
    norm = lambda w: "".join(c for c in w.lower() if c.isalnum() or c == "'")
    t, h = [norm(x) for x in truth], [norm(x) for x in hyp]
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): d[i][0] = i
    for j in range(m + 1): d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (t[i-1] != h[j-1]))
    i, j, mp = n, m, {}
    while i > 0 and j > 0:
        if d[i][j] == d[i-1][j-1] + (t[i-1] != h[j-1]):
            if t[i-1] == h[j-1]: mp[j-1] = i-1
            i -= 1; j -= 1
        elif d[i][j] == d[i-1][j] + 1: i -= 1
        else: j -= 1
    return (d[n][m] / max(1, n)), mp

def evaluate_clip(wav: bytes, truth: dict, backend, asr_text: str | None = None) -> dict:
    words = truth["transcript"].split()
    lang = truth["language"]
    res = logic.align_request(wav, words, lang, backend)            # raises on any contract violation -> counted as failure by caller
    errs, flagged_marks = [], 0
    for mk in truth["marks"]:
        e = res["words"][mk["index"]]
        if e["status"] == "unaligned" or e["start"] is None: flagged_marks += 1; errs.append(float("inf")); continue
        errs.append(abs(e["start"] - mk["start"]))
    out = {"language": lang, "words": len(words), "marks": len(errs), "errors": errs, "flagged_marks": flagged_marks,
           "flag_rate": (res["summary"]["unaligned"] + res["summary"]["low_confidence"]) / max(1, len(words)), "wer": None}
    if asr_text:
        wer, mp = edit_map(words, asr_text.split()); out["wer"] = wer
        ares = logic.align_request(wav, asr_text.split(), lang, backend)
        aerr = []
        marks = {mk["index"]: mk["start"] for mk in truth["marks"]}
        for hj, ti in mp.items():
            if ti in marks and ares["words"][hj]["start"] is not None: aerr.append(abs(ares["words"][hj]["start"] - marks[ti]))
        out["asr_matched_marks"] = len(aerr); out["asr_errors"] = aerr
    return out

def summarize(results: list) -> dict:
    by = {}
    for r in results: by.setdefault(r["language"], []).append(r)
    verdict = {}
    for lang, rs in by.items():
        errs = [e for r in rs for e in r["errors"]]; fin = sorted(e for e in errs if np.isfinite(e))
        within = sum(1 for e in errs if e <= TOL) / max(1, len(errs))
        p95 = fin[int(len(fin) * 0.95) - 1] if fin else float("inf")
        flag = float(np.mean([r["flag_rate"] for r in rs]))
        reasons = []
        if len(rs) < MIN_CLIPS: reasons.append(f"only {len(rs)} clips (need {MIN_CLIPS})")
        if len(errs) < MIN_MARKS: reasons.append(f"only {len(errs)} marks (need {MIN_MARKS})")
        if within < MIN_WITHIN: reasons.append(f"{within:.0%} within {TOL}s (need {MIN_WITHIN:.0%})")
        if p95 > MAX_P95: reasons.append(f"p95 error {p95:.2f}s (max {MAX_P95})")
        if flag > MAX_FLAG_RATE: reasons.append(f"{flag:.0%} words flagged (max {MAX_FLAG_RATE:.0%})")
        wers = [r["wer"] for r in rs if r.get("wer") is not None]
        verdict[lang] = {"passed": not reasons, "reasons": reasons, "clips": len(rs), "marks": len(errs), "within_tol": round(within, 3),
                         "median_err": round(float(np.median(fin)), 3) if fin else None, "p95_err": round(p95, 3) if np.isfinite(p95) else None,
                         "flag_rate": round(flag, 3), "tol_sec": TOL, "wer_reported": round(float(np.mean(wers)), 3) if wers else None,
                         "date": datetime.date.today().isoformat()}
    return verdict

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clips"); ap.add_argument("--out", default="verification.json"); ap.add_argument("--number", help="print numbered words of a transcript")
    a = ap.parse_args()
    if a.number:
        for i, w in enumerate(a.number.split()): print(i, w)
        return 0
    if not a.clips: ap.error("--clips is required")
    from mms_backend import MMSBackend
    backend = MMSBackend()
    results = []
    for tj in sorted(glob.glob(os.path.join(a.clips, "*.truth.json"))):
        base = tj[:-len(".truth.json")]
        media = [p for p in glob.glob(base + ".*") if not p.endswith((".json", ".txt"))]
        if not media: print("no media for", tj); return 2
        truth = json.load(open(tj, encoding="utf-8"))
        asr = open(base + ".asr.txt", encoding="utf-8").read() if os.path.exists(base + ".asr.txt") else None
        r = evaluate_clip(to_wav16k(media[0]), truth, backend, asr); results.append(r)
        fin = sorted(e for e in r["errors"] if np.isfinite(e))
        print(f"{os.path.basename(base)} [{r['language']}]: {r['marks']} marks, median {np.median(fin) if fin else float('nan'):.2f}s, "
              f"within {TOL}s: {sum(e <= TOL for e in r['errors'])}/{r['marks']}, flagged {r['flag_rate']:.0%}" + (f", WER {r['wer']:.0%}" if r["wer"] is not None else ""))
    v = summarize(results); json.dump(v, open(a.out, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    for lang, x in v.items(): print(f"== {lang}: {'PASSED' if x['passed'] else 'NOT PASSED'}" + ("" if x["passed"] else " -- " + "; ".join(x["reasons"])))
    return 0 if v and all(x["passed"] for x in v.values()) else 1

if __name__ == "__main__": sys.exit(main())
