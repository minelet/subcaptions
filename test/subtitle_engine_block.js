/* ═══════════════════════════ LITIX SUBTITLE ENGINE — START ═══════════════════════════
   This ONE block does everything from "user clicked Generate" to "captions on screen".
   It replaces ~1,900 lines of patched-on code. Read it top to bottom; each step is small.

   THE PIPELINE (each step is one function, in this order):
     1. getAudioForTranscription()  video file  -> 16kHz audio cut into ~100s pieces ("chunks")
     2. transcribeChunk()           each chunk  -> words + sentences + detected language (via /api/transcribe)
     3. transcribeAllChunks()       joins the pieces, works out the main language of the video
     4. cleanup steps               drops invented text, fixes a stretched time axis, sharpens word edges
     5. buildSubtitles()            words + sentences -> caption cues shown on the video

   HOW TO READ THE COMMENTS
     🔎 WHAT:      what this piece of code does, in plain words
     ⚠️ BUG-RISK:  a place where bugs are most likely. If something breaks, look at these FIRST.

   HOW TO DEBUG WITHOUT READING CODE
     Open the browser console and look for lines starting with  [litix:...]
       [litix:audio]     how many chunks the audio was cut into
       [litix:chunk]     per chunk: language heard, words, sentences kept, how many were thrown away
       [litix:language]  the language decision for the whole video
       [litix:cleanup]   what the cleanup steps changed
       [litix:build]     how many captions were produced from how many words
     The same info is kept in  window.__litixPipeline  (type it in the console to see everything).
     If a stage prints 0 words, the bug is in THAT stage or the one right before it.
   ══════════════════════════════════════════════════════════════════════════════════════ */

/* ── SECTION 0: SETTINGS — every number you might want to tune lives here, nowhere else ── */
const ENGINE = {
  // --- talking to the server ---
  PROXY_SAFE_BYTES: 4.3 * 1024 * 1024, // Vercel rejects request bodies above ~4.5MB. Only matters when we must send the raw file.
  FETCH_ATTEMPTS: 3,                   // tries per request when the server says 503/404 (busy / hiccup)
  FETCH_RETRY_MS: 1500,                // wait between those tries
  WORD_RETRIES: 2,                     // extra tries when the server returned too few word timestamps
  WORDS_COMPLETE_RATIO: 0.85,          // "enough words" = word letters cover >= 85% of sentence letters

  // --- Hindi / Hinglish conversion ---
  CONVERT_WORD_BATCH: 25,              // sentences sent to the language model per request (word-by-word mode)
  CONVERT_TEXT_BATCH: 40,              // sentences per request (whole-sentence mode)

  // --- throwing away text the model invented ---
  LEAD_GAP_SEC: 3,                     // a silence this long right after the first few words...
  LEAD_MAX_WORDS: 3,                   // ...means those first (max 3) words were probably invented

  // --- matching words to sentences ---
  SEG_TOLERANCE_SEC: 0.25,             // a word may sit this far outside its sentence and still belong to it

  // --- word timing repair ---
  MIN_WORD_SEC: 0.12,                  // a word shown for less than this is a "flash" (looks like a glitch)
  DONOR_KEEP_SEC: 0.25,                // a neighbour that lends time must keep at least this much
  MAX_BORROW_PREV_SEC: 0.30,           // most time one word can take from the word BEFORE it
  MAX_BORROW_NEXT_SEC: 0.17,           // most time one word can take from the word AFTER it
  ADJACENT_SEC: 0.05,                  // two words closer than this count as "touching"

  // --- grouping words into captions ---
  PAUSE_GAP_SEC: 0.35,                 // a silence longer than this ALWAYS ends a caption
  RNG_SEED: 20240611,                  // fixed number -> same video + same settings = SAME captions every time
};

/* ── SECTION 1: tiny helpers ── */

// 🔎 WHAT: records what each stage did, so you can see it in the console (see header).
function subLog(stage, info){
  window.__litixPipeline = window.__litixPipeline || {};
  window.__litixPipeline[stage] = info;
  try { console.info('[litix:' + stage + ']', info); } catch(e){}
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// 🔎 WHAT: turns a word into a comparable form: lowercase, no punctuation. "Nights," -> "nights".
// ⚠️ BUG-RISK: \p{M} keeps Hindi vowel marks (matras). If you remove it, Hindi words stop matching.
function normWord(t){ return String(t == null ? '' : t).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, ''); }

// 🔎 WHAT: pulls a human-readable message out of a failed server response.
async function readServerError(response){
  let msg = 'Transcription error ' + response.status;
  const raw = await response.text();
  try {
    const j = JSON.parse(raw);
    if(j.error && j.error.message) msg = j.error.message;
    else if(typeof j.error === 'string') msg = j.error;
  } catch(e){
    // Server sent HTML/plain text, not JSON. Show a snippet so the real cause is visible.
    const snippet = (raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    msg += snippet ? ': ' + snippet : ' (empty response body)';
  }
  return msg;
}

/* ── SECTION 2: STEP 1 — get audio ── */

// 🔎 WHAT: decodes the video's audio and cuts it into small WAV chunks (extractAudioChunks does the cutting).
//          If decoding fails twice AND the file is small enough, sends the original file as a single chunk.
// ⚠️ BUG-RISK: the fallback chunk has usableEnd = Infinity and offset = 0 -> no overlap handling. Fine for one chunk only.
// ⚠️ BUG-RISK: the error text must start with "AUDIO_DECODE_FAILED" - friendlyError() looks for that exact word.
async function getAudioForTranscription(file){
  let lastErr = null;
  for(let attempt = 0; attempt < 2; attempt++){
    try {
      if(attempt) await sleep(50); // a tick of rest: a just-closed decoder from the previous run needs a moment
      const a = await extractAudioChunks(file);
      subLog('audio', { chunks: a.chunks.length, seconds: +(a.samples.length / a.sampleRate).toFixed(1) });
      return { chunks: a.chunks, samples: a.samples, sampleRate: a.sampleRate };
    } catch(e){
      lastErr = e;
      console.error('[litix] audio extraction attempt ' + (attempt + 1) + ' failed:', e && e.name, e && e.message, e && e.codecInfo);
    }
  }
  if(file.size > ENGINE.PROXY_SAFE_BYTES){
    const ci = lastErr && lastErr.codecInfo;
    const codec = ci && ci.codec && ci.codec !== 'unknown' ? ' (audio codec: ' + ci.codec + ')' : '';
    throw new Error("AUDIO_DECODE_FAILED: couldn't read this file's audio track, and the original file is too big to send as a fallback." + codec);
  }
  subLog('audio', { chunks: 1, note: 'decode failed - sending original file instead' });
  return { chunks: [{ offset: 0, usableEnd: Infinity, blob: file, name: file.name }], samples: null, sampleRate: 16000 };
}

/* ── SECTION 3: STEP 2 — transcribe ONE chunk ── */

// 🔎 WHAT: sends one chunk to our server (/api/transcribe) which forwards it to Whisper. Returns the parsed JSON.
//          Retries on 503/404. If the "translations" endpoint rejects word timestamps, retries once without them.
// ⚠️ BUG-RISK: server has the Groq keys. Browser must NEVER send a key. A 401 here means the server's keys are bad, not the user's.
async function requestTranscript(endpoint, chunk, index, wantWords){
  const makeForm = (withWords) => {
    const fd = new FormData();
    fd.append('file', chunk.blob, chunk.name || ('audio_part' + index + '.wav'));
    fd.append('model', 'whisper-large-v3');
    fd.append('response_format', 'verbose_json');
    if(withWords){
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
    }
    fd.append('temperature', '0'); // 0 = most repeatable output
    // NOTE: we do NOT send a "language" field on purpose -> Whisper auto-detects the language (that is the "identify" step).
    return fd;
  };

  let withWords = wantWords;
  let response;
  for(let attempt = 1; attempt <= ENGINE.FETCH_ATTEMPTS; attempt++){
    response = await callTranscribeProxy(endpoint, makeForm(withWords));
    const transient = response.status === 503 || response.status === 404;
    if(transient && attempt < ENGINE.FETCH_ATTEMPTS){ await sleep(ENGINE.FETCH_RETRY_MS); continue; }
    if(response.status === 400 && withWords && endpoint === 'translations'){
      let paramRejected = false;
      try {
        const probe = await response.clone().json();
        const m = ((probe.error && probe.error.message) || '').toLowerCase();
        paramRejected = m.includes('timestamp_granularities') || m.includes('unknown param');
      } catch(e){}
      if(paramRejected){ withWords = false; attempt--; continue; } // retry without the word option; does not use up an attempt
    }
    break;
  }
  if(!response.ok) throw new Error(await readServerError(response));
  return response.json();
}

// 🔎 WHAT: "did the server give us enough words?" Compares letters in all words vs letters in all sentences.
//          Works for any script (English, Hindi/Devanagari ...) because it counts Unicode letters, not just a-z.
// ⚠️ BUG-RISK: the 0.85 ratio is a guess. Too high = pointless retries (slow), too low = missing words go unnoticed.
function wordsLookComplete(d){
  const words = d.words || [];
  if(!(d.segments && d.segments.length)) return words.length > 0;
  const n = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  const want = d.segments.reduce((sum, s) => sum + n(s.text).length, 0);
  if(want === 0) return words.length > 0;
  const got = words.reduce((sum, w) => sum + n(w.word).length, 0);
  return got >= want * ENGINE.WORDS_COMPLETE_RATIO;
}

// 🔎 WHAT: Whisper sometimes "hears" speech in silence/music. A sentence is thrown away only when the signs agree:
//          (silent AND unsure) OR (almost certainly silent) OR (stuck repeating itself).
// ⚠️ BUG-RISK: too strict = real speech vanishes (gaps in captions). Too loose = ghost captions during music.
//              Numbers: noSpeech = chance it is silence (0-1), avgLogprob = confidence (closer to 0 = surer), compRatio = repetition.
function isHallucinatedSegment(noSpeech, avgLogprob, compRatio){
  if(noSpeech > 0.6 && avgLogprob < -1.0) return true;
  if(noSpeech > 0.92) return true;
  if(compRatio > 3.5) return true;
  return false;
}

// 🔎 WHAT: transcribes one chunk and returns ONLY trustworthy words and sentences, already shifted to full-video time.
//          Also does the language "identify" step: reads which language Whisper heard, and if the user wants English
//          but the speech is another language, redoes this chunk through the translate endpoint.
// ⚠️ BUG-RISK: `chunk.offset` converts chunk-time to video-time. Forget it and every caption after chunk 1 lands too early.
// ⚠️ BUG-RISK: `chunk.usableEnd` stops two overlapping chunks both keeping the same words. A sentence that CROSSES this
//              line is dropped from this chunk - its words survive (word check below uses start only) and the builder
//              rescues them as "leftover words". If captions ever go missing near every ~95s, look here.
async function transcribeChunk(chunk, index, wantLang){
  let data = await requestTranscript('transcriptions', chunk, index, true);

  // Retry if too few words came back (server sometimes "forgets" them).
  for(let r = 0; r < ENGINE.WORD_RETRIES && !wordsLookComplete(data); r++){
    try {
      const again = await requestTranscript('transcriptions', chunk, index, true);
      if(again.words && again.words.length) data = again;
    } catch(e){ /* keep what we have */ }
  }

  // LANGUAGE IDENTIFY: Whisper tells us what it heard, e.g. "english", "hindi".
  const heard = String(data.language || '').toLowerCase();
  let translated = false;
  const warnings = [];
  if(wantLang === 'en' && heard && !/^en/.test(heard)){
    // User wants English captions but speech is not English -> translate this chunk.
    try {
      const t = await requestTranscript('translations', chunk, index, true);
      if(t.text || (t.segments && t.segments.length)){ data = t; translated = true; }
    } catch(e){
      // ⚠️ BUG-RISK: translation failed -> we keep the ORIGINAL language text. The user is TOLD (warning shown at the end).
      console.warn('[litix] translate failed for chunk ' + index + ', keeping original-language text:', e && e.message);
      warnings.push('Part ' + (index + 1) + ' could not be translated to English, so it is shown in the language that was spoken.');
    }
  }

  // Find the time spans Whisper invented text for (so we can also drop WORDS inside them).
  const badSpans = [];
  (data.segments || []).forEach(s => {
    const bad = isHallucinatedSegment(
      typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0,
      typeof s.avg_logprob === 'number' ? s.avg_logprob : 0,
      typeof s.compression_ratio === 'number' ? s.compression_ratio : 0);
    if(bad) badSpans.push({ a: Math.max(0, s.start) + chunk.offset, b: Math.max(0, s.end) + chunk.offset });
  });
  const inBadSpan = t => badSpans.some(sp => t >= sp.a && t < sp.b);

  const words = [];
  (data.words || []).forEach(w => {
    const text = (w.word || '').trim();
    if(!text) return;
    const start = Math.max(0, w.start) + chunk.offset;
    if(start >= chunk.usableEnd || inBadSpan(start)) return;
    words.push({ start, end: Math.max(start, Math.max(0, w.end) + chunk.offset), text });
  });

  const segments = [];
  (data.segments || []).forEach(s => {
    const text = (s.text || '').trim();
    if(!text) return;
    const start = Math.max(0, s.start) + chunk.offset;
    const end = Math.max(start, Math.max(0, s.end) + chunk.offset);
    const bad = isHallucinatedSegment(
      typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0,
      typeof s.avg_logprob === 'number' ? s.avg_logprob : 0,
      typeof s.compression_ratio === 'number' ? s.compression_ratio : 0);
    if(bad) return;
    if(start >= chunk.usableEnd || end > chunk.usableEnd) return;
    segments.push({ start, end, text });
  });

  const info = {
    chunk: index, language: heard || 'unknown', translated,
    words: words.length, sentences: segments.length,
    droppedAsInvented: badSpans.length, wordTimestampsComplete: wordsLookComplete(data)
  };
  subLog('chunk', info);
  return {
    language: heard, warnings, seconds: typeof data.duration === 'number' ? data.duration : 0,
    endSec: typeof data.duration === 'number' ? chunk.offset + data.duration : 0,
    words, segments
  };
}

/* ── SECTION 4: STEP 3 — all chunks + language decision ── */

// 🔎 WHAT: runs transcribeChunk() for every chunk, in order, and joins the results.
//          Then decides the video's main language = the language heard for the most seconds of audio.
// ⚠️ BUG-RISK: chunks run ONE AFTER ANOTHER on purpose (parallel would hit rate limits). Long video = slow, not stuck.
async function transcribeAllChunks(chunks, wantLang){
  const words = [], segments = [], heardSeconds = {}, warnings = [];
  let endSec = 0;
  for(let i = 0; i < chunks.length; i++){
    const pct = 10 + Math.round((i / chunks.length) * 80);
    showProgress(pct, chunks.length > 1 ? 'Transcribing part ' + (i + 1) + ' of ' + chunks.length + '…' : 'Transcribing speech…', 'Litix Engine');
    const r = await transcribeChunk(chunks[i], i, wantLang);
    words.push.apply(words, r.words);
    segments.push.apply(segments, r.segments);
    warnings.push.apply(warnings, r.warnings);
    if(r.endSec > endSec) endSec = r.endSec;
    const key = r.language || 'unknown';
    heardSeconds[key] = (heardSeconds[key] || 0) + (r.seconds || 1);
  }
  const total = Object.values(heardSeconds).reduce((a, b) => a + b, 0) || 1;
  const ranked = Object.entries(heardSeconds).sort((a, b) => b[1] - a[1]);
  const primary = ranked.length ? ranked[0][0] : 'unknown';
  const mixed = ranked.filter(([, s]) => s / total >= 0.15).length > 1; // 2+ languages each >=15% of audio
  const language = { primary, mixed, shareBySeconds: heardSeconds };
  window.__litixDetectedLanguage = primary;
  subLog('language', language);
  return { words, segments, endSec, language, warnings };
}

/* ── SECTION 5: STEP 4 — cleanup ── */

// 🔎 WHAT: Whisper sometimes invents 1-3 words at second 0 (e.g. "Thank you") then stays silent. Remove them.
// ⚠️ BUG-RISK: could delete REAL first words if someone says 1-3 words then pauses 3+ seconds. Tune LEAD_* in ENGINE.
function dropLeadingBlip(words, segments){
  if(words.length <= 3) return { words, segments, dropped: 0 };
  let last = 0;
  while(last < words.length - 1 && last < ENGINE.LEAD_MAX_WORDS &&
        (words[last + 1].start - words[last].end) < ENGINE.LEAD_GAP_SEC) last++;
  const gapAfter = words[last + 1] ? words[last + 1].start - words[last].end : Infinity;
  if(last < ENGINE.LEAD_MAX_WORDS && gapAfter >= ENGINE.LEAD_GAP_SEC){
    const cutoff = words[last].end;
    return { words: words.slice(last + 1), segments: segments.filter(s => s.start >= cutoff - 0.05), dropped: last + 1 };
  }
  return { words, segments, dropped: 0 };
}

// 🔎 WHAT: safety net. Speech can't end AFTER the audio ends. If the transcript's last time is way past the audio
//          length, the whole time axis was stretched (seen once: 2x too long) -> shrink everything back.
// ⚠️ BUG-RISK: if `audioDur` is wrong (too small), REAL captions get squeezed. audioDur comes from decoded samples,
//              or video.duration as a cross-check (see startGroqTranscription).
function rescaleIfTimeAxisStretched(words, segments, audioDur){
  let maxEnd = 0;
  words.forEach(w => { if(w.end > maxEnd) maxEnd = w.end; });
  segments.forEach(s => { if(s.end > maxEnd) maxEnd = s.end; });
  const rec = { audioDur, maxEnd, scale: 1, corrected: false };
  if(audioDur > 1 && maxEnd > audioDur * 1.10 + 0.75){
    const scale = audioDur / maxEnd;
    if(scale > 0.2 && scale < 0.97){
      words.forEach(w => { w.start *= scale; w.end *= scale; });
      segments.forEach(s => { s.start *= scale; s.end *= scale; });
      rec.scale = scale; rec.corrected = true;
    }
  }
  window.__lastTimingAudit = rec;
  return rec;
}

// 🔎 WHAT: charges any extra credits if the video turned out longer than the estimate made at click time.
// ⚠️ BUG-RISK: money code. `lastChargedCredits` is set in the Generate button handler BEFORE this runs.
async function reconcileCredits(realEndSec){
  if(!(currentUser && !currentUser.creditsInfinite && realEndSec > 0)) return;
  const shortfall = Math.ceil(realEndSec / 60) - lastChargedCredits;
  if(shortfall <= 0) return;
  try {
    const res = await fetch('/api/use-credits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: shortfall, action: 'reconcile', reason: 'duration-reconciliation' })
    });
    if(res.ok){
      const d = await res.json();
      if(window.__setCurrentUser){
        window.__setCurrentUser({ ...(window.__getCurrentUser ? window.__getCurrentUser() : {}), credits: d.credits, creditsInfinite: d.creditsInfinite });
      }
    }
  } catch(e){ console.error('credit reconciliation failed:', e); }
}

/* ── SECTION 5b: HINDI / HINGLISH conversion ──
   WHICH CASE ARE WE IN? (decided from the language Whisper HEARD, see transcribeAllChunks)
     A) Speech IS Hindi/Urdu  -> "rewrite spelling" mode. Every word keeps its REAL Whisper start/end time; only the
                                 letters change (Devanagari <-> Roman). Words already in the right script are not touched,
                                 and if nothing needs changing the language model is not called at all.
     B) Speech is anything else (e.g. English) -> "translate" mode. Whole sentences are translated; the words of each
                                 translated sentence are spread over that sentence's real time using word length and
                                 punctuation weights. Exact per-word timing is impossible here: the words are new.
   Both modes: a bad answer from the language model never corrupts the captions. The original text is kept for just
   that sentence and a visible note is shown to the user at the end. */

const DEVANAGARI_RE = /[\u0900-\u097F]/;

// 🔎 WHAT: shows a non-fatal note to the user (re-uses the red banner under the video).
function showWarning(msg){
  try { $('err').textContent = 'Note: ' + msg; $('err').classList.add('show'); } catch(e){}
}

// 🔎 WHAT: does this single word need its letters changed to reach the wanted script?
//          'hi' (Devanagari)  -> true for any word with letters that are NOT Devanagari (English letters, or Urdu/Arabic letters).
//          'hi-en' (Roman)    -> true for any word with letters that are NOT Latin (Devanagari, or Urdu/Arabic letters).
//          Numbers/punctuation-only words never need changing.
// ⚠️ BUG-RISK: Whisper often labels Hindi-sounding speech "urdu" and writes it in Arabic script. That is why this checks
//              "not the wanted script" instead of "is English".
function needsConversion(word, want){
  const w = String(word || '');
  return want === 'hi' ? (/\p{L}/u.test(w) && !DEVANAGARI_RE.test(w)) : /(?!\p{Script=Latin})\p{L}/u.test(w);
}

// 🔎 WHAT: sends ONE request to the language model (through our server, never with a key in the browser)
//          and returns the parsed JSON it answered with, or null if the answer was not valid JSON.
//          Throws if the server itself failed (caller decides what to do).
// ⚠️ BUG-RISK: the model name is fixed here. If Groq retires it you get "model does not exist" errors - change it here only.
async function askConversionModel(system, payload){
  let response;
  for(let attempt = 1; attempt <= ENGINE.FETCH_ATTEMPTS; attempt++){
    response = await callTranscribeProxy('chat', JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }]
    }), 'application/json');
    if(response.status === 503 && attempt < ENGINE.FETCH_ATTEMPTS){ await sleep(ENGINE.FETCH_RETRY_MS); continue; }
    break;
  }
  if(!response.ok) throw new Error(await readServerError(response));
  const data = await response.json();
  let raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '[]';
  raw = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch(e){ return null; }
}

// 🔎 WHAT: the instructions given to the language model. Plain text on purpose - read it, it is the whole "algorithm".
function conversionPrompt(want, kind){
  const roman = 'Hinglish: Hindi written in Roman/Latin letters (never Devanagari), the way a bilingual Hindi-English speaker would text it, with English words in normal English spelling.';
  const tail = ' Respond with ONLY raw JSON - no markdown, no code fences, no commentary.';
  if(kind === 'words'){
    const target = want === 'hi'
      ? 'Hindi in Devanagari script. Words already in Devanagari must be returned exactly as they are. Write English words in Devanagari letters the way Hindi speakers write them (for example "meeting" -> "मीटिंग"). Words in Urdu/Arabic script must be rewritten in Devanagari with the same pronunciation. Keep names as they sound.'
      : roman + ' Words already in Roman letters must be returned exactly as they are. Words in any other script (Devanagari, Urdu/Arabic) must be rewritten in Roman letters with the same pronunciation.';
    return 'You are a subtitle spelling engine. You receive a JSON array of arrays of strings. Each inner array is ONE subtitle sentence already split into words. Rewrite every word into ' + target +
      ' Keep any punctuation attached to its word. Return a JSON array of arrays with EXACTLY the same number of strings in every inner array, in the same order. Never merge, split, add or drop a word.' + tail;
  }
  const target = want === 'hi'
    ? (kind === 'translate'
        ? 'natural, fluent Hindi written in Devanagari script. Translate any English words into Hindi (translate their MEANING, do not just transliterate them), keeping proper nouns as-is.'
        : 'Hindi in Devanagari script, keeping the same words (write English words in Devanagari letters).')
    : roman;
  return 'You are a subtitle localization engine. You receive a JSON array of strings, each one line of a video transcript. Rewrite EACH string into ' + target +
    ' Preserve meaning, tone and order exactly. The output array MUST have the exact same number of elements as the input array, one rewritten string per input string, never merged or split.' + tail;
}

// 🔎 WHAT: word-by-word conversion for a batch of sentences. Returns, for each sentence, either the converted words
//          (same count as the input - checked here) or null when the model's answer for that sentence was unusable.
async function convertWordLists(lists, want){
  const ans = await askConversionModel(conversionPrompt(want, 'words'), lists);
  if(!Array.isArray(ans) || ans.length !== lists.length) return lists.map(() => null);
  return lists.map((list, i) => {
    const r = ans[i];
    const good = Array.isArray(r) && r.length === list.length && r.every(x => typeof x === 'string' && x.trim());
    return good ? r.map(x => x.trim()) : null;
  });
}

// 🔎 WHAT: whole-sentence conversion for a batch. Returns an array of strings, or null if the answer was unusable.
async function convertTexts(texts, want, kind){
  const ans = await askConversionModel(conversionPrompt(want, kind), texts);
  if(!Array.isArray(ans) || ans.length !== texts.length || !ans.every(x => typeof x === 'string' && x.trim())) return null;
  return ans.map(x => x.trim());
}

// 🔎 WHAT: gives new words (from text) timing across [start,end] by word length + punctuation (not "all equal").
function spreadWords(text, start, end){
  const tokens = String(text).split(/\s+/).filter(Boolean);
  return estimateWordTimesEvenly(tokens, start, end).map(w => ({ text: w.text, start: w.start, end: w.end }));
}

// 🔎 WHAT: THE conversion entry point. Input = cleaned words + sentences + the language that was heard.
//          Output = { words, segments, warnings } in the same shape as the input, so buildSubtitles() needs no changes.
// ⚠️ BUG-RISK: in "rewrite spelling" mode each sentence's text is REBUILT from its words (so words Whisper heard but
//              left out of the sentence text now appear). In "translate" mode word timing is estimated, not real.
async function convertTranscript(words, segments, want, speechLang){
  const warnings = [];
  const speechIsHindi = /hindi|urdu/.test(String(speechLang || '').toLowerCase());
  const segs = segments.slice().sort((a, b) => a.start - b.start).map(s => ({ start: s.start, end: s.end, text: s.text }));
  const sorted = words.slice().sort((a, b) => a.start - b.start).map(w => ({ start: w.start, end: w.end, text: w.text }));
  const info = { want, speechLang: speechLang || 'unknown', mode: speechIsHindi ? 'rewrite-spelling' : 'translate', modelCalls: 0, sentences: segs.length, kept: 0, fallbackToSentence: 0 };
  const flaky = new Set();               // reasons, so the user sees each problem once

  /* ---------- CASE B: speech is not Hindi -> translate whole sentences ---------- */
  if(!speechIsHindi){
    const out = segs.map(s => ({ start: s.start, end: s.end, text: s.text }));
    for(let i = 0; i < out.length; i += ENGINE.CONVERT_TEXT_BATCH){
      const batch = out.slice(i, i + ENGINE.CONVERT_TEXT_BATCH);
      showProgress(Math.min(97, 96 + Math.round((i / Math.max(1, out.length)) * 2)), want === 'hi' ? 'Converting to Hindi…' : 'Converting to Hinglish…', '');
      try {
        info.modelCalls++;
        const res = await convertTexts(batch.map(b => b.text), want, 'translate');
        if(res) batch.forEach((b, k) => { b.text = res[k]; });
        else { info.kept += batch.length; flaky.add('the language model gave an unusable answer for some sentences, so those stay in the original language'); }
      } catch(e){
        info.kept += batch.length;
        flaky.add('the conversion service failed (' + ((e && e.message) || 'unknown error').slice(0, 80) + '), so some sentences stay in the original language');
      }
    }
    const outWords = [];
    out.forEach(s => spreadWords(s.text, s.start, s.end).forEach(w => outWords.push(w)));
    flaky.forEach(r => warnings.push('Hindi/Hinglish conversion: ' + r + '.'));
    subLog('convert', info);
    return { words: outWords, segments: out, warnings };
  }

  /* ---------- CASE A: speech IS Hindi -> change spelling, keep real timing ---------- */
  const { buckets, leftovers } = assignWordsToSentences(segs, sorted);
  const groups = segs.map((s, i) => ({ seg: s, words: buckets[i] }));
  let cur = null;
  leftovers.forEach(w => {                      // words that belong to no sentence: converted too, not lost
    if(cur && w.start - cur.words[cur.words.length - 1].end <= ENGINE.PAUSE_GAP_SEC) cur.words.push(w);
    else { cur = { seg: null, words: [w] }; groups.push(cur); }
  });

  // which groups actually need the model?
  const todo = groups.filter(g => g.words.length
    ? g.words.some(w => needsConversion(w.text, want))
    : (g.seg && g.seg.text.split(/\s+/).some(t => needsConversion(t, want))));
  info.sentencesNeedingModel = todo.length;

  const fallback = [];                          // groups whose word-by-word answer was unusable
  for(let i = 0; i < todo.length; i += ENGINE.CONVERT_WORD_BATCH){
    const batch = todo.slice(i, i + ENGINE.CONVERT_WORD_BATCH);
    showProgress(Math.min(97, 96 + Math.round((i / Math.max(1, todo.length)) * 2)), want === 'hi' ? 'Converting to Hindi…' : 'Converting to Hinglish…', '');
    const wordGroups = batch.filter(g => g.words.length);
    batch.filter(g => !g.words.length).forEach(g => fallback.push(g));   // no timed words at all -> text path
    if(!wordGroups.length) continue;
    try {
      info.modelCalls++;
      const res = await convertWordLists(wordGroups.map(g => g.words.map(w => w.text)), want);
      wordGroups.forEach((g, k) => { if(res[k]) g.words.forEach((w, j) => { w.text = res[k][j]; }); else fallback.push(g); });
    } catch(e){
      info.kept += wordGroups.length;
      flaky.add('the conversion service failed (' + ((e && e.message) || 'unknown error').slice(0, 80) + '), so some sentences keep their original letters');
    }
  }

  // retry each bad sentence ALONE once (a short request is more reliable), then fall back to whole-sentence text
  for(const g of fallback){
    if(g.words.length){
      try {
        info.modelCalls++;
        const one = await convertWordLists([g.words.map(w => w.text)], want);
        if(one[0]){ g.words.forEach((w, j) => { w.text = one[0][j]; }); continue; }
      } catch(e){ /* fall through to the text path */ }
    }
    const originalText = g.words.length ? g.words.map(w => w.text).join(' ') : g.seg.text;
    const start = g.words.length ? g.words[0].start : g.seg.start;
    const end = g.words.length ? g.words[g.words.length - 1].end : g.seg.end;
    try {
      info.modelCalls++;
      const res = await convertTexts([originalText], want, 'transliterate');
      if(res){
        g.words = spreadWords(res[0], start, end);          // timing is estimated for THIS sentence only
        info.fallbackToSentence++;
        flaky.add('for some sentences the exact word timing could not be kept, so their words are spaced by length');
        continue;
      }
    } catch(e){ /* keep original below */ }
    info.kept++;
    if(!g.words.length) g.words = spreadWords(originalText, start, end);
    flaky.add('some sentences could not be converted and keep their original letters');
  }

  const outWords = [], outSegs = [];
  groups.forEach(g => {
    g.words.forEach(w => outWords.push(w));
    if(g.seg) outSegs.push({ start: g.seg.start, end: g.seg.end, text: g.words.length ? g.words.map(w => w.text).join(' ') : g.seg.text });
  });
  outWords.sort((a, b) => a.start - b.start);
  flaky.forEach(r => warnings.push('Hindi/Hinglish conversion: ' + r + '.'));
  subLog('convert', info);
  return { words: outWords, segments: outSegs, warnings };
}

/* ── SECTION 6: the main button handler ── */

// 🔎 WHAT: turns raw error text into a message a user can act on.
// ⚠️ BUG-RISK: order matters. AUDIO_DECODE_FAILED must be checked BEFORE "too large", otherwise a decode failure
//              is wrongly reported as "file too large".
function friendlyError(err){
  const msg = (err && err.message) || 'Unknown error';
  if(msg.includes('AUDIO_DECODE_FAILED')){
    const m = msg.match(/\(audio codec: ([^)]+)\)/);
    return m ? "Couldn't decode this file's audio (codec: " + m[1] + '). Try re-exporting it as a standard MP4/MOV.'
             : "Couldn't read this file's audio track. Try re-exporting it as a standard MP4/MOV, or use a different file.";
  }
  if(/\b401\b/.test(msg) || /invalid[_ ]api[_ ]key/i.test(msg)) return 'The transcription service rejected the request (401). Please try again shortly.';
  if(/\b413\b/.test(msg) || /too large/i.test(msg)) return 'File too large even after audio extraction. Try a shorter clip.';
  if(msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Network error — check your internet connection and try again.';
  return msg;
}

// 🔎 WHAT: THE entry point (name kept because other code calls it). Runs the whole pipeline top to bottom.
async function startGroqTranscription(){
  isGenerating = true;
  resetOutput();
  $('btn-gen').disabled = true;
  $('spinner').classList.add('on');
  $('btn-label').textContent = 'Transcribing…';
  showProgress(2, 'Extracting audio…', currentFile.name);
  $('groq-status').style.display = 'inline-flex';
  $('bar').classList.add('active');

  try {
    const wantLang = $('lang-sel').value; // 'en' | 'hi' | 'hi-en'

    // STEP 1: audio
    const audio = await getAudioForTranscription(currentFile);

    // STEPS 2+3: transcribe + identify language
    const got = await transcribeAllChunks(audio.chunks, wantLang);
    let words = got.words, segments = got.segments;
    if(!words.length && !segments.length) throw new Error('No speech detected in this file.');
    words.sort((a, b) => a.start - b.start);
    segments.sort((a, b) => a.start - b.start);
    clipWordOverlaps(words);

    // STEP 4: cleanup
    const lead = dropLeadingBlip(words, segments);
    words = lead.words; segments = lead.segments;

    const warnings = got.warnings.slice();
    if(wantLang === 'hi' || wantLang === 'hi-en'){
      showProgress(96, wantLang === 'hi' ? 'Converting to Hindi…' : 'Converting to Hinglish…', '');
      const conv = await convertTranscript(words, segments, wantLang, got.language.primary);
      segments = conv.segments; words = conv.words;
      warnings.push.apply(warnings, conv.warnings);
      clipWordOverlaps(words);
    }

    showProgress(98, 'Building subtitles…', '');
    await reconcileCredits(got.endSec);

    let realDur = (audio.samples && audio.samples.length) ? audio.samples.length / audio.sampleRate : (vp.duration || 0);
    if(vp.duration > 1 && realDur > vp.duration * 1.05 + 0.75) realDur = vp.duration; // trust the player if decoded audio is longer
    const audit = rescaleIfTimeAxisStretched(words, segments, realDur);
    if(audit.corrected) console.warn('[litix] time axis was ' + (1 / audit.scale).toFixed(2) + 'x too long - rescaled.');

    if(audio.samples && audio.samples.length && words.length){
      words = refineWordBoundariesWithAudio(words, audio.samples, audio.sampleRate);
      clipWordOverlaps(words);
    }
    subLog('cleanup', { droppedLeadingWords: lead.dropped, timeAxisCorrected: audit.corrected, words: words.length, sentences: segments.length });

    // STEP 5: captions
    rawWords = words;
    rawSegments = segments;
    buildSubtitles();
    showProgress(100, 'Done!', (words.length || segments.length) + ' segments');
    if(warnings.length) showWarning(Array.from(new Set(warnings)).join(' '));
    setTimeout(() => finishGeneration(true), 600);
  } catch(err){
    console.error('[litix] generation failed:', err);
    finishGeneration(false);
    showError('Transcription error: ' + friendlyError(err));
  }
}

/* ── SECTION 7: STEP 5 — turn words into captions ──
   INPUT : rawSegments = [{start,end,text}]   (sentences, with punctuation)
           rawWords    = [{start,end,text}]   (one entry per spoken word, real timing)
   OUTPUT: subtitles   = [{start,end,text,wordTimes:[{text,start,end,score}]}]
   buildSubtitles() is also called when the user moves the "words per caption" slider. */

// 🔎 WHAT: small repeatable random-number maker. Same seed -> same sequence.
// ⚠️ BUG-RISK: do NOT replace with Math.random(). The old code did, and every slider move reshuffled all captions.
function makeRng(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 🔎 WHAT: gives every word to the sentence it was spoken in (by the word's middle moment in time).
//          Words that fit NO sentence are returned as `leftovers`.
// ⚠️ BUG-RISK: both lists must be sorted by start. They are sorted in startGroqTranscription; if you load saved data
//              from elsewhere, sort first or words will land in the wrong sentence.
function assignWordsToSentences(segments, words){
  const tol = ENGINE.SEG_TOLERANCE_SEC;
  const buckets = segments.map(() => []);
  const leftovers = [];
  let si = 0;
  for(const w of words){
    if(!w || typeof w.text !== 'string' || !w.text.trim() || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const mid = (w.start + w.end) / 2;
    while(si < segments.length && mid > segments[si].end + tol) si++;
    if(si < segments.length && mid >= segments[si].start - tol) buckets[si].push(w);
    else leftovers.push(w);
  }
  return { buckets, leftovers };
}

// 🔎 WHAT: gives each WORD OF THE SENTENCE TEXT a start/end time.
//          For each text word, look for the same word in the real timed words (searching a few ahead).
//          Found  -> use its real time.
//          Missing -> spread the missing words evenly between their timed neighbours.
// ⚠️ BUG-RISK (KNOWN LIMIT): the sentence TEXT is the source of truth. If Whisper's word list contains a spoken word
//              that its sentence text left out (seen once: "When you have" before "money,"), that word is NOT shown.
//              A "rescue" was tried and removed: it doubled words. Needs a proper fix if it matters.
// ⚠️ BUG-RISK: "lookahead 4" lets a missing word be skipped. If the model changed a word ("gonna"/"going to") that
//              word gets a guessed time, never a crash.
function alignSentence(seg, timed){
  const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
  if(!tokens.length) return [];
  if(!timed.length) return estimateWordTimesEvenly(tokens, seg.start, seg.end).map(w => ({ text: w.text, start: w.start, end: w.end }));

  const found = new Array(tokens.length).fill(null);
  let ptr = 0;
  for(let k = 0; k < tokens.length; k++){
    const want = normWord(tokens[k]);
    if(!want) continue;
    for(let j = ptr; j < Math.min(timed.length, ptr + 4); j++){
      if(normWord(timed[j].text) === want){ found[k] = { start: timed[j].start, end: timed[j].end }; ptr = j + 1; break; }
    }
  }

  const out = new Array(tokens.length);
  let k = 0;
  while(k < tokens.length){
    if(found[k]){ out[k] = { text: tokens[k], start: found[k].start, end: found[k].end }; k++; continue; }
    const a = k;
    while(k < tokens.length && !found[k]) k++;       // tokens a..k-1 have no real time
    const lo = a > 0 ? out[a - 1].end : seg.start;   // after the previous timed word
    let hi = k < tokens.length ? found[k].start : seg.end; // before the next timed word
    if(hi < lo + 0.05 * (k - a)) hi = lo + 0.05 * (k - a);
    estimateWordTimesEvenly(tokens.slice(a, k), lo, hi).forEach((w, i) => { out[a + i] = { text: w.text, start: w.start, end: w.end }; });
  }

  out.sort((x, y) => x.start - y.start);
  for(let i = 0; i < out.length; i++){
    if(out[i].end < out[i].start + 0.01) out[i].end = out[i].start + 0.01;
    if(i < out.length - 1 && out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.01, out[i + 1].start);
  }
  return out;
}

// 🔎 WHAT: builds the list of sentences, each a list of timed words, in time order.
//          Leftover words (see assignWordsToSentences) become their own mini-sentences so NO spoken word is lost.
function buildTimedSentences(segments, words){
  const segs = segments.slice().sort((a, b) => a.start - b.start);
  const sorted = words.slice().sort((a, b) => a.start - b.start);
  const { buckets, leftovers } = assignWordsToSentences(segs, sorted);

  const sentences = [];
  segs.forEach((seg, i) => {
    if(!seg.text || !seg.text.trim()) return;
    const w = alignSentence(seg, buckets[i]);
    if(w.length) sentences.push(w);
  });

  let cur = null;
  leftovers.forEach(w => {
    const lw = { text: w.text.trim(), start: w.start, end: Math.max(w.end, w.start + 0.05) };
    if(cur && lw.start - cur[cur.length - 1].end <= ENGINE.PAUSE_GAP_SEC) cur.push(lw);
    else { cur = [lw]; sentences.push(cur); }
  });

  sentences.sort((a, b) => a[0].start - b[0].start);
  return sentences;
}

// 🔎 WHAT: no single word may stay highlighted for ages (e.g. a word stretched over a long pause).
function capLongWords(words){
  return words.map(w => {
    const chars = Math.max(2, (w.text || '').length);
    const natural = Math.min(0.5, 0.10 + 0.045 * chars);
    const cap = Math.max(0.35, natural * 1.75 + 0.10);
    return (w.end - w.start) > cap ? { text: w.text, start: w.start, end: w.start + cap } : w;
  });
}

// 🔎 WHAT: Whisper sometimes gives a word ~0.02s (it "flashes"). Give such words MIN_WORD_SEC by borrowing a little
//          time from a touching neighbour that can spare it, else from the silence after the word.
// ⚠️ BUG-RISK: edits the array IN PLACE. Pass a copy if you still need the original timings.
function fixFlashWords(words){
  const E = ENGINE;
  for(let i = 0; i < words.length; i++){
    const w = words[i], prev = words[i - 1], next = words[i + 1];
    let need = E.MIN_WORD_SEC - (w.end - w.start);
    if(need <= 0) continue;
    if(prev && (w.start - prev.end) <= E.ADJACENT_SEC){
      const spare = Math.min(E.MAX_BORROW_PREV_SEC, Math.max(0, (prev.end - prev.start) - E.DONOR_KEEP_SEC));
      const take = Math.min(need, spare);
      if(take > 0){ w.start -= take; prev.end = w.start; need -= take; }
    }
    if(need > 0 && next && (next.start - w.end) <= E.ADJACENT_SEC){
      const spare = Math.min(E.MAX_BORROW_NEXT_SEC, Math.max(0, (next.end - next.start) - E.DONOR_KEEP_SEC));
      const take = Math.min(need, spare);
      if(take > 0){ w.end += take; next.start = w.end; need -= take; }
    }
    if(need > 0){ // still too short -> hold the word a little longer into the silence AFTER it
      const room = next ? Math.max(0, next.start - w.end) : need;
      const take = Math.min(need, room);
      w.end += take; need -= take;
    }
    if(need > 0){ // still too short -> last resort: start it a little EARLIER, into the silence BEFORE it
      const room = prev ? Math.max(0, w.start - prev.end) : w.start;
      w.start -= Math.min(need, room, E.MAX_BORROW_PREV_SEC);
    }
  }
  return words;
}

// 🔎 WHAT: picks how many words the next caption gets. Smaller counts are more likely than bigger ones.
function pickGroupSize(minW, maxW, dist, rng){
  if(dist && dist.length){
    const total = dist.reduce((s, d) => s + d[1], 0);
    let r = rng() * total;
    for(const [size, weight] of dist){ r -= weight; if(r <= 0) return size; }
    return dist[dist.length - 1][0];
  }
  if(maxW <= minW) return minW;
  const weights = [];
  for(let d = 0; d <= maxW - minW; d++) weights.push(1 / Math.pow(d + 1, 1.5));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for(let d = 0; d < weights.length; d++){ r -= weights[d]; if(r <= 0) return minW + d; }
  return maxW;
}

// 🔎 WHAT: cuts ONE sentence's words into caption-sized groups. A pause (> PAUSE_GAP_SEC) always ends a group.
//          A too-short last group is glued to the previous one - but only if that does not exceed the max size.
// ⚠️ BUG-RISK: `maxAllowed` must be the true biggest group allowed (dist max OR maxWordsPerSub). If it is too low,
//              tiny leftover captions appear at the end of sentences; too high, captions overflow the screen.
function groupWords(words, minW, maxW, dist, rng){
  const groups = [];
  let i = 0;
  while(i < words.length){
    let size = Math.max(1, Math.min(pickGroupSize(minW, maxW, dist, rng), words.length - i));
    for(let k = 1; k < size; k++){
      if(words[i + k].start - words[i + k - 1].end > ENGINE.PAUSE_GAP_SEC){ size = k; break; }
    }
    groups.push(words.slice(i, i + size));
    i += size;
  }
  const smallest = dist && dist.length ? Math.min(...dist.map(d => d[0])) : minW;
  const maxAllowed = dist && dist.length ? Math.max(...dist.map(d => d[0])) : maxW;
  if(groups.length > 1 && groups[groups.length - 1].length < smallest){
    const tail = groups[groups.length - 1], prev = groups[groups.length - 2];
    const gap = tail[0].start - prev[prev.length - 1].end;
    if(gap <= ENGINE.PAUSE_GAP_SEC && prev.length + tail.length <= maxAllowed){
      groups.pop();
      groups[groups.length - 1] = prev.concat(tail);
    }
  }
  return groups;
}

// 🔎 WHAT: THE builder. Reads rawSegments + rawWords (+ style limits) and fills `subtitles`.
//          Safe to call again any time (slider moved, template changed): same inputs -> same captions.
// ⚠️ BUG-RISK: reads the globals `rawSegments`, `rawWords`, `style`. If captions look wrong after a template change,
//              check style.maxWordsPerSub / style.minWordsPerSub / style._wordsDist first.
function buildSubtitles(){
  const maxW = Math.max(1, style.maxWordsPerSub || 3);
  const minW = Math.max(1, Math.min(style.minWordsPerSub || 1, maxW));
  const dist = style._wordsDist || null;
  const rng = makeRng(ENGINE.RNG_SEED);

  // 1) sentences of timed words (copies, so repeated builds never corrupt rawWords)
  const sentences = buildTimedSentences(
    rawSegments.map(s => ({ start: s.start, end: s.end, text: s.text })),
    rawWords.map(w => ({ start: w.start, end: w.end, text: w.text })));

  // 2) repair timing across the WHOLE video at once (a flash word may borrow from a word in the previous sentence)
  const lengths = sentences.map(s => s.length);
  let flat = capLongWords([].concat(...sentences)).map(w => ({ text: w.text, start: w.start, end: w.end }));
  fixFlashWords(flat);

  // 3) cut each sentence into captions
  subtitles = [];
  let pos = 0;
  lengths.forEach(n => {
    const sentenceWords = flat.slice(pos, pos + n);
    pos += n;
    groupWords(sentenceWords, minW, maxW, dist, rng).forEach(g => {
      subtitles.push({
        start: g[0].start,
        end: g[g.length - 1].end,
        text: g.map(w => w.text).join(' '),
        wordTimes: g.map(w => ({ text: w.text, start: w.start, end: w.end, score: scoreWordImportance(w.text) }))
      });
    });
  });

  subtitles.sort((a, b) => a.start - b.start);
  normalizeSubtitleTiming(subtitles); // closes tiny gaps, merges micro-captions
  subLog('build', { captions: subtitles.length, fromWords: rawWords.length, fromSentences: rawSegments.length, maxW, minW, customSizes: !!dist });
  renderList();
  updateSubCount();
  if(enforceLineBudget(subtitles)){ renderList(); updateSubCount(); } // splits captions that would not fit on screen
  window.__computeFixedSubFontSize && window.__computeFixedSubFontSize();
}
/* ═══════════════════════════ LITIX SUBTITLE ENGINE — END ═══════════════════════════ */
