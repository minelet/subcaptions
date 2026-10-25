/* Litix subtitle-engine test.   Usage:  node test/subtitle_engine.test.js [path/to/index.html]
   Pulls the REAL engine block out of index.html (between the START/END banner comments), stubs the page
   (DOM, server), and checks: no lost words, no random reshuffling, no flash words, language detection,
   chunk offsets, invented-text removal. Prints "ALL PASSED" or the failing line. */
const fs = require('fs'), path = require('path');
const file = process.argv.find(a => a.endsWith('.html')) || path.join(__dirname, '..', 'public', 'index.html');
const src = fs.readFileSync(file, 'utf8');

/* --- pull code out of index.html --- */
const START = src.indexOf('LITIX SUBTITLE ENGINE — START');
const ENDM = src.indexOf('LITIX SUBTITLE ENGINE — END');
if(START < 0 || ENDM < 0) { console.log('FAIL: engine banner comments not found in', file); process.exit(1); }
const engine = src.slice(src.lastIndexOf('/*', START), src.indexOf('\n', ENDM));
function fn(name){ const a = src.indexOf('\nfunction ' + name + '('); if(a < 0) throw new Error('missing helper ' + name); const b = src.indexOf('\n}\n', a); return src.slice(a, b + 3); }
const fillers = (src.match(/\nconst FILLER_WORDS = new Set\(\[[\s\S]*?\]\);/) || [''])[0];

const body = `
  let style = {maxWordsPerSub:3, minWordsPerSub:1};
  let subtitles = [], rawWords = [], rawSegments = [];
  const calls = []; let proxy = null;
  function renderList(){} function updateSubCount(){} function enforceLineBudget(){ return false; }
  async function callTranscribeProxy(endpoint, form){ calls.push(endpoint); return proxy(endpoint, form); }
  ${fillers}
  ${['estimateWordTimesEvenly','clipWordOverlaps','scoreWordImportance','normalizeSubtitleTiming'].map(fn).join('\n')}
  ${engine}
  return {
    setStyle: s => { style = s; },
    build: (segs, words) => { rawSegments = segs; rawWords = words; buildSubtitles(); return subtitles; },
    setProxy: p => { proxy = p; calls.length = 0; }, calls,
    transcribeChunk, isHallucinatedSegment, dropLeadingBlip, rescaleIfTimeAxisStretched, normWord, friendlyError, ENGINE
  };`;
global.window = global.window || {};
const api = new Function(body)();

let failures = 0;
const check = (ok, msg) => { if(!ok){ failures++; console.log('  FAIL:', msg); } else console.log('  ok:  ', msg); };
const W = (text, start, end) => ({ text, start, end });
const norm = api.normWord;
const clone = o => JSON.parse(JSON.stringify(o));

/* ---- 1. the "to the nine forms" case (stuck words: 'dedicated' 0.04s, 'of' 0.02s, 'Devi,' 0.02s) ---- */
console.log('\n1. stuck-word case');
const segs = [
  { start: 15.58, end: 20.44, text: 'Apart from that, Navaratri or the nine nights are dedicated' },
  { start: 20.44, end: 26.68, text: 'to the nine forms of Devi, three into three.' }];
const raw = [W('Apart',15.60,16.00),W('from',16.00,16.30),W('that,',16.30,16.70),W('Navaratri',16.90,17.60),
  W('or',17.60,17.80),W('the',17.80,18.84),W('nine',18.84,19.08),W('nights',19.08,19.32),W('are',19.74,19.90),
  W('dedicated',19.90,19.94),W('to',19.94,20.36),W('the',21.93,22.46),W('nine',22.74,23.12),W('forms',23.12,24.14),
  W('of',24.14,24.16),W('Devi,',24.16,24.18),W('three',25.00,25.30),W('into',25.30,25.60),W('three.',25.60,26.00)];
for(const st of [{maxWordsPerSub:3,minWordsPerSub:1},{maxWordsPerSub:1,minWordsPerSub:1,_wordsDist:[[1,1]]},{maxWordsPerSub:5,minWordsPerSub:2}]){
  api.setStyle(st);
  const subs = clone(api.build(clone(segs), clone(raw)));
  const all = subs.flatMap(c => c.wordTimes);
  check(all.map(w => w.text).join(' ') === raw.map(w => w.text).join(' '), `max${st.maxWordsPerSub}: all ${raw.length} words present, in order, with punctuation`);
  check(subs.every(c => c.text.split(' ').length <= st.maxWordsPerSub), `max${st.maxWordsPerSub}: never more than ${st.maxWordsPerSub} words per caption`);
  const dur = t => { const w = all.find(x => x.text === t); return w.end - w.start; };
  check(['dedicated', 'of', 'Devi,'].every(t => dur(t) >= 0.11), `max${st.maxWordsPerSub}: stuck words now visible >= 0.11s (dedicated ${dur('dedicated').toFixed(2)}, of ${dur('of').toFixed(2)}, Devi, ${dur('Devi,').toFixed(2)})`);
  check(all.every((w, i) => i === 0 || w.start >= all[i - 1].start - 1e-9), `max${st.maxWordsPerSub}: word times never go backwards`);
  const the2 = all.filter(w => w.text === 'the')[1];
  check(Math.abs(the2.start - 21.93) < 0.01, `max${st.maxWordsPerSub}: "the" after the pause still starts at its real time (21.93)`);
}

/* ---- 2. determinism: same input -> same captions; slider round trip -> same captions ---- */
console.log('\n2. determinism');
{
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'litix_debug_cosmic_bubble.json'), 'utf8'));
  api.setStyle({ maxWordsPerSub: 3, minWordsPerSub: 1 });
  const a = JSON.stringify(api.build(clone(d.rawSegments), clone(d.rawWords)));
  const b = JSON.stringify(api.build(clone(d.rawSegments), clone(d.rawWords)));
  check(a === b, 'building twice gives byte-identical captions (old code used Math.random: different every time)');
  api.setStyle({ maxWordsPerSub: 2, minWordsPerSub: 1 }); api.build(clone(d.rawSegments), clone(d.rawWords));
  api.setStyle({ maxWordsPerSub: 3, minWordsPerSub: 1 });
  check(JSON.stringify(api.build(clone(d.rawSegments), clone(d.rawWords))) === a, 'moving the slider 3 -> 2 -> 3 returns the exact same captions');
  const inputBefore = JSON.stringify(d.rawWords);
  api.build(clone(d.rawSegments), d.rawWords);
  check(JSON.stringify(d.rawWords) === inputBefore, 'building never modifies rawWords (safe to rebuild forever)');

  /* ---- 3. real Whisper output (353 words) ---- */
  console.log('\n3. real clip from the bug report (' + d.rawWords.length + ' words, 1 word per caption)');
  api.setStyle({ maxWordsPerSub: 1, minWordsPerSub: 1, _wordsDist: [[1, 1]] });
  const subs = api.build(clone(d.rawSegments), clone(d.rawWords));
  const out = subs.flatMap(c => c.wordTimes);
  check(out.length <= d.rawWords.length && out.length >= d.rawWords.length - 5, `no word doubled, at most a few sentence-text gaps: ${out.length} words shown from ${d.rawWords.length} timed words (old code: ${d.subs.length})`);
  check(subs.every(c => c.text.split(' ').length === 1), 'every caption is exactly 1 word');
  const flashes = subs.filter(c => c.end - c.start < 0.10).length, oldFlashes = d.subs.filter(c => c.end - c.start < 0.12).length;
  const oldFlash10 = d.subs.filter(c => c.end - c.start < 0.10).length;
  check(flashes <= 20 && flashes < oldFlash10 / 2, `captions shorter than 0.10s: ${flashes} (old code in the user's run: ${oldFlash10})`);
  check(subs.every((c, i) => i === 0 || c.start >= subs[i - 1].start), 'captions are in time order');
  check(subs.every((c, i) => i === 0 || c.start >= subs[i - 1].end - 1e-6), 'captions never overlap each other');
  let maxEarly = 0, j = 0;
  out.forEach(w => { for(let q = j; q < Math.min(j + 6, d.rawWords.length); q++) if(norm(d.rawWords[q].text) === norm(w.text)){ maxEarly = Math.max(maxEarly, d.rawWords[q].start - w.start); j = q + 1; break; } });
  check(maxEarly <= 0.6, `no word appears more than 0.6s before it is spoken (worst: ${maxEarly.toFixed(2)}s)`);
  const lastRaw = d.rawWords[d.rawWords.length - 1].end;
  check(Math.abs(subs[subs.length - 1].end - lastRaw) < 1, `captions end where speech ends (${subs[subs.length - 1].end.toFixed(1)}s vs ${lastRaw.toFixed(1)}s)`);
}

/* ---- 4. nothing may be lost, whatever the input looks like ---- */
console.log('\n4. odd inputs');
{
  api.setStyle({ maxWordsPerSub: 3, minWordsPerSub: 1 });
  let s = api.build([], [W('hello', 1, 1.3), W('there', 1.3, 1.6), W('friend', 5, 5.4)]);
  check(s.map(c => c.text).join(' ') === 'hello there friend', 'words only, no sentences -> still builds captions');
  check(s.length >= 2 && s[0].end <= 1.7, 'words only: the 3.4s silence splits captions (no caption stretched over silence)');
  s = api.build([{ start: 0, end: 3, text: 'one two three four five six' }], []);
  check(s.flatMap(c => c.wordTimes).length === 6 && s[s.length - 1].end <= 3.001, 'sentences only, no word timing -> evenly estimated, inside the sentence');
  s = api.build([{ start: 0, end: 2, text: 'hello world' }], [W('hello', 0, 0.5), W('world', 0.6, 1), W('stray', 7, 7.4)]);
  check(s.map(c => c.text).join(' ').includes('stray'), 'a word that belongs to no sentence is kept, not deleted');
  s = api.build([], []);
  check(s.length === 0, 'nothing in -> nothing out, no crash');
  s = api.build([{ start: 0, end: 2, text: 'hello  world' }, { start: 2, end: 2, text: '   ' }], [W('', 0, 1), W('hello', 0, 0.5), W('world', 0.6, 1), { text: 'bad', start: NaN, end: 1 }]);
  check(s.map(c => c.text).join(' ') === 'hello world', 'empty text, blank sentence and NaN timing are ignored safely');
  const hi = [W('नमस्ते', 0, 0.5), W('दोस्तों,', 0.5, 1.0), W('कैसे', 1.0, 1.3), W('हो', 1.3, 1.6)];
  s = api.build([{ start: 0, end: 1.6, text: 'नमस्ते दोस्तों, कैसे हो' }], hi);
  check(s.flatMap(c => c.wordTimes).map(w => w.start).join() === '0,0.5,1,1.3', 'Hindi: each word keeps its REAL timestamp');
  check(norm('नमस्ते,') === 'नमस्ते', 'Hindi: vowel marks survive word normalising');
}

/* ---- 5. invented text + cleanup helpers ---- */
console.log('\n5. cleanup helpers');
{
  const H = api.isHallucinatedSegment;
  check(H(0.7, -1.5, 1) === true && H(0.7, -0.3, 1) === false && H(0.95, 0, 1) === true && H(0.1, -0.2, 4) === true && H(0.1, -1.5, 1) === false,
        'invented-text rule: silent+unsure=drop, silent+sure=keep, very silent=drop, repetition loop=drop, accented-but-speech=KEEP');
  const lead = api.dropLeadingBlip([W('Thank', 0, .3), W('you', .3, .6), W('hello', 5, 5.3), W('there', 5.3, 5.6), W('x', 5.6, 5.9)], [{ start: 0, end: .6, text: 'Thank you' }, { start: 5, end: 6, text: 'hello there x' }]);
  check(lead.words.length === 3 && lead.segments.length === 1, '2 invented words then 5s silence -> removed');
  const real = api.dropLeadingBlip([W('a', 0, .3), W('b', .3, .6), W('c', .6, .9), W('d', .9, 1.2)], []);
  check(real.words.length === 4, 'normal opening sentence is untouched');
  const w = [W('a', 0, 10), W('b', 10, 20)], sg = [{ start: 0, end: 20, text: 'a b' }];
  const au = api.rescaleIfTimeAxisStretched(w, sg, 10);
  check(au.corrected && Math.abs(w[1].end - 10) < 1e-9, 'transcript 2x too long is shrunk back onto the real audio length');
  const ok = api.rescaleIfTimeAxisStretched([W('a', 0, 9.9)], [], 10);
  check(!ok.corrected, 'normal transcript is not touched');
  check(/audio track|decode/i.test(api.friendlyError(new Error('AUDIO_DECODE_FAILED: too big'))) && !/too large/i.test(api.friendlyError(new Error('AUDIO_DECODE_FAILED: too big'))), 'decode failure is NOT mislabelled as "file too large"');
  check(!/Invalid API key/.test(api.friendlyError(new Error('chunk 4015 failed'))), 'the number 4015 is not mistaken for a 401 error');
}

/* ---- 6. language detection + chunk handling with a fake server ---- */
(async () => {
  console.log('\n6. transcribeChunk with a fake server');
  const ok = data => ({ ok: true, status: 200, json: async () => data, clone(){ return this; }, text: async () => JSON.stringify(data) });
  const verbose = (language, extra) => Object.assign({
    language, duration: 100, text: 'hello world',
    words: [{ word: 'hello', start: 1, end: 1.4 }, { word: 'world', start: 1.4, end: 1.9 }, { word: 'late', start: 96, end: 96.4 }, { word: 'ghost', start: 50, end: 50.5 }],
    segments: [
      { start: 1, end: 1.9, text: ' hello world', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 },
      { start: 49.5, end: 51, text: ' ghost', no_speech_prob: 0.8, avg_logprob: -1.6, compression_ratio: 1.0 },
      { start: 95, end: 99, text: ' late', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 }]
  }, extra || {});

  // English speech, English wanted: 1 request, offsets applied, ghost + late stuff removed
  api.setProxy(async () => ok(verbose('english')));
  let r = await api.transcribeChunk({ offset: 200, usableEnd: 295, blob: new Blob(['x']), name: 'a.wav' }, 2, 'en');
  check(api.calls.join() === 'transcriptions', 'English audio, English wanted -> only the normal endpoint is used (no translation)');
  check(r.words.map(w => w.text).join(' ') === 'hello world', 'words after the chunk line (96s+200) and words inside invented text are dropped');
  check(r.words[0].start === 201, 'chunk offset applied: word at 1s in chunk 2 (offset 200s) -> 201s in the video');
  check(r.segments.length === 1 && r.segments[0].text === 'hello world', 'invented sentence and the sentence crossing the chunk line are dropped; text is trimmed');

  // Hindi speech, English wanted: normal call + translate call
  api.setProxy(async ep => ok(ep === 'translations' ? verbose('english', { words: [{ word: 'hi', start: 1, end: 1.2 }], segments: [{ start: 1, end: 1.2, text: ' hi', no_speech_prob: 0, avg_logprob: -.1, compression_ratio: 1 }] }) : verbose('hindi')));
  r = await api.transcribeChunk({ offset: 0, usableEnd: Infinity, blob: new Blob(['x']), name: 'a.wav' }, 0, 'en');
  check(api.calls.join() === 'transcriptions,translations', 'Hindi audio, English wanted -> detected "hindi", then re-run through translations');
  check(r.words.map(w => w.text).join() === 'hi' && r.language === 'hindi', 'result holds the translated text and remembers the language that was heard');

  // Hindi speech, Hindi wanted: no translation
  api.setProxy(async () => ok(verbose('hindi')));
  await api.transcribeChunk({ offset: 0, usableEnd: Infinity, blob: new Blob(['x']), name: 'a.wav' }, 0, 'hi');
  check(api.calls.join() === 'transcriptions', 'Hindi audio, Hindi wanted -> no translation call');

  // Translation fails: falls back to the original text instead of crashing
  api.setProxy(async ep => ep === 'translations' ? { ok: false, status: 500, clone(){ return this; }, json: async () => ({}), text: async () => '{"error":"boom"}' } : ok(verbose('hindi')));
  r = await api.transcribeChunk({ offset: 0, usableEnd: Infinity, blob: new Blob(['x']), name: 'a.wav' }, 0, 'en');
  check(r.words.length > 0, 'translate endpoint fails -> still returns the original-language words (no crash)');

  // Server error with HTML body shows the real cause
  api.setProxy(async () => ({ ok: false, status: 500, clone(){ return this; }, json: async () => { throw new Error('x'); }, text: async () => '<html>Bad gateway from edge</html>' }));
  try { await api.transcribeChunk({ offset: 0, usableEnd: Infinity, blob: new Blob(['x']), name: 'a.wav' }, 0, 'en'); check(false, 'server error should throw'); }
  catch(e){ check(/500/.test(e.message) && /Bad gateway/.test(e.message), 'HTML error page from the server is shown in the message: "' + e.message.slice(0, 60) + '…"'); }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
