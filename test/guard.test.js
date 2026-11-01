// node test_guard.js  -- adversarial tests of tgVerifyAgainstAudio. Needs guard.js in same folder (or LITIX_HTML).
const fs = require('fs');
let src = process.env.LITIX_HTML ? fs.readFileSync(process.env.LITIX_HTML, 'utf8') : fs.readFileSync(__dirname + '/subtitle_timing_guard.js', 'utf8');
const a = src.indexOf('/* LITIX-TIMING-GUARD-BEGIN'), b = src.indexOf('/* LITIX-TIMING-GUARD-END');
const api = new Function(src.slice(a, b) + '; return { TG, verify: tgVerifyAgainstAudio, sound: tgSoundMap };')();
const { makeClip, whisperView } = require('./synth.js');
const clone = x => x.map(o => ({ ...o }));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok:   ' : '  FAIL: ') + m); if(!c) fails++; };
function score(truth, got){ // per-word error vs ground truth (same index = same word: text/time travel together)
  const e = truth.map((w, i) => Math.abs(got[i].start - w.start)).sort((x, y) => x - y);
  return { median: e[e.length >> 1], p95: e[Math.floor(e.length * 0.95)], within05: e.filter(x => x <= 0.5).length / e.length, max: e[e.length - 1] };
}
function run(name, clip, mutate, expectFixed){
  const v = whisperView(clip, 1); const bad = mutate(clone(v.words), clone(v.segs));
  const before = score(clip.words, bad.words);
  const rep = api.verify(bad.words, bad.segs, api.sound(clip.samples, clip.rate));
  const after = score(clip.words, bad.words);
  const sameText = bad.words.every((w, i) => w.text === clip.words[i].text);
  console.log(`${name}: before p50=${before.median.toFixed(2)} within.5=${(before.within05*100|0)}% | after p50=${after.median.toFixed(2)} p95=${after.p95.toFixed(2)} within.5=${(after.within05*100|0)}% max=${after.max.toFixed(2)} | report=${JSON.stringify({s:rep.scale,p:rep.shiftedParts})}`);
  ok(sameText && bad.words.length === clip.words.length, name + ': words kept, same text/order');
  return { before, after, rep };
}
const shiftAll = d => (w, s) => { w.forEach(x => { x.start = Math.max(0, x.start + d); x.end = Math.max(0, x.end + d); }); s.forEach(x => { x.start = Math.max(0, x.start + d); x.end = Math.max(0, x.end + d); }); return { words: w, segs: s }; };
const stretchAll = k => (w, s) => { w.forEach(x => { x.start *= k; x.end *= k; }); s.forEach(x => { x.start *= k; x.end *= k; }); return { words: w, segs: s }; };
const shiftBlock = (a, b, d) => (w, s) => { [w, s].forEach(l => l.forEach(x => { if(x.start >= a && x.start < b){ x.start += d; x.end += d; } })); return { words: w, segs: s }; };

console.log('== A. GOOD transcripts must NOT be changed (false alarms) ==');
let alarms = 0, worstMove = 0, total = 0;
for(let sd = 1; sd <= 40; sd++){
  const noise = [0.005, 0.01, 0.02, 0.03][sd % 4], music = sd % 5 === 0 ? 0.02 : 0, jit = [0.05, 0.12, 0.25][sd % 3];
  const clip = makeClip(sd, { dur: 120 + (sd % 4) * 40, noise, music, pauseMax: [0.6, 2.5, 5][sd % 3] });
  const v = whisperView(clip, sd, jit); const orig = clone(v.words);
  const rep = api.verify(v.words, v.segs, api.sound(clip.samples, clip.rate)); total++;
  const moved = v.words.reduce((m, w, i) => Math.max(m, Math.abs(w.start - orig[i].start)), 0);
  worstMove = Math.max(worstMove, moved); if(moved > 0.01 || rep.scale !== 1) alarms++;
}
ok(alarms === 0, `${total} good transcripts (noise, music, long/short pauses, jitter up to 0.25 s): false alarms = ${alarms}, worst word move = ${worstMove.toFixed(2)} s`);

console.log('== B. BAD transcripts must be repaired ==');
const clip = makeClip(7, { dur: 200, noise: 0.01 });
let r;
r = run('Whisper 30 s late (whole file)', clip, shiftAll(30)); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('Whisper 12 s early (whole file)', clip, shiftAll(-12)); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('2x stretched', clip, stretchAll(2)); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('0.5x squeezed', clip, stretchAll(0.5)); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('48k/44.1k stretch', clip, stretchAll(48000 / 44100)); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('everything after 100 s is 25 s late', clip, shiftBlock(100, 1e9, 25)); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('drift: +10 s after 70 s, +25 s after 130 s', clip, (w, s) => shiftBlock(130, 1e9, 15)(...Object.values(shiftBlock(70, 1e9, 10)(w, s)))); ok(r.after.within05 > 0.9, 'repaired to >90% within 0.5 s');
r = run('(info) a 60 s block moved INTO its neighbours (two sets of words collide)', clip, shiftBlock(60, 120, 30)); console.log('       ^ informational, not asserted: colliding blocks cannot be separated by time alone');
console.log('== C. Cases where the guard must stay out of the way ==');
const flat = makeClip(3, { dur: 120, noise: 0.01, music: 0.3 });
const vf = whisperView(flat, 3); const bf = shiftAll(30)(clone(vf.words), clone(vf.segs));
const rf = api.verify(bf.words, bf.segs, api.sound(flat.samples, flat.rate));
ok(!rf.checked, 'constant loud music: guard declines to guess (cannot tell speech apart) -- known limitation');
const tiny = makeClip(4, { dur: 8 }); const vt = whisperView(tiny, 4);
ok(!api.verify(vt.words, vt.segs, api.sound(tiny.samples, tiny.rate)).checked, 'video under 10 s: not checked');
console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
process.exit(fails ? 1 : 0);
