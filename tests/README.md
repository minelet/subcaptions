# Keyframe / word-override regression suite

`regression.mjs` drives the real app (`public/index.html`) in a headless
browser with synthetic subtitles and overrides, and asserts on what actually
renders — the same technique used to find and verify the original scoping
and template-mapping bugs, rather than re-reading the source.

It covers:

1. All 19 templates in the dropdown map to exactly their own CSS animation, deterministically, with no cross-contamination between selections.
2. Zero cross-subtitle bleed for every built-in quick-style preset, across plain / reactive / line-pop caption modes.
3. Karaoke `highlightWord` tracks playback in real time instead of freezing on the first word.
4. `getLineWords()` is the single, consistent word-index source (fixes the wordTimes-vs-text.split mismatch).
5. An override with Template = "None" and no style fields is a no-op — it no longer blanks out the word's base styling (e.g. a Box-mode background).
6. Editing a subtitle's text with a *different* word count clears that line's now-unreliable overrides.
7. Editing a subtitle's text with the *same* word count keeps its overrides.

## Running

```bash
npm install --save-dev playwright
npx playwright install chromium
npm test
```

If `npx playwright install` can't download a browser (e.g. a sandboxed/
offline environment) and one is already available elsewhere, point at it
directly:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome node tests/regression.mjs
```

Exits non-zero on any failed check, so it can be wired into CI. Run this
before shipping any change that touches caption rendering, the Keyframes
tab, or the canvas export path — this exact bug class (a fix landing in one
render path but not its DOM/canvas twin) is what caused the original report.
