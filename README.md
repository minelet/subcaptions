# Litix — Handoff README (for the next Claude)

Written: 2026-10-16. The user will upload this file in a new chat.
**Claude: read this fully, then remind the user of the "Pending follow-ups" section before anything else.**

## Project
- Site: https://litix.in (Vercel-style project: `public/`, `api/`, `lib/`, `vercel.json`)
- Main file: `public/index.html` (~850 KB, single page; the whole editor is inline JS)
- Domain registrar / DNS: **Hostinger** (nameservers `horizon.dns-parking.com`, `orbit.dns-parking.com`)
- Owner's tone: gets frustrated fast, wants direct fixes, short answers.

## What was done in this session

### 1. Subtitle line limit (in `public/index.html`)
- **Problem:** Videos-section captions wrapped to 3-4 lines. Cause: `__applyTpl` forced `singleLine=false` on every Videos template, and nothing checked chunk width.
- **Fix:**
  - Removed the forced 2-line mode. Default is now **1 line max**.
  - New `lineBudgetMetrics()`, `splitIntoBudget()`, `enforceLineBudget()` (placed just above `buildSubtitles()`). They measure each chunk with the real font and split it so it fits the line budget. Word timings are preserved. Called from `buildSubtitles()`.
  - Setting: checkbox `#sub-singleline` / `#wts-singleline`, label "Max 1 line (uncheck for 2)". Unchecked = max **2** lines, never more. The choice is stored in `window.__userLineLimit` and survives template switches. Toggling rebuilds the chunks (`onLineLimitChange`), so manual transcript edits are lost on toggle (same as the Max Words slider).
  - `getCaptionLineCap()` still returns 1 or 2.

### 2. Subtitle look
- `globalDropShadowFilterCSS()`: replaced the heavy blurry halo with a tight crisp shadow (smaller blur and offsets, lower alpha).
- In `__applyTpl`: for Videos-section presets (`_wordsPerSub > 1`) it uses a copy of the preset with fontSize min 27, outlineWidth min 3.5, fontWeight min 800. The shared `TPL_PRESETS` is not mutated.
- **Not verified with the real fonts** (the sandbox had no Google Fonts access, so the check used a fallback font). The user should check it on the live site.

### 3. Favicon / logo for Google
- Regenerated `public/favicon.ico` (16, 32, 48, 96). Added `assets/favicon-96x96.png` and `assets/favicon-144x144.png`.
- Cleaned `<link rel="icon">` tags in `<head>`; added `<meta name="theme-color" content="#004cff">`.
- Added a `WebPage` node in the JSON-LD (`primaryImageOfPage`, `thumbnailUrl` = `og-image-square.png`).
- The login screen (`#login-overlay`) now shows the real icon (`/assets/icon-192.png`) and an `<h1>` "LitiX". Googlebot only sees the login screen, since the editor is behind auth.

### 4. Files changed (only these 4)
`public/index.html`, `public/favicon.ico`, `public/assets/favicon-96x96.png`, `public/assets/favicon-144x144.png`.
The user deployed them. Verified live by fetching https://litix.in/ (new logo, "Max 1 line" label and theme-color are present).

### 5. Google Search Console (done by the user)
- Property: Domain `litix.in`, verified via **DNS TXT record at Hostinger**. **Do NOT delete that TXT record** or verification is lost.
- URL Inspection: `https://litix.in/` was "URL is on Google" (old cached copy). **Indexing requested** (priority queue). Do NOT re-request, it does not help.
- `sitemap.xml` submitted successfully.
- Hostinger: the domain email verification is done (status Active). **Auto-renewal is OFF**; the domain expires **2027-10-12**.

## Known facts / gotchas
- Google's result in the user's screenshots was OLD: title "LitiX — AI Creator Toolkit", grey globe favicon, no thumbnail. It matched an older site version, not the current title "Litix — AI Subtitle Generator for Videos".
- Google never shows a "green tick" on organic results. The grey "i" is the "About this result" button. Do not promise one.
- Favicon and thumbnail are chosen/refreshed by Google separately and can take days to a few weeks. Code can't force it. The right-side thumbnail is entirely Google's choice.
- There is an unrelated Italian company "Litix SpA" that ranks for the brand name. Expect competition on the plain "litix" query.
- Editor testing in a sandbox: `/api/me` must be mocked (the app shows a login gate). Internal state (`subtitles`, `style`, `rawWords`) is in a private scope; only `window.__getStyle`, `window.__applyTpl`, `window.__applyOutputRatio`, `window.__enforceLineBudget` etc. are reachable. A test-only hook was used in a temp copy and is NOT in the deliverable.

## Pending follow-ups — REMIND THE USER
1. **In ~3-4 days:** search `site:litix.in` in Google. The title should now be "Litix — AI Subtitle Generator for Videos". If still the old one after ~1 week, ask for a screenshot and check Search Console URL Inspection → View crawled page → HTML for `favicon-96x96`.
2. **Within ~2 weeks:** the logo should replace the globe in the result. If not, check that `https://litix.in/favicon.ico` loads and shows the logo, and that the favicon files are not blocked.
3. **Real-video test of subtitles on the live site:** default must be 1 line; unchecking "Max 1 line" gives up to 2 lines, never 3-4; do captions look good with the real fonts (Montserrat etc.)? If any template still exceeds the limit or looks bad, get the template name + a screenshot.
4. **Turn on Hostinger auto-renewal** for litix.in (expires 2027-10-12).
5. Keep the Google verification TXT record in Hostinger DNS.

## Notes for Claude
- Claude does not remember across chats unless memory is enabled for the user. This file is the memory. Ask the user to upload it at the start of any new chat.
- When they upload a new site zip, diff against the files above before editing, since the live site may differ from the zip (the old Google snippet mentioned "automatic clip finding", which the zip's title/description do not).

## Bug report: subtitles 4-7+ s late on one video (2026-10-16)
- File: SaveClip_App_..._subtitled (1).mp4 (41 s, 480x854, AAC-LC 48k stereo, VFR). Its burned-in captions (a Litix export) sit at **~2.0x** the real speech time (e.g. "campus" spoken ~3.3 s shown 6.3 s; "government" 8.4 -> 17.0; "project" 15.1 -> 30.0). A time-STRETCH, not an offset.
- Verified correct on this file's real audio: audio extraction (right length, 0 lag, 0.994 corr vs ffmpeg), subtitle builder (<=0.02 s error), refineWordBoundariesWithAudio (<=0.5 s shift). So the stretched timestamps arrive in the transcription response (Groq) itself. Not reproduced: the real Groq call and real-Chrome AAC decode could not be run in the sandbox.
- Suspects not yet ruled out: /translations fallback when language is detected as non-English (no word timestamps), and the raw-MP4 fallback when audio extraction fails (file < 4.3 MB).
- Added `auditTimeBase()` (before `startGroqTranscription`): if the transcript's last timestamp is > audio length x1.10 + 0.75 s, the whole transcript is rescaled onto the real audio length. It logs `[litix][timing-audit] {...}` to the console and stores `window.__lastTimingAudit`. It cannot catch a stretch where words still end before the audio does.
- TO DO: have the user regenerate this video, open DevTools console, and send the `[litix][timing-audit]` line. It shows Groq's reported duration, chunk count and whether translations were used.

## Branding assets (2026-10-16)
- `public/assets/litix-logo-animation.mp4` — the 8 s Litix logo animation (1920x1080, 24 fps) **with a sound track**. The user's original `op_logo.mp4` had NO audio track at all; the sound is a generated synth design (riser, impact at ~1.7 s, glass sparkles, whoosh, bass hit + chord at ~3.5 s, wordmark chimes 4.35-5.65 s, fade 7.5-8 s) synced to the picture. It was checked numerically only (nobody listened to it), so ask the user whether they like it. Not referenced by the app yet.
- `branding/` (not deployed): original silent mp4, the separate `op_logo_sound_track.wav`, `banner-youtube-2560x1440.png` (logo group sits inside YouTube's 1546x423 safe area) and `banner-x-1500x500.png`. Channel name chosen by the user: "Litix AI" (handle idea @litixai, availability not checked).

## Promo short, 20 s version (2026-10-17)
- `branding/litix_promo_20s_9x16.mp4` - 19.8 s, 1080x1920, 30 fps, AI voiceover (Kokoro TTS, voice `am_michael`, speed 1.18) + ducked music/SFX + Litix-style burned-in captions. Replaces the earlier 52 s version (user said it was too long, hook was bad, AI cutter must go).
- Hook: "Stop scrolling. Add subtitles to any video in seconds." (giant STOP SCROLLING, then the product demo on a card). Then upload + English/Hindi/Hinglish + word-level timing -> styles -> fix a word + 9:16 export for Shorts/Reels/TikTok -> CTA litix.in (beta). The AI Video Cutter is deliberately NOT mentioned.
- Backgrounds are blurred screenshots of the REAL editor (captured with Playwright, /api/me mocked); the upload box and template picker are sharp crops of the real UI. If the UI changes, re-capture the screenshots.
- Nobody has listened to the voice/mix yet (checked numerically only); caption word timings are estimated from sentence length. Sources in `branding/promo_source/` (paths assume /tmp/promo; needs kokoro-onnx + model files from the kokoro-onnx GitHub release).
