// Synthetic speech-like audio + ground-truth transcript generator (seeded). Used by guard tests.
function rng(seed){ let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function makeClip(seed, opts){
  opts = Object.assign({ dur: 180, rate: 16000, noise: 0.01, music: 0, pauseMax: 2.5, wps: 2.6 }, opts || {});
  const r = rng(seed), rate = opts.rate, n = Math.floor(opts.dur * rate);
  const samples = new Float32Array(n);
  const words = [], segs = [];
  let t = 0.3 + r() * 1.5;
  while(t < opts.dur - 3){
    const nw = 4 + Math.floor(r() * 10), s0 = t; let wi = 0;
    for(let k = 0; k < nw && t < opts.dur - 2; k++){
      const d = 0.12 + r() * 0.45 * (2.6 / opts.wps);
      const amp = 0.12 + r() * 0.25;
      words.push({ text: 'w' + (words.length), start: t, end: t + d, amp });
      t += d + (r() < 0.2 ? 0.05 + r() * 0.25 : r() * 0.04); wi++;
    }
    segs.push({ start: s0, end: t, text: words.slice(words.length - wi).map(w => w.text).join(' ') });
    t += 0.5 + r() * opts.pauseMax;
  }
  // render: voiced noise with syllable modulation inside each word
  let seedN = seed * 7 + 1; const rn = rng(seedN);
  for(const w of words){
    const a = Math.floor(w.start * rate), b = Math.min(n, Math.floor(w.end * rate));
    const f = 3 + rn() * 4;
    for(let i = a; i < b; i++){
      const x = (i - a) / (b - a), env = Math.sin(Math.PI * Math.min(1, x * 1.2)) * (0.6 + 0.4 * Math.abs(Math.sin(2 * Math.PI * f * (i - a) / rate)));
      samples[i] += (rn() * 2 - 1) * w.amp * env;
    }
  }
  for(let i = 0; i < n; i++){
    samples[i] += (rn() * 2 - 1) * opts.noise;
    if(opts.music) samples[i] += opts.music * Math.sin(2 * Math.PI * 220 * i / rate) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.5 * i / rate));
  }
  return { samples, rate, words, segs, dur: opts.dur };
}
// what a decent Whisper returns: true times + small jitter (+- jit sec)
function whisperView(clip, seed, jit){
  const r = rng(seed + 99); jit = jit == null ? 0.12 : jit;
  const words = clip.words.map(w => { const a = Math.max(0, w.start + (r() * 2 - 1) * jit); return { text: w.text, start: a, end: Math.max(a + 0.03, w.end + (r() * 2 - 1) * jit) }; });
  const segs = clip.segs.map(s => ({ start: Math.max(0, s.start + (r() * 2 - 1) * jit), end: s.end + (r() * 2 - 1) * jit, text: s.text }));
  return { words, segs };
}
module.exports = { rng, makeClip, whisperView };
