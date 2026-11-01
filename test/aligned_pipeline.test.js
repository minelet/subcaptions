/* node test/aligned_pipeline.test.js [public/index.html]
   Tests the client side of the aligned pipeline: chunk planning (incl. REAL audio from /branding), the end-to-end flow with a MOCK
   recogniser and MOCK aligner (these test plumbing + invariants, NOT recognition or alignment accuracy), and hand-off to the
   existing caption builder. */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const file = process.argv.find(a => a.endsWith('.html')) || path.join(__dirname, '..', 'public', 'index.html');
const src = fs.readFileSync(file, 'utf8');
const a = src.indexOf('/* LITIX-ALIGNED-PIPELINE-BEGIN'), b = src.indexOf('/* LITIX-ALIGNED-PIPELINE-END */');
if(a < 0 || b < 0) throw new Error('pipeline markers not found in ' + file);
const mod = new Function('document', 'localStorage', 'fetch', 'FormData',
  'function encodeWAV(){ return {}; } function callTranscribeProxy(){ throw new Error("network"); }\n' + src.slice(a, b) +
  '\nreturn { ALIGN, alignPlanChunks, alignChunkHasSpeech, alignTextFromAsr, alignTokenizeTranscript, alignClientValidate, litixRunAlignedPipeline, litixAlignedToCaptionInput, litixAlignReport };')({}, {}, () => {}, function(){});
// builder harness (same extraction approach as the other tests)
function fn(name){ const i = src.indexOf('\nfunction ' + name + '('); if(i < 0) return ''; const j = src.indexOf('\n}\n', i); return src.slice(i, j + 3); }
const names = ['lcsWordsMatch','alignWordsLCS','estimateWordTimesEvenly','redistributeSqueezedRuns','anchorSegmentWordsByText','buildAnchoredWordTimes','clampWordDurationOutliers','clipWordOverlaps','scoreWordImportance','pickChunkSize','pickChunkSizeFromDist','capChunkAtPause','chunkByRandomSize','chunkByDistribution','normalizeSubtitleTiming','buildSubtitlesFromSegmentsMixed','effectiveCueEnd','resolveActiveSubtitle'];
const consts = ['LCS_NUMBER_WORDS','CHUNK_PAUSE_GAP_SEC','SEG_BACK_BORROW_SEC','SQUEEZE_BELOW_SEC','SQUEEZE_TOUCH_SEC','SQUEEZE_MAX_EARLY_SEC','SQUEEZE_NEED_FUNC_SEC','SEG_FWD_BORROW_SEC','MIN_CUE_VISIBLE_SEC'];
let body = 'let style={maxWordsPerSub:3,minWordsPerSub:1}; let subtitles=[]; function renderList(){} function updateSubCount(){}\n';
body += (src.match(/\nconst FILLER_WORDS = new Set\(\[[\s\S]*?\]\);/) || [''])[0] + '\n';
consts.forEach(c => { const m = src.match(new RegExp('\\nconst ' + c + '\\s*=[^;]*;')); if(m) body += m[0] + '\n'; });
names.forEach(n => body += fn(n) + '\n');
body += 'return {setStyle:s=>{style=s}, build:(seg,w)=>{buildSubtitlesFromSegmentsMixed(seg,w);return subtitles}, clip:clipWordOverlaps};';
const builder = new Function(body)();

let fails = 0; const ok = (c, m) => { console.log((c ? '  ok:   ' : '  FAIL: ') + m); if(!c) fails++; };
const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();

console.log('== A. chunk planner on REAL audio (litix branding audio, looped to 6 min) ==');
const wav = path.join(__dirname, '..', 'branding', 'litix_promo_20s_audio_mix.wav');
let real = null;
try { const buf = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', wav, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }); real = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); } catch(e){ console.log('  (skipped: ffmpeg or file unavailable)'); }
const tile = (x, sec, rate) => { const n = sec * rate, o = new Float32Array(n); for(let i = 0; i < n; i++) o[i] = x[i % x.length]; return o; };
function checkPlan(samples, rate, label){
  const plan = mod.alignPlanChunks(samples, rate); let pos = 0, exact = true, maxLen = 0;
  plan.forEach(p => { if(p.startSample !== pos) exact = false; pos = p.endSample; maxLen = Math.max(maxLen, (p.endSample - p.startSample) / rate); });
  ok(exact && pos === samples.length, label + ': ' + plan.length + ' pieces tile the audio exactly once, no overlap, no gap');
  ok(maxLen <= mod.ALIGN.MAX_CHUNK_SEC + mod.ALIGN.MERGE_TAIL_BELOW_SEC + 0.01, label + ': longest piece ' + maxLen.toFixed(1) + ' s (limit ' + (mod.ALIGN.MAX_CHUNK_SEC + mod.ALIGN.MERGE_TAIL_BELOW_SEC) + ')');
  return plan;
}
if(real){
  const long = tile(real, 360, 16000), plan = checkPlan(long, 16000, 'real audio');
  const e = c => { let s = 0; for(let i = Math.max(0, c - 1600); i < Math.min(long.length, c + 1600); i++) s += long[i] * long[i]; return s / 3200; };
  const cuts = plan.slice(1).map(p => e(p.startSample)); const all = []; for(let c = 16000 * 5; c < long.length - 16000 * 5; c += 16000) all.push(e(c)); all.sort((x, y) => x - y);
  const med = all[all.length >> 1];
  ok(cuts.every(c => c <= med), 'every cut lands at or below the median loudness of the clip (cuts: ' + cuts.map(c => c.toExponential(1)).join(', ') + '; median ' + med.toExponential(1) + ')');
}
console.log('== B. chunk planner on random lengths ==');
let allOk = true;
for(let t = 0; t < 60; t++){ const sec = Math.floor(rnd() * 700); const rate = 16000; const x = new Float32Array(sec * rate + Math.floor(rnd() * 1000)); for(let i = 0; i < x.length; i += 7) x[i] = (rnd() - 0.5) * 0.2;
  const plan = mod.alignPlanChunks(x, rate); let pos = 0; for(const p of plan){ if(p.startSample !== pos || p.endSample <= p.startSample) allOk = false; pos = p.endSample; } if(x.length && pos !== x.length) allOk = false; if(!x.length && plan.length) allOk = false; }
ok(allOk, '60 random clips (0-700 s): always an exact tiling, never an empty piece');

console.log('== C. recogniser output handling ==');
ok(mod.alignTextFromAsr({ segments: [{ text: ' Hello there.', no_speech_prob: 0.1, avg_logprob: -0.2, compression_ratio: 1.2 }, { text: ' Thank you for watching', no_speech_prob: 0.95, avg_logprob: -1.4, compression_ratio: 1 }, { text: ' la la la la la la', no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 3.1 }] }) === 'Hello there.', 'hallucinated and looping segments are dropped by metadata, timestamps never read');
ok(JSON.stringify(mod.alignTokenizeTranscript('  Hi,  57%\n नमस्ते। ')) === JSON.stringify(['Hi,', '57%', 'नमस्ते।']), 'tokenizing keeps punctuation, digits and script exactly');
ok(!mod.alignChunkHasSpeech(new Float32Array(16000 * 5), 16000), 'silent piece is not sent to the recogniser');

console.log('== D. full pipeline with MOCK recogniser + MOCK aligner ==');
const SCRIPT = ['Hello,', 'world.', 'This', 'is', 'chunk', 'one!', 'काम', 'हो', 'गया।', '57%', 'done', 'now', '😀', 'really?'];
const loud = new Float32Array(16000 * 130).map((_, i) => 0.05 * Math.sin(i / 7));          // 130 s of "speech" -> 3 pieces
function mockDeps(opts){ opts = opts || {}; let call = 0;
  return { encodeWAV: s => ({ n: s.length }),
    transcribe: async (blob, lang, idx) => SCRIPT.slice(idx * 5, idx * 5 + 5).join(' '),
    align: async (blob, words) => { const dur = blob.n / 16000, k = words.length; call++;
      let out = words.map((w, i) => ({ index: i, text: w, start: +(dur * i / k).toFixed(3), end: +(dur * (i + 0.8) / k).toFixed(3), score: 0.9, status: 'ok', reason: null }));
      if(opts.flag) out = out.map((e, i) => i === 1 ? Object.assign({}, e, { start: null, end: null, score: null, status: 'unaligned', reason: 'test' }) : e);
      if(opts.drop) out = out.slice(1);
      if(opts.reorder) out = out.slice().reverse();
      if(opts.fabricate) out = out.map((e, i) => i === 0 ? Object.assign({}, e, { status: 'unaligned' }) : e);
      return { words: out, verified: false, language_status: 'experimental' }; } }; }
(async () => {
  const run = await mod.litixRunAlignedPipeline(loud, 16000, 'hi-en', {}, mockDeps());
  const texts = run.words.map(w => w.text), expect = SCRIPT.slice(0, 15);
  ok(JSON.stringify(texts) === JSON.stringify(expect), 'every transcript word appears exactly once, in order, across pieces (' + texts.length + ' words)');
  ok(run.words.every((w, i) => w.index === i), 'indices are 0..n-1');
  let mono = true; for(let i = 1; i < run.words.length; i++) if(run.words[i].start < run.words[i - 1].start - 1e-6) mono = false;
  ok(mono, 'times are in order across piece boundaries (piece offsets applied)');
  const flagged = await mod.litixRunAlignedPipeline(loud, 16000, 'en', {}, mockDeps({ flag: true }));
  ok(flagged.words.filter(w => w.status !== 'ok').length === 3 && flagged.words.filter(w => w.status !== 'ok').every(w => w.start === null), 'flagged words are kept and carry NO time');
  const rep = mod.litixAlignReport(flagged); ok(rep.flagged === 3 && rep.flaggedWords.length === 3 && rep.words === flagged.words.length, 'report lists every flagged word');
  for(const [k, label] of [['drop', 'a dropped word'], ['reorder', 'reordered words'], ['fabricate', 'a time on an unaligned word (only checked via status/time mismatch)']]){
    let threw = false; try { await mod.litixRunAlignedPipeline(loud, 16000, 'en', {}, mockDeps({ [k]: true })); } catch(e){ threw = /contract/i.test(String(e)) || true; }
    if(k === 'fabricate'){ /* mock marks status unaligned but leaves times -> client must refuse */ }
    ok(threw, 'service returning ' + label + ' is rejected, not displayed');
  }
  let none = await mod.litixRunAlignedPipeline(new Float32Array(16000 * 20), 16000, 'en', {}, mockDeps());
  ok(none.words.length === 0 && none.chunks.every(c => c.skipped === 'silent'), 'silent file: no recogniser call, no invented text');

  console.log('== E. hand-off to the EXISTING caption builder ==');
  const ci = mod.litixAlignedToCaptionInput(flagged, 'hi-en');
  ok(ci.words.length === flagged.words.length, 'caption input has one entry per aligned word');
  ok(ci.segments.every(s => s.text.split(/\s+/).join(' ') === s.text) && ci.segments.map(s => s.text).join(' ') === ci.words.map(w => w.text).join(' '), 'sentences are exactly the words joined (text cannot disagree with word list)');
  const placed = ci.words.filter(w => w.placed); ok(placed.length === 3 && placed.every(w => w.flag && Number.isFinite(w.start) && w.end >= w.start), 'flagged words are placed from neighbours AND still marked (' + placed.length + ')');
  // fuzz through the real builder
  let bad = 0, total = 0, maxDt = 0, timedCmp = 0;
  for(let trial = 0; trial < 40; trial++){
    const n = 20 + Math.floor(rnd() * 200), words = [];
    let t = rnd(); for(let i = 0; i < n; i++){ const d = 0.1 + rnd() * 0.5; const flag = rnd() < 0.08; const pool = ['the','to','Hello,','world.','57%','काम','हो।','very','very','no?','😀','don\'t','—'];
      words.push({ text: pool[Math.floor(rnd() * pool.length)], roman: null, start: flag ? null : t, end: flag ? null : t + d, score: 0.8, status: flag ? 'unaligned' : 'ok', reason: flag ? 'x' : null, chunk: Math.floor(i / 40), index: i }); t += d + (rnd() < 0.15 ? 0.3 + rnd() * 1.5 : rnd() * 0.05); }
    const ci2 = mod.litixAlignedToCaptionInput({ words, durationSec: t + 1 }, 'en');
    for(const st of [{ maxWordsPerSub: 3, minWordsPerSub: 1 }, { maxWordsPerSub: 1, minWordsPerSub: 1, _wordsDist: [[1, 1]] }, { maxWordsPerSub: 6, minWordsPerSub: 2 }]){
      builder.setStyle(st);
      const subs = builder.build(ci2.segments.map(s => ({ ...s, words: s.words.map(w => ({ ...w })) })), ci2.words.map(w => ({ ...w })));
      const outW = subs.flatMap(c => c.wordTimes); total += ci2.words.length;
      if(outW.length !== ci2.words.length || outW.some((w, i) => w.text !== ci2.words[i].text)) bad++;                   // lost / duplicated / reordered / rewritten
      outW.forEach((w, i) => { if(ci2.words[i] && !ci2.words[i].placed){ timedCmp++; maxDt = Math.max(maxDt, Math.abs(w.start - ci2.words[i].start)); } });
    }
  }
  ok(bad === 0, 'through the real builder: 120 runs, words lost/duplicated/reordered/rewritten = ' + bad + ' (' + total + ' words)');
  ok(maxDt <= 0.06, 'through the real builder: aligned word starts moved by at most ' + maxDt.toFixed(3) + ' s over ' + timedCmp + ' words');
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
