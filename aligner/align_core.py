"""
align_core.py -- the contract layer of the Litix aligner (pure Python, no ML imports).

THE RULE THIS FILE ENFORCES
  ASR gives TEXT only. Every time in the output comes from forced alignment against the audio.
  Output has exactly ONE entry per transcript word, same order, same text. A word that cannot be
  timed is FLAGGED (status != "ok", times null where there is no honest time) -- never dropped,
  never given an invented time. validate_output() raises if this is ever violated.

WHAT IS *NOT* PROVEN HERE
  The acoustic model (see mms_backend.py) is not run by the tests in this folder. Accuracy on real
  speech is only established by tools/verify_real_audio.py on real, hand-marked clips.
"""
from __future__ import annotations
import re, unicodedata
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence

# ---- language support: stated explicitly, never implied ---------------------------------------
# 'verified' stays False until tools/verify_real_audio.py passes on real clips for that mode and
# writes verification.json. The service reports this honestly via /health.
LANGUAGE_SUPPORT = {
    "en":    {"status": "supported",    "script": "Latin",
              "note": "English text aligned directly. Numbers are spoken-form expanded for alignment."},
    "hi":    {"status": "experimental", "script": "Devanagari",
              "note": "Devanagari is romanized (built-in map, or uroman if installed) to match the acoustic model's letters. "
                      "Digits cannot be aligned (no Hindi number words) and are flagged."},
    "hi-en": {"status": "experimental", "script": "Latin or Devanagari (mixed)",
              "note": "Romanized Hinglish is aligned as spelled; spelling varies a lot, so confidence is checked per word. "
                      "Devanagari words are romanized by the same map. Digits are flagged."},
}

MIN_SCORE_DEFAULT = 0.35      # words below this are marked low_confidence (still timed from audio, but flagged)

class AlignmentContractError(Exception):
    pass

# ---- number words (English) ---------------------------------------------------------------------
_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_ORD = {"one":"first","two":"second","three":"third","five":"fifth","eight":"eighth","nine":"ninth","twelve":"twelfth"}

def _int_words(n: int) -> List[str]:
    if n < 0: return ["minus"] + _int_words(-n)
    if n < 20: return [_ONES[n]]
    if n < 100: return [_TENS[n // 10]] + ([] if n % 10 == 0 else [_ONES[n % 10]])
    if n < 1000: return [_ONES[n // 100], "hundred"] + ([] if n % 100 == 0 else _int_words(n % 100))
    for size, name in ((10**9, "billion"), (10**6, "million"), (10**3, "thousand")):
        if n >= size:
            return _int_words(n // size) + [name] + ([] if n % size == 0 else _int_words(n % size))
    return []

def english_number_words(token: str) -> Optional[List[str]]:
    """'57' -> fifty seven, '1,200' -> one thousand two hundred, '3.5' -> three point five, '1st' -> first. None if not a number."""
    t = token.replace(",", "")
    m = re.fullmatch(r"(\d{1,9})(st|nd|rd|th)", t, re.I)
    if m:
        w = _int_words(int(m.group(1))); last = w[-1]
        w[-1] = _ORD.get(last) or (last[:-1] + "ieth" if last.endswith("y") else last + "th")
        return w
    if re.fullmatch(r"\d{1,9}", t): return _int_words(int(t))
    m = re.fullmatch(r"(\d{1,9})\.(\d+)", t)
    if m: return _int_words(int(m.group(1))) + ["point"] + [_ONES[int(d)] for d in m.group(2)]
    if re.fullmatch(r"\d+", t):            # very long digit strings: digit by digit
        return [_ONES[int(d)] for d in t]
    return None

# ---- Devanagari -> Latin (approximate pronunciation, for ALIGNMENT and optional display) ----------
_DEV_CONS = {"क":"k","ख":"kh","ग":"g","घ":"gh","ङ":"n","च":"ch","छ":"chh","ज":"j","झ":"jh","ञ":"n","ट":"t","ठ":"th","ड":"d","ढ":"dh","ण":"n",
             "त":"t","थ":"th","द":"d","ध":"dh","न":"n","प":"p","फ":"ph","ब":"b","भ":"bh","म":"m","य":"y","र":"r","ल":"l","व":"v","श":"sh","ष":"sh",
             "स":"s","ह":"h","ळ":"l","क़":"q","ख़":"kh","ग़":"g","ज़":"z","ड़":"r","ढ़":"rh","फ़":"f","य़":"y"}
_DEV_VOW = {"अ":"a","आ":"aa","इ":"i","ई":"ee","उ":"u","ऊ":"oo","ऋ":"ri","ए":"e","ऐ":"ai","ओ":"o","औ":"au","ऑ":"o","ऍ":"e"}
_DEV_MATRA = {"ा":"aa","ि":"i","ी":"ee","ु":"u","ू":"oo","ृ":"ri","े":"e","ै":"ai","ो":"o","ौ":"au","ॉ":"o","ॅ":"e"}
_VIRAMA, _NUKTA = "्", "़"
_DEV_DIGITS = "०१२३४५६७८९"

def romanize_devanagari(word: str) -> str:
    s = unicodedata.normalize("NFC", word)
    s = (s.replace("क"+_NUKTA, "क़").replace("ख"+_NUKTA, "ख़").replace("ग"+_NUKTA, "ग़")
          .replace("ज"+_NUKTA, "ज़").replace("ड"+_NUKTA, "ड़").replace("ढ"+_NUKTA, "ढ़").replace("फ"+_NUKTA, "फ़"))
    out: List[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch in _DEV_CONS:
            out.append(_DEV_CONS[ch])
            nxt = s[i + 1] if i + 1 < len(s) else ""
            if nxt == _VIRAMA: i += 2; continue                   # conjunct: no vowel
            if nxt in _DEV_MATRA: out.append(_DEV_MATRA[nxt]); i += 2; continue
            out.append("a")                                       # inherent vowel (trimmed at word end below)
        elif ch in _DEV_VOW: out.append(_DEV_VOW[ch])
        elif ch in _DEV_MATRA: out.append(_DEV_MATRA[ch])
        elif ch in ("ं", "ँ"): out.append("n")
        elif ch == "ः": out.append("h")
        elif ch in (_VIRAMA, _NUKTA, "।", "॥"): pass
        else: out.append(ch)
        i += 1
    r = "".join(out)
    if len(r) > 2 and r.endswith("a") and not r.endswith("aa") and any(c in _DEV_CONS or c in _DEV_CONS for c in word[-1:]):
        r = r[:-1]                                                # word-final inherent 'a' is normally silent in Hindi
    return r

def has_devanagari(s: str) -> bool:
    return any("\u0900" <= c <= "\u097f" for c in s)

# ---- word preparation ---------------------------------------------------------------------------
@dataclass
class PreparedWord:
    index: int
    text: str                         # EXACTLY the transcript word (punctuation, case, script untouched)
    tokens: List[str] = field(default_factory=list)   # what the acoustic model aligns ([a-z'] only)
    unalignable: Optional[str] = None                 # reason code when tokens is empty
    roman: Optional[str] = None                       # display romanization (hi / hi-en only)

def prepare_word(index: int, text: str, lang: str, romanizer: Optional[Callable[[str], str]] = None) -> PreparedWord:
    pw = PreparedWord(index=index, text=text)
    s = unicodedata.normalize("NFC", text)
    s = "".join(c for c in s if unicodedata.category(c) not in ("Cf", "Cc"))      # zero-width & control chars
    if lang not in LANGUAGE_SUPPORT:
        pw.unalignable = "unsupported_language"; return pw
    if any(c in _DEV_DIGITS for c in s) or (lang != "en" and re.search(r"\d", s)):
        pw.unalignable = "number_not_supported_for_language"; return pw
    parts: List[str] = []
    for piece in re.split(r"[\s\-_/\u2013\u2014]+", s):
        if not piece: continue
        core = piece.strip(".,!?;:\"“”‘’()[]{}…%$€£₹*+=<>|\\^~`#@&")
        if not core: continue
        if re.search(r"\d", core):
            nums = english_number_words(core.replace("\u2019", "'"))
            if nums is None: pw.unalignable = "number_not_supported_for_language"; return pw
            parts.extend(nums); continue
        parts.append(core)
    toks: List[str] = []
    for p in parts:
        r = p
        if has_devanagari(p) or any(ord(c) > 0x024F for c in p):
            r = (romanizer or romanize_devanagari)(p) if has_devanagari(p) or romanizer else ""
        r = unicodedata.normalize("NFKD", r).encode("ascii", "ignore").decode().lower().replace("\u2019", "'")
        r = re.sub(r"[^a-z']", "", r).strip("'")
        if r: toks.append(r)
        else:
            pw.unalignable = "no_speakable_characters" if not toks and len(parts) == 1 else "unknown_script"
            return pw
    if not toks: pw.unalignable = "no_speakable_characters"; return pw
    pw.tokens = toks
    if lang in ("hi", "hi-en") and has_devanagari(text):
        pw.roman = " ".join(romanize_devanagari(p) for p in re.split(r"[\s\-]+", s) if p).strip() or None
    return pw

def prepare_words(words: Sequence[str], lang: str, romanizer=None) -> List[PreparedWord]:
    return [prepare_word(i, w, lang, romanizer) for i, w in enumerate(words)]

def flatten_tokens(prepared: Sequence[PreparedWord]):
    """-> (flat token list for the aligner, per-word (first, last+1) ranges or None)."""
    flat: List[str] = []; ranges: List[Optional[tuple]] = []
    for pw in prepared:
        if pw.tokens: ranges.append((len(flat), len(flat) + len(pw.tokens))); flat.extend(pw.tokens)
        else: ranges.append(None)
    return flat, ranges

@dataclass
class TokenSpan:
    start: float      # seconds
    end: float
    score: float      # 0..1

def assemble(prepared: Sequence[PreparedWord], ranges, spans: Sequence[Optional[TokenSpan]], audio_dur: float,
             lang: str, min_score: float = MIN_SCORE_DEFAULT) -> List[dict]:
    """Map token-level spans back to exactly one entry per transcript word."""
    out: List[dict] = []
    for pw, rg in zip(prepared, ranges):
        e = {"index": pw.index, "text": pw.text, "start": None, "end": None, "score": None, "status": "ok", "reason": None}
        if pw.roman: e["roman"] = pw.roman
        if rg is None:
            e["status"] = "unaligned"; e["reason"] = pw.unalignable or "no_tokens"
        else:
            sp = [spans[k] for k in range(rg[0], rg[1])]
            if any(s is None for s in sp):
                e["status"] = "unaligned"; e["reason"] = "aligner_returned_no_span"
            else:
                st = max(0.0, min(s.start for s in sp)); en = min(audio_dur, max(s.end for s in sp))
                if en < st: en = st
                sc = sum(s.score for s in sp) / len(sp)
                e.update(start=round(st, 3), end=round(en, 3), score=round(sc, 3))
                if sc < min_score: e["status"] = "low_confidence"; e["reason"] = f"score {sc:.2f} < {min_score}"
        out.append(e)
    return out

def validate_output(input_words: Sequence[str], out: Sequence[dict], audio_dur: float) -> None:
    """The contract. Raises AlignmentContractError on ANY violation."""
    if len(out) != len(input_words):
        raise AlignmentContractError(f"word count changed: {len(input_words)} in, {len(out)} out")
    prev_end = 0.0
    for i, (w, e) in enumerate(zip(input_words, out)):
        if e.get("index") != i: raise AlignmentContractError(f"order/index broken at {i}")
        if e.get("text") != w: raise AlignmentContractError(f"text changed at {i}: {w!r} -> {e.get('text')!r}")
        st, en = e.get("start"), e.get("end")
        if e.get("status") == "unaligned":
            if st is not None or en is not None: raise AlignmentContractError(f"unaligned word {i} carries a time")
            continue
        if st is None or en is None: raise AlignmentContractError(f"timed word {i} has no time")
        if not (0 <= st <= en <= audio_dur + 0.05): raise AlignmentContractError(f"word {i} outside audio: {st}-{en} of {audio_dur}")
        if st < prev_end - 0.02: raise AlignmentContractError(f"word {i} starts before previous word ended ({st} < {prev_end})")
        prev_end = max(prev_end, en)

def summarize(out: Sequence[dict]) -> dict:
    c = {"ok": 0, "low_confidence": 0, "unaligned": 0}
    for e in out: c[e["status"]] += 1
    return {"words": len(out), **c}
