#!/usr/bin/env node
// Keyframe / word-override system regression suite.
//
// This drives the ACTUAL app code (public/index.html) inside a headless
// browser with synthetic subtitles/overrides, the same way the original
// scoping/template bugs were found and verified — not a re-read of the
// source. It exists specifically to catch regressions in:
//   - template dropdown -> CSS animation mapping (deterministic, no drift)
//   - per-word override scoping (never bleeds into an adjacent subtitle)
//   - override rendering parity across every caption mode (plain, reactive,
//     line-pop, word-mode, highlightWord, boxKaraoke)
//   - the "empty override" and "stale index after text edit" fixes
//
// Usage:
//   npm install --save-dev playwright
//   npx playwright install chromium
//   node tests/regression.mjs
//
// Exits non-zero if any check fails, so it can be wired into CI.

import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// 1. Build an instrumented copy of index.html in a temp dir. The injected
//    hooks only exist for the duration of the test run — nothing here ships
//    in the real product file.
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(path.join(tmpdir(), 'litix-test-'));
cpSync(PUBLIC_DIR, tmpDir, { recursive: true });

const indexPath = path.join(tmpDir, 'index.html');
let html = readFileSync(indexPath, 'utf8');

const marker = "let subtitles    = [];   // [{start, end, text}]  — timestamps from Groq";
if (!html.includes(marker)) {
  console.error('FATAL: instrumentation anchor not found — public/index.html structure changed, update tests/regression.mjs');
  process.exit(1);
}
const debugHooks = `
window.__test = {
  getSubtitles: () => subtitles,
  setSubtitles: (v) => { subtitles = v; },
  getStyle: () => style,
  updateActiveSubtitle: () => updateActiveSubtitle(),
  getSubTextHTML: () => subText.innerHTML,
  getLineWords: (s) => getLineWords(s),
  setKeyframeMode: (v) => { window.keyframeModeOn = v; },
  renderList: () => renderList(),
  applyPresetByLabel: (label) => {
    const p = KF_BUILTIN_PRESETS.find(p => p.label === label);
    if(!p) throw new Error('preset not found: ' + label);
    applyKfPreset(p);
  },
  getPresetLabels: () => KF_BUILTIN_PRESETS.map(p => p.label),
  selectWord: (lineIdx, wordIdx) => {
    const el = document.querySelector(\`.kf-word[data-line="\${lineIdx}"][data-word="\${wordIdx}"]\`);
    if(!el) throw new Error(\`kf-word not found: line \${lineIdx} word \${wordIdx}\`);
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
  },
  editRowText: (lineIdx, newText) => {
    const el = document.querySelector(\`.s-txt[data-idx="\${lineIdx}"]\`);
    if(!el) throw new Error(\`row text not found: line \${lineIdx}\`);
    el.textContent = newText;
    el.dispatchEvent(new Event('input', {bubbles:true}));
  },
};
`;
html = html.replace(marker, marker + '\n' + debugHooks);
writeFileSync(indexPath, html);

// ---------------------------------------------------------------------------
// 2. Static file server for the instrumented copy
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const filePath = path.join(tmpDir, p);
  try {
    const data = readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise(resolve => server.listen(0, resolve));
const port = server.address().port;

// ---------------------------------------------------------------------------
// 3. Test harness
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function twoLineFixture() {
  return [
    { start: 0.0, end: 2.0, text: 'Big Money Word',
      wordTimes: [
        { text: 'Big', start: 0.0, end: 0.6, score: 1 },
        { text: 'Money', start: 0.6, end: 1.3, score: 5 },
        { text: 'Word', start: 1.3, end: 2.0, score: 1 },
      ], overrides: [] },
    { start: 2.0, end: 4.0, text: 'Clean Second Line',
      wordTimes: [
        { text: 'Clean', start: 2.0, end: 2.6, score: 1 },
        { text: 'Second', start: 2.6, end: 3.3, score: 1 },
        { text: 'Line', start: 3.3, end: 4.0, score: 1 },
      ], overrides: [] },
  ];
}

const TEMPLATES = ['word-pop-glow','word-pop-burst','word-bounce','word-drop','word-box-punch',
  'word-slide-hit','word-gradient-sweep','word-underline-sweep','word-fade-trail','word-cursive-pop',
  'word-bold-pop','word-shake','word-flip-3d','word-elastic-pop','word-neon-flicker',
  'word-typewriter-wipe','word-rubber-squash','word-swing-in','word-glitch'];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
);
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForTimeout(300);

async function applyOverrideToWord(lineIdx, wordIdx, subs, presetLabel) {
  await page.evaluate((s) => window.__test.setSubtitles(s), JSON.parse(JSON.stringify(subs)));
  await page.evaluate(() => window.__test.setKeyframeMode(true));
  await page.evaluate(() => window.__test.renderList());
  await page.waitForTimeout(30);
  await page.evaluate(([l, w]) => window.__test.selectWord(l, w), [lineIdx, wordIdx]);
  await page.evaluate((label) => window.__test.applyPresetByLabel(label), presetLabel);
}

async function renderAt(t) {
  await page.evaluate((tt) => { window.vp.currentTime = tt; }, t);
  await page.evaluate(() => window.__test.updateActiveSubtitle());
  await page.waitForTimeout(20);
  return page.evaluate(() => window.__test.getSubTextHTML());
}

console.log('\n1. Template dropdown -> animation mapping (all templates deterministic)');
{
  const subs = twoLineFixture();
  await page.evaluate((s) => window.__test.setSubtitles(s), JSON.parse(JSON.stringify(subs)));
  await page.evaluate(() => { window.__test.getStyle().wordMode = ''; });
  for (const tpl of TEMPLATES) {
    await page.evaluate((t) => {
      const subs = window.__test.getSubtitles();
      subs[0].overrides = [{ id: 'ov', wordStart: 1, wordEnd: 1, text: null, template: t, style: {}, delayMs: 0, durationMs: 400 }];
    }, tpl);
    const html = await renderAt(0.7);
    const m = html.match(/animation:([\w-]+)/);
    check(`"${tpl}" applies exactly its own animation`, m && m[1] === tpl, `got: ${m ? m[1] : 'none'}`);
    await renderAt(100); // force a full repaint cycle before the next template
  }
}

console.log('\n2. Zero cross-subtitle bleed, per caption mode');
{
  const presets = await page.evaluate(() => window.__test.getPresetLabels());
  for (const wordMode of ['', 'reactive', 'line-pop']) {
    for (const label of presets) {
      await applyOverrideToWord(0, 1, twoLineFixture(), label);
      await page.evaluate((wm) => { window.__test.getStyle().wordMode = wm; }, wordMode);
      const htmlA = await renderAt(0.7);
      const htmlB = await renderAt(2.5);
      const modeLabel = wordMode || 'plain';
      check(`[${modeLabel}] "${label}" shows an override on subtitle A`,
        htmlA.includes('data-kf-override'));
      // Bleed means an override marker, or one of the KF override template's
      // own animation names, showing up in subtitle B — NOT the caption
      // mode's own native active-word animation (reactive-word-pop,
      // word-pop-burst), which correctly applies to subtitle B's own words.
      const overrideBled = htmlB.includes('data-kf-override') ||
        TEMPLATES.some(t => htmlB.includes(`animation:${t}`));
      check(`[${modeLabel}] "${label}" leaves subtitle B completely clean`,
        !overrideBled, `sub B html: ${htmlB}`);
    }
  }
}

console.log('\n3. Karaoke highlightWord tracks playback in real time (not frozen)');
{
  await page.evaluate((s) => window.__test.setSubtitles(s), JSON.parse(JSON.stringify(twoLineFixture())));
  await page.evaluate(() => window.__test.setKeyframeMode(false));
  await page.evaluate(() => { window.__test.getStyle().wordMode = ''; window.__test.getStyle().highlightWord = true; });
  const expected = ['Big', 'Money', 'Word'];
  const times = [0.1, 0.7, 1.4];
  for (let i = 0; i < times.length; i++) {
    const html = await renderAt(times[i]);
    const m = html.match(/color:#ffdd00">(\w+)</);
    check(`t=${times[i]} highlights "${expected[i]}"`, m && m[1] === expected[i], `got: ${m ? m[1] : 'none'}`);
  }
}

console.log('\n4. getLineWords() is the single source of truth for word indexing');
{
  await page.evaluate((s) => window.__test.setSubtitles(s), JSON.parse(JSON.stringify(twoLineFixture())));
  const words = await page.evaluate(() => window.__test.getLineWords(window.__test.getSubtitles()[0]));
  check('word list matches wordTimes order/count', JSON.stringify(words) === JSON.stringify(['Big','Money','Word']));
}

console.log('\n5. Empty override ("None" template, no style) is a no-op, not a blank span');
{
  const subs = twoLineFixture();
  await page.evaluate((s) => window.__test.setSubtitles(s), JSON.parse(JSON.stringify(subs)));
  await page.evaluate(() => {
    window.__test.getStyle().wordMode = '';
    window.__test.getStyle().boxMode = true;
    const s = window.__test.getSubtitles();
    s[0].overrides = [{ id: 'ov', wordStart: 1, wordEnd: 1, text: null, template: null, style: {}, delayMs: 0, durationMs: 400 }];
  });
  const html = await renderAt(0.7);
  check('word keeps its Box-mode background instead of going blank',
    !html.includes('data-kf-override') && /background:#[0-9a-f]{6}/.test(html), html);
}

console.log('\n6. Editing subtitle text with a changed word count clears stale overrides');
{
  await applyOverrideToWord(0, 1, twoLineFixture(), 'Money Word');
  await page.evaluate(() => window.__test.setKeyframeMode(false));
  await page.evaluate(() => window.__test.renderList());
  await page.waitForTimeout(30);
  await page.evaluate(() => window.__test.editRowText(0, 'Totally Different Wording Now'));
  const overrides = await page.evaluate(() => window.__test.getSubtitles()[0].overrides);
  check('overrides cleared after a word-count-changing edit', Array.isArray(overrides) && overrides.length === 0,
    JSON.stringify(overrides));
}

console.log('\n7. Editing subtitle text with the SAME word count keeps overrides');
{
  await applyOverrideToWord(0, 1, twoLineFixture(), 'Money Word');
  await page.evaluate(() => window.__test.setKeyframeMode(false));
  await page.evaluate(() => window.__test.renderList());
  await page.waitForTimeout(30);
  await page.evaluate(() => window.__test.editRowText(0, 'Big Cash Word')); // same 3-word count
  const overrides = await page.evaluate(() => window.__test.getSubtitles()[0].overrides);
  check('overrides preserved after a same-length edit', Array.isArray(overrides) && overrides.length === 1,
    JSON.stringify(overrides));
}

check('no uncaught page errors during the run', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
