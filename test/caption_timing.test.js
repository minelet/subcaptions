/* Litix caption-timing regression test.
   Usage:  node caption_timing.test.js [path/to/index.html] [--report]
   Extracts the real functions from index.html (no copy/paste of logic), stubs the
   DOM-only helpers, and replays the 19-25s "to the nine forms" case from the bug
   report plus a seeded synthetic clip. Without --report it asserts and exits 1 on
   failure; with --report it only prints numbers (used for before/after tables). */
const fs = require('fs'), path = require('path');
const file = process.argv.find(a => a.endsWith('.html')) || path.join(__dirname, '..', 'public', 'index.html');
const REPORT = process.argv.includes('--report');
const src = fs.readFileSync(file, 'utf8');

function fn(name){                       // top-level function: from "function name(" to the first col-0 "}"
  const a = src.indexOf('\nfunction ' + name + '(');
  if(a < 0) return '';
  const b = src.indexOf('\n}\n', a);
  return src.slice(a, b + 3);
}
function cnst(name){                     // single-line top-level const
  const m = src.match(new RegExp('\\nconst ' + name + '\\s*=[^;]*;'));
  return m ? m[0] : '';
}
const names = ['alignWordsLCS','estimateWordTimesEvenly','redistributeSqueezedRuns','anchorSegmentWordsByText','buildAnchoredWordTimes',
  'clampWordDurationOutliers','clipWordOverlaps','scoreWordImportance','pickChunkSize','pickChunkSizeFromDist',
  'capChunkAtPause','chunkByRandomSize','chunkByDistribution','normalizeSubtitleTiming',
  'buildSubtitlesFromSegmentsMixed','effectiveCueEnd','resolveActiveSubtitle'];
const consts = ['CHUNK_PAUSE_GAP_SEC','SEG_BACK_BORROW_SEC','SQUEEZE_BELOW_SEC','SQUEEZE_TOUCH_SEC','SQUEEZE_MAX_EARLY_SEC','SQUEEZE_NEED_FUNC_SEC','SEG_FWD_BORROW_SEC','MIN_CUE_VISIBLE_SEC'];
let body = 'let style={maxWordsPerSub:3,minWordsPerSub:1}; let subtitles=[]; function renderList(){} function updateSubCount(){}\n';
body += (src.match(/\nconst FILLER_WORDS = new Set\(\[[\s\S]*?\]\);/) || [''])[0] + '\n';
consts.forEach(c => { const m = src.match(new RegExp('\\nconst ' + c.replace(/[,]/g,'\\s*,\\s*') + '\\s*=[^;]*;')); if(m) body += m[0] + '\n'; });
names.forEach(n => body += fn(n) + '\n');
body += 'return {setStyle:s=>{style=s}, build:(seg,w)=>{buildSubtitlesFromSegmentsMixed(seg,w);return subtitles}, resolve:(t)=>resolveActiveSubtitle(subtitles,t), eff:(i)=>(typeof effectiveCueEnd!=="undefined"?effectiveCueEnd(subtitles,i):subtitles[i].end), hasHold:typeof effectiveCueEnd!=="undefined"};';
const api = new Function(body)();

let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const realRandom = Math.random;
function withSeed(s, f){ seed = s; Math.random = rnd; try{ return f(); } finally { Math.random = realRandom; } }
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const W = (text, start, end) => ({ text, start, end });
let failures = 0;
const check = (ok, msg) => { if(!ok){ failures++; console.log('  FAIL:', msg); } else console.log('  ok:  ', msg); };

/* ---------- 1. the 19-25s case from the report (words outside 18.8-26 are synthetic filler) ---------- */
const segs = [
  { start: 15.58, end: 20.44, text: 'Apart from that, Navaratri or the nine nights are dedicated' },
  { start: 20.44, end: 26.68, text: 'to the nine forms of Devi, three into three.' }];
const raw = [W('Apart',15.60,16.00),W('from',16.00,16.30),W('that,',16.30,16.70),W('Navaratri',16.90,17.60),
  W('or',17.60,17.80),W('the',17.80,18.84),W('nine',18.84,19.08),W('nights',19.08,19.32),W('are',19.74,19.90),
  W('dedicated',19.90,19.94),W('to',19.94,20.36),W('the',21.93,22.46),W('nine',22.74,23.12),W('forms',23.12,24.14),
  W('of',24.14,24.16),W('Devi,',24.16,24.18),W('three',25.00,25.30),W('into',25.30,25.60),W('three.',25.60,26.00)];

function runCase(label, style, seeds){
  let worst = { toLate: 0, dedMin: undefined, toStart: 0, theStart: 0, silent: 0, maxStartMove: 0, over: 0, notOne: 0 };
  for(const sd of seeds){
    api.setStyle(style);
    const subs = withSeed(sd, () => api.build(segs, raw.map(w => ({...w}))));
    const all = subs.flatMap(c => c.wordTimes);
    const to = all.find(w => norm(w.text) === 'to'), the2 = all.filter(w => norm(w.text) === 'the').find(w => w.start > 21);
    worst.toStart = Math.max(worst.toStart, to.start < 19.94 - 0.001 ? 1 : 0); // never earlier than raw
    worst.theStart = Math.max(worst.theStart, Math.abs(the2.start - 21.93));
    // render-level check: nothing visible between 20.40 and 21.90
    let silent = 0; for(let t = 20.60; t < 21.90; t += 0.01) if(api.resolve(t)) silent++; // 20.36 real end + max 0.2s render hold
    worst.silent = Math.max(worst.silent, silent);
    // start drift vs raw, matched in order by text
    // only squeezed raw words (<0.10s) and the touching neighbours that lend them time may move
    const mayMove = k => { const sq = i => i >= 0 && i < raw.length && (raw[i].end - raw[i].start) < 0.10; return sq(k) || sq(k - 1) || sq(k + 1); };
    let j = 0; all.forEach(w => { for(let q = j; q < raw.length; q++) if(norm(raw[q].text) === norm(w.text)){ if(!mayMove(q)) worst.maxStartMove = Math.max(worst.maxStartMove, Math.abs(w.start - raw[q].start)); worst.toLate = Math.max(worst.toLate || 0, norm(w.text) === 'to' && Math.abs(raw[q].start - 19.94) < 0.01 ? w.start - raw[q].start : 0); if(norm(w.text) === 'dedicated') worst.dedMin = Math.min(worst.dedMin === undefined ? 9 : worst.dedMin, w.end - w.start); j = q + 1; break; } });
    subs.forEach(c => { const n = c.text.trim().split(/\s+/).length; if(n > style.maxWordsPerSub) worst.over++; if(style._wordsDist && n !== 1) worst.notOne++; });
  }
  console.log(`\n[${label}]`, JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k,v]) => [k, +v.toFixed(3)]))));
  return worst;
}
const seeds = Array.from({length: 40}, (_, i) => i + 1);
const A = runCase('3-word template', { maxWordsPerSub: 3, minWordsPerSub: 1 }, seeds);
const B = runCase('1-word template (_wordsDist)', { maxWordsPerSub: 1, minWordsPerSub: 1, _wordsDist: [[1, 1]] }, seeds);
if(!REPORT){
  console.log('\nAssertions (19-25s case, 40 random chunkings x 2 templates):');
  [A, B].forEach((r, i) => {
    const t = i ? '1-word' : '3-word';
    check(r.toStart === 0 && r.toLate <= 0.25, `${t}: "to" is never earlier than raw 19.94 and at most 0.25s later (later by ${r.toLate.toFixed(3)}s, gives "dedicated" its time)`);
    check(r.dedMin >= 0.15, `${t}: "dedicated" now lasts >=0.15s (was 0.04s; min ${r.dedMin.toFixed(3)}s)`);
    check(r.theStart <= 0.05, `${t}: "the" starts at 21.93 (max deviation ${r.theStart.toFixed(3)}s)`);
    check(r.silent === 0, `${t}: nothing visible in the 20.60-21.90 silence (real silence 20.36-21.93; up to 0.2s render hold allowed) (${r.silent} visible samples)`);
    check(r.maxStartMove <= 0.05, `${t}: no non-squeezed word start moved >50ms from raw (max ${r.maxStartMove.toFixed(3)}s)`);
    check(r.over === 0, `${t}: never exceeds maxWordsPerSub`);
  });
  check(B.notOne === 0, '1-word template: every cue is exactly 1 word');
}

/* ---------- 2. seeded synthetic 180s clip: before/after counters (diagnostics 1 and 2) ---------- */
function synth(sd){
  seed = sd; const R = rnd;
  const content = ['navaratri','festival','devotion','goddess','prayer','temple','celebrate','tradition','powerful','energy','colours','dance','nine','nights','forms'];
  const func = ['to','the','of','is','a','and','in','for','are','we','it','on'];
  const truth = [], rawW = [], segsS = []; let t = 1;
  while(t < 178){
    const n = 6 + Math.floor(R() * 7), sw = [], segStartIdx = truth.length;
    for(let i = 0; i < n; i++){
      const w = (R() < 0.45 ? func : content)[Math.floor(R() * (R() < 0.45 ? func.length : content.length))] || 'the';
      const txt = (i === n - 1) ? w + '.' : w;
      const d = 0.07 + 0.045 * w.length * (0.7 + R() * 0.6);
      truth.push({ text: txt, start: t, end: t + d }); sw.push(txt);
      t += d + (R() < 0.12 ? 0.35 + R() * 0.9 : R() * 0.06);      // occasional real mid-sentence pause
    }
    const segS = truth[segStartIdx].start - (R() < 0.5 ? R() * 0.15 : 0), segE = truth[truth.length - 1].end + R() * 0.3;
    segsS.push({ start: segS, end: segE, text: sw.join(' ') });
    t += 0.3 + R() * 1.0;
  }
  // Whisper-like raw words: noisy starts, end = next start (absorbs pauses), a few squeezed words,
  // and some sentence-initial words stamped 0.1-0.6s early (the "to" case: before seg.start).
  truth.forEach((w, i) => {
    let s = w.start + (R() - 0.5) * 0.06;
    const first = segsS.some(sg => Math.abs(sg.start - w.start) < 0.2 && i > 0 && truth[i-1].end < w.start - 0.2);
    if(first && R() < 0.45) s = w.start - (0.1 + R() * 0.5);
    rawW.push({ text: w.text, start: s, end: w.end });
  });
  rawW.sort((a, b) => a.start - b.start);
  rawW.forEach((w, i) => { const nx = rawW[i + 1]; if(nx && R() < 0.65) w.end = Math.max(w.start + 0.02, nx.start); else if(R() < 0.1) w.end = w.start + 0.03; });
  return { truth, rawW, segsS };
}
function metrics(style, sdList){
  const tot = { cues: 0, cueShort: 0, effShort: 0, wordShort: 0, off50: 0, matched: 0, earlyVsTrue: 0, silentVisibleSec: 0, over: 0, notOne: 0, words: 0 };
  sdList.forEach(sd => {
    const { truth, rawW, segsS } = synth(sd);
    api.setStyle(style);
    const subs = withSeed(sd, () => api.build(segsS, rawW.map(w => ({...w}))));
    tot.cues += subs.length; tot.cueShort += subs.filter(c => c.end - c.start < 0.35).length;
    subs.forEach(c => {
      const wt = c.wordTimes || [], n = c.text.trim().split(/\s+/).length;
      if(wt.length && Math.min(...wt.map(w => w.end - w.start)) < 0.15) tot.wordShort++;
      if(n > style.maxWordsPerSub) tot.over++; if(style._wordsDist && n !== 1) tot.notOne++;
    });
    // effective (render-time) cues still under the 0.30s minimum (next cue starts too soon to hold)
    subs.forEach((c, i) => { if(api.eff(i) - c.start < 0.299) tot.effShort++; });
    const wt = subs.flatMap(c => c.wordTimes || []); tot.words += wt.length;
    let j = 0; wt.forEach(w => { const k = norm(w.text); for(let q = j; q < Math.min(j + 6, rawW.length); q++){ if(norm(rawW[q].text) === k){ tot.matched++; if(Math.abs(w.start - rawW[q].start) > 0.05) tot.off50++; j = q + 1; break; } } });
    // accuracy vs ground truth: words shown >50ms before they were truly spoken
    let ti = 0; wt.forEach(w => { for(let q = ti; q < Math.min(ti + 6, truth.length); q++){ if(norm(truth[q].text) === norm(w.text)){ if(w.start < truth[q].start - 0.05) tot.earlyVsTrue++; ti = q + 1; break; } } });
    // caption visible (render-level) while nobody is speaking, inside true silences > 0.4s (first 0.25s excluded)
    for(let q = 0; q < truth.length - 1; q++){
      const g0 = truth[q].end, g1 = truth[q + 1].start; if(g1 - g0 <= 0.4) continue;
      for(let t = g0 + 0.25; t < g1; t += 0.01) if(api.resolve(t)) tot.silentVisibleSec += 0.01;
    }
  });
  return tot;
}
const sdl = [11, 12, 13, 14, 15];
const M3 = metrics({ maxWordsPerSub: 3, minWordsPerSub: 1 }, sdl);
const M1 = metrics({ maxWordsPerSub: 1, minWordsPerSub: 1, _wordsDist: [[1, 1]] }, sdl);
const fmt = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]));
console.log('\nSynthetic 5 x ~180s clips (seeded):');
console.log(' 3-word template :', JSON.stringify(fmt(M3)));
console.log(' 1-word template :', JSON.stringify(fmt(M1)));
if(!REPORT){
  check(M1.notOne === 0, 'synthetic: 1-word template stays exactly 1 word per cue');
  check(M3.over === 0 && M1.over === 0, 'synthetic: maxWordsPerSub never exceeded');
}

/* ---------- 3. real Whisper output from the Cosmic Bubble bug report (fixture) ---------- */
{
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'litix_debug_cosmic_bubble.json'), 'utf8'));
  api.setStyle({ maxWordsPerSub: 1, minWordsPerSub: 1, _wordsDist: [[1, 1]] });
  const subs = withSeed(7, () => api.build(d.rawSegments, d.rawWords.map(w => ({...w}))));
  const vis = i => api.eff(i) - subs[i].start;
  const L = x => subs.filter((c, i) => vis(i) < x).length;
  console.log(`\nReal clip (${d.rawWords.length} words): cues visible <0.12s: ${L(0.12)} (old code in the user's run: ${d.subs.filter(c => c.end - c.start < 0.12).length}), <0.20s: ${L(0.20)} (old: ${d.subs.filter(c => c.end - c.start < 0.20).length}), of ${subs.length}`);
  const find = (txt, near) => { let b = null; subs.forEach((c, i) => { if(norm(c.text) === norm(txt) && (b === null || Math.abs(c.start - near) < Math.abs(subs[b].start - near))) b = i; }); return b; };
  // [word, raw start from the dump, min on-screen seconds we require]
  [['is',1.66,0.14],['about',1.68,0.15],['thing,',9.65,0.15],['be',13.95,0.09],['dedicated',19.90,0.15],['to',19.94,0.14],
   ['Lakshmi.',36.71,0.15],['unfortunately,',55.58,0.15],['of',51.79,0.12],['ignorance.',51.81,0.15],['everywhere.',75.26,0.15]].forEach(([w, near, min]) => {
    const i = find(w, near); const shown = i === null ? 0 : vis(i);
    if(!REPORT) check(shown >= min, `real clip: "${w}" (raw ${near}s) stays on screen ${shown.toFixed(2)}s (need >=${min}s)`);
  });
  // no word may show EARLIER than 0.6s before its raw start (starts only move earlier when a stuck word lent its time)
  let maxEarly = 0, j = 0; const flatW = subs.flatMap(c => c.wordTimes);
  flatW.forEach(w => { for(let q = j; q < Math.min(j + 6, d.rawWords.length); q++) if(norm(d.rawWords[q].text) === norm(w.text)){ maxEarly = Math.max(maxEarly, d.rawWords[q].start - w.start); j = q + 1; break; } });
  console.log(`  max shown-earlier-than-raw: ${maxEarly.toFixed(2)}s`);
  if(!REPORT){
    check(maxEarly <= 0.3001, 'real clip: no word starts more than 0.30s before its raw start (accuracy guard)');
    check(subs.every(c => c.text.trim().split(/\s+/).length === 1), 'real clip: 1-word template, every cue is exactly 1 word');
    check(L(0.12) <= 12, `real clip: at most 12 cues visible <0.12s (got ${L(0.12)})`);
  }
}

if(!REPORT){ console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED'); process.exit(failures ? 1 : 0); }
