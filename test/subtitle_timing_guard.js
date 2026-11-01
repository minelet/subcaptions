/* LITIX-TIMING-GUARD-BEGIN
   Checks Whisper/Groq word times against the REAL audio and fixes only large, clearly-proven errors.
   WHY: Whisper's times are sometimes wrong by whole seconds (30 s window slips, 2x / 48k-vs-44.1k stretch) and
   nothing in the transcript itself can reveal it. The audio can: speech is loud, gaps are quiet.
   SAFETY: does nothing on flat audio (constant music/noise); never touches a 20 s part that already matches;
   a shift needs 3 agreeing neighbours; a sentence and its words always move together (no re-matching, so no
   duplicated or lost words). Switch off: TG.ENABLED = false. */
const TG = {
  ENABLED: true,
  FRAME_SEC: 0.1, WINDOW_FRAMES: 200, STEP_FRAMES: 50, MAX_SHIFT_FRAMES: 400,
  MATCH_OK: 0.30, STRONG_MATCH: 0.5, FIX_MIN: 0.38, FIX_BETTER_BY: 0.25, NEED_AGREE: 3,
  STRETCH_MIN: 0.25, STRETCH_BETTER_BY: 0.2,
  STRETCHES: [0.5, 2, 44100 / 48000, 48000 / 44100],
  SEG_TOL_SEC: 0.25
};
function tgCloseShortRuns(map, value, maxLen){
  let i = 0;
  while(i < map.length){
    if(map[i] !== value){ i++; continue; }
    let j = i; while(j < map.length && map[j] === value) j++;
    if(j - i < maxLen && i > 0 && j < map.length) for(let k = i; k < j; k++) map[k] = 1 - value;
    i = j;
  }
}
// samples -> Uint8Array (1 = sound, 0 = quiet) per 0.1 s; null when there is no clear loud/quiet pattern.
function tgSoundMap(samples, rate){
  const frameLen = Math.round(rate * TG.FRAME_SEC);
  const n = Math.floor(samples.length / frameLen);
  if(n < 100) return null;
  const db = new Float32Array(n);
  for(let f = 0; f < n; f++){
    let sum = 0; const a = f * frameLen;
    for(let i = 0; i < frameLen; i++){ const v = samples[a + i]; sum += v * v; }
    db[f] = 10 * Math.log10(sum / frameLen + 1e-10);
  }
  const sorted = Float32Array.from(db).sort();
  const quiet = sorted[Math.floor(n * 0.10)], loud = sorted[Math.floor(n * 0.90)];
  if(loud - quiet < 12) return null;
  const limit = quiet + 0.3 * (loud - quiet);
  const map = new Uint8Array(n);
  for(let f = 0; f < n; f++) map[f] = db[f] > limit ? 1 : 0;
  tgCloseShortRuns(map, 0, 3);
  tgCloseShortRuns(map, 1, 2);
  return map;
}
function tgWordMap(words, frames, scale, shiftSec){
  const m = new Uint8Array(frames);
  for(const w of words){
    const a = Math.floor((w.start * scale + shiftSec) / TG.FRAME_SEC);
    const b = Math.ceil((w.end * scale + shiftSec) / TG.FRAME_SEC);
    for(let f = Math.max(0, a); f < Math.min(frames, b); f++) m[f] = 1;
  }
  return m;
}
function tgCorrelation(wm, sm, a, b, lag){
  let n = 0, sw = 0, ss = 0, sww = 0, sss = 0, sws = 0;
  for(let t = a; t < b; t++){
    const u = t + lag;
    if(t < 0 || t >= wm.length || u < 0 || u >= sm.length) continue;
    const x = wm[t], y = sm[u];
    n++; sw += x; ss += y; sww += x * x; sss += y * y; sws += x * y;
  }
  if(n < 100) return 0;
  const vx = sww - sw * sw / n, vy = sss - ss * ss / n;
  return (vx > 1e-9 && vy > 1e-9) ? (sws - sw * ss / n) / Math.sqrt(vx * vy) : 0;
}
function tgBestLag(wm, sm, a, b, maxLag){
  let best = { lag: 0, score: -1 };
  for(let lag = -maxLag; lag <= maxLag; lag++){
    const score = tgCorrelation(wm, sm, a, b, lag);
    if(score > best.score) best = { lag, score };
  }
  return best;
}
// Which sentence does each word belong to (by time only, on the ORIGINAL times).
function tgAssignWords(segs, words){
  const tol = TG.SEG_TOL_SEC;
  const buckets = segs.map(() => []);
  const leftovers = [];
  let si = -1;
  words.forEach(w => {
    const mid = (w.start + w.end) / 2;
    while(si + 1 < segs.length && segs[si + 1].start <= mid) si++;
    const nextIsClose = si + 1 < segs.length && mid >= segs[si + 1].start - tol;
    if(si >= 0 && mid <= segs[si].end) buckets[si].push(w);
    else if(nextIsClose) buckets[si + 1].push(w);
    else if(si >= 0 && mid <= segs[si].end + tol) buckets[si].push(w);
    else leftovers.push(w);
  });
  return { buckets, leftovers };
}
// Edits words[] and segments[] IN PLACE (start/end only; text is never touched). Returns a report.
function tgVerifyAgainstAudio(words, segments, sound){
  const report = { checked: false, scale: 1, shiftedParts: 0, biggestShiftSec: 0, baseScore: null };
  if(!TG.ENABLED || !sound || words.length < 15) return report;
  report.checked = true;
  const frames = sound.length;
  const shiftAll = (list, f) => list.forEach(x => { x.start = f(x.start); x.end = f(x.end); });
  const baseScore = tgBestLag(tgWordMap(words, frames, 1, 0), sound, 0, frames, 20).score;
  report.baseScore = baseScore;
  if(baseScore < TG.MATCH_OK){
    let pick = { scale: 1, score: baseScore };
    for(const s of TG.STRETCHES){
      const score = tgBestLag(tgWordMap(words, frames, s, 0), sound, 0, frames, 20).score;
      if(score > pick.score) pick = { scale: s, score };
    }
    if(pick.scale !== 1 && pick.score >= TG.STRETCH_MIN && pick.score - baseScore >= TG.STRETCH_BETTER_BY){
      shiftAll(words, t => t * pick.scale); shiftAll(segments, t => t * pick.scale);
      report.scale = pick.scale;
    }
  }
  const wm = tgWordMap(words, frames, 1, 0);
  const W = TG.WINDOW_FRAMES, S = TG.STEP_FRAMES;
  const parts = [];
  for(let a = 0; a + W <= frames; a += S){
    const here = tgBestLag(wm, sound, a, a + W, 5);
    const far = here.score >= TG.STRONG_MATCH ? null : tgBestLag(wm, sound, a, a + W, TG.MAX_SHIFT_FRAMES);
    if(here.score >= TG.MATCH_OK){ parts.push({ lag: 0, here, far }); continue; }
    const clear = far.score >= TG.FIX_MIN && far.score - here.score >= TG.FIX_BETTER_BY && Math.abs(far.lag) > 5;
    parts.push(clear ? { lag: far.lag, search: true } : { lag: null });
  }
  const found = parts.map(p => p.search ? p.lag : null);
  const agreeing = (i, L) => { let n = 0; for(let j = i - 3; j <= i + 3; j++) if(j !== i && found[j] != null && Math.abs(found[j] - L) <= 3) n++; return n; };
  parts.forEach((p, i) => { if(p.search && agreeing(i, p.lag) < TG.NEED_AGREE) p.lag = null; });
  // A part that "matched" only weakly is overruled when NEED_AGREE neighbours already hold one clear shift and this
  // part ALSO finds that same shift as its best, clearly better than where its words are now. Repeated until nothing
  // changes, so the correction can walk through a run of luckily-matching parts (typically the tail of the file,
  // where late words have fewer frames to be judged on) -- but only ever through parts that find the shift themselves.
  for(let pass = 0; pass < 8; pass++){
    let changed = false;
    parts.forEach((p, i) => {
      if(p.lag !== 0 || !p.far) return;
      const L = p.far.lag;
      if(Math.abs(L) <= 5 || p.far.score < TG.FIX_MIN || p.far.score - p.here.score < 0.1) return;
      if(agreeing(i, L) >= TG.NEED_AGREE){ p.lag = L; found[i] = L; changed = true; }
    });
    if(!changed) break;
  }
  const lagOfPart = parts.map((p, i) => {
    if(p.lag !== null) return p.lag;
    for(let d = 1; d <= 12; d++){ const near = [parts[i - d], parts[i + d]].find(q => q && q.lag !== null); if(near) return near.lag; }
    return 0;
  });
  report.lagOfPart = lagOfPart; report.partsRaw = parts.map(p => p.lag);
  if(parts.length && lagOfPart.some(l => l !== 0)){
    // The 20 s parts only say WHICH shifts exist; their edges are blurry (a part straddling a boundary). So the final
    // lag is chosen per SENTENCE: each sentence picks among the shifts found (and 0), judged on its own audio, with a
    // penalty for switching so one short sentence cannot flip alone (Viterbi over sentences).
    const W2 = W, cands = [0];
    lagOfPart.forEach(l => { if(!cands.some(c => Math.abs(c - l) <= 3)) cands.push(l); });
    const partLagAt = t => lagOfPart[Math.min(parts.length - 1, Math.max(0, Math.round((t / TG.FRAME_SEC - W2 / 2) / S)))];
    const mid = x => (x.start + x.end) / 2;
    const segs = segments.slice().sort((a, b) => a.start - b.start);
    const ws = words.slice().sort((a, b) => a.start - b.start);
    const { buckets, leftovers } = tgAssignWords(segs, ws);
    // each sentence's own word frames (a word past the end of the audio is a mismatch, never "matches silence")
    const masks = segs.map((sg, i) => {
      const a = Math.floor(sg.start / TG.FRAME_SEC) - 5, b = Math.ceil(sg.end / TG.FRAME_SEC) + 5;
      const bits = new Uint8Array(Math.max(0, b - a));
      buckets[i].forEach(w => { const f0 = Math.floor(w.start / TG.FRAME_SEC), f1 = Math.ceil(w.end / TG.FRAME_SEC); for(let f = Math.max(a, f0); f < Math.min(b, f1); f++) bits[f - a] = 1; });
      return { a, bits };
    });
    const mism = (i, lag) => { const { a, bits } = masks[i]; let n = 0; for(let k = 0; k < bits.length; k++){ const t = a + k, u = t + lag; const y = (u >= 0 && u < frames) ? sound[u] : 0; if(bits[k] !== y) n++; } return n; };
    const SWITCH = 20, PRIOR = 4;
    const n = segs.length, K = cands.length;
    const cost = [], back = [];
    for(let i = 0; i < n; i++){
      const pl = partLagAt(mid(segs[i]));
      cost.push(new Float64Array(K)); back.push(new Int32Array(K));
      for(let c = 0; c < K; c++){
        let e = mism(i, cands[c]) + (Math.abs(cands[c] - pl) <= 3 ? 0 : PRIOR);
        if(i === 0){ cost[i][c] = e; continue; }
        let best = Infinity, bp = 0;
        for(let q = 0; q < K; q++){ const v = cost[i - 1][q] + (q === c ? 0 : SWITCH); if(v < best){ best = v; bp = q; } }
        cost[i][c] = e + best; back[i][c] = bp;
      }
    }
    const pick = new Int32Array(n);
    if(n){
      let bc = 0; for(let c = 1; c < K; c++) if(cost[n - 1][c] < cost[n - 1][bc]) bc = c;
      for(let i = n - 1; i >= 0; i--){ pick[i] = bc; bc = back[i][bc]; }
    }
    // refine: each run of sentences with the same candidate gets the best exact lag within +-5 frames over the run
    const lagOfSeg = new Array(n).fill(0);
    for(let i = 0; i < n;){
      let j = i; while(j + 1 < n && pick[j + 1] === pick[i]) j++;
      let best = cands[pick[i]], bm = Infinity;
      for(let d = -5; d <= 5; d++){
        let m = 0; const L = cands[pick[i]] + d;
        for(let k = i; k <= j; k++) m += mism(k, L);
        if(m < bm - 0.5){ bm = m; best = L; }
      }
      if(cands[pick[i]] === 0 && Math.abs(best) <= 5) best = 0;      // an unshifted run is never nudged
      for(let k = i; k <= j; k++) lagOfSeg[k] = best;
      i = j + 1;
    }
    const move = (x, d) => { x.start = Math.max(0, x.start + d); x.end = Math.max(x.start, x.end + d); };
    let moved = 0, biggest = 0;
    segs.forEach((sg, i) => { const d = lagOfSeg[i] * TG.FRAME_SEC; buckets[i].forEach(w => move(w, d)); move(sg, d); if(d !== 0){ moved++; biggest = Math.max(biggest, Math.abs(d)); } });
    leftovers.forEach(w => {
      let k = 0, bd = Infinity; segs.forEach((sg, i) => { const d = Math.abs(mid(sg) - mid(w)); if(d < bd){ bd = d; k = i; } });
      move(w, n ? lagOfSeg[k] * TG.FRAME_SEC : 0);
    });
    report.shiftedParts = moved; report.biggestShiftSec = biggest; report.sentencesShifted = moved;
  }
  return report;
}
/* LITIX-TIMING-GUARD-END */
