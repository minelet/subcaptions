import io, os, random, sys, unittest, wave
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
import align_core as core
import service_logic as L

def wav_bytes(seconds, rate=16000, channels=1, width=2):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(channels); w.setsampwidth(width); w.setframerate(rate)
        w.writeframes(np.zeros(int(seconds * rate) * channels, dtype="<i2").tobytes())
    return b.getvalue()

class EvenBackend(L.Backend):
    """TEST DOUBLE: spreads tokens evenly over the clip. Tests the CONTRACT, says nothing about acoustic accuracy."""
    name = "test-even"
    def __init__(self, none_rate=0.0, fail=False, seed=0): self.none_rate, self.fail, self.r = none_rate, fail, random.Random(seed)
    def align(self, samples, toks):
        if self.fail: raise RuntimeError("model exploded")
        d = len(samples) / 16000.0; n = len(toks); out = []
        for i in range(n):
            out.append(None if self.r.random() < self.none_rate else core.TokenSpan(d * i / n, d * (i + 0.9) / n, self.r.random()))
        return out

class Numbers(unittest.TestCase):
    def test_words(self):
        f = lambda t: " ".join(core.english_number_words(t))
        self.assertEqual(f("57"), "fifty seven"); self.assertEqual(f("1,200"), "one thousand two hundred")
        self.assertEqual(f("3.5"), "three point five"); self.assertEqual(f("0"), "zero"); self.assertEqual(f("100"), "one hundred")
        self.assertEqual(f("2024"), "two thousand twenty four")
        for t, e in (("1st","first"),("2nd","second"),("3rd","third"),("4th","fourth"),("11th","eleventh"),("12th","twelfth"),("20th","twentieth"),("21st","first"),("100th","hundredth")):
            self.assertEqual(f(t).split()[-1], e, t)

class Prepare(unittest.TestCase):
    def test_keeps_text_exactly(self):
        for w in ["Hello,", "don't", "57%", "well-known", "नमस्ते।", "😀", "—", "A.I."]:
            self.assertEqual(core.prepare_word(0, w, "en" if w.isascii() or w in ("😀","—") else "hi").text, w)
    def test_en(self):
        p = core.prepare_word
        self.assertEqual(p(0, "Hello,", "en").tokens, ["hello"]); self.assertEqual(p(0, "well-known", "en").tokens, ["well", "known"])
        self.assertEqual(p(0, "57%", "en").tokens, ["fifty", "seven"]); self.assertEqual(p(0, "don't", "en").tokens, ["don't"])
        self.assertEqual(p(0, "😀", "en").unalignable, "no_speakable_characters")
    def test_hindi(self):
        p = core.prepare_word
        self.assertEqual(p(0, "नमस्ते।", "hi").tokens, ["namaste"]); self.assertEqual(p(0, "कमल", "hi").tokens, ["kamal"])
        self.assertEqual(p(0, "15", "hi").unalignable, "number_not_supported_for_language")   # honest: no Hindi number words
        self.assertEqual(p(0, "१५", "hi").unalignable, "number_not_supported_for_language")
        self.assertEqual(p(0, "kya hai", "hi-en").tokens, ["kya", "hai"])
        self.assertTrue(p(0, "है", "hi-en").roman)                                             # display romanization available
    def test_unsupported_language_flags_everything(self):
        self.assertEqual(core.prepare_word(0, "hola", "es").unalignable, "unsupported_language")

class Contract(unittest.TestCase):
    def good(self):
        words = ["Hello,", "world", "57", "😀", "नमस्ते"]
        return words, L.align_request(wav_bytes(5), words, "hi-en", EvenBackend())
    def test_one_entry_per_word_in_order(self):
        words, r = self.good()
        self.assertEqual([e["text"] for e in r["words"]], words)
        self.assertEqual([e["index"] for e in r["words"]], list(range(len(words))))
    def test_unalignable_is_flagged_not_dropped_or_timed(self):
        words, r = self.good()
        e = r["words"][3]; self.assertEqual((e["status"], e["start"], e["end"]), ("unaligned", None, None))
    def test_backend_failure_flags_all_deletes_none(self):
        r = L.align_request(wav_bytes(5), ["a", "b", "c"], "en", EvenBackend(fail=True))
        self.assertEqual(len(r["words"]), 3); self.assertTrue(all(e["status"] == "unaligned" and e["start"] is None for e in r["words"]))
        self.assertIn("model exploded", r["error"])
    def test_missing_spans_flagged(self):
        r = L.align_request(wav_bytes(5), ["a"] * 50, "en", EvenBackend(none_rate=0.5, seed=3))
        self.assertEqual(len(r["words"]), 50); self.assertGreater(r["summary"]["unaligned"], 5)
        self.assertTrue(all(e["start"] is None for e in r["words"] if e["status"] == "unaligned"))
    def test_low_confidence_is_flagged_but_kept(self):
        class Low(EvenBackend):
            def align(self, s, t): return [core.TokenSpan(0.1 * i, 0.1 * i + 0.05, 0.1) for i in range(len(t))]
        r = L.align_request(wav_bytes(5), ["a", "b"], "en", Low())
        self.assertTrue(all(e["status"] == "low_confidence" and e["start"] is not None for e in r["words"]))
    def test_fuzz_invariants(self):
        rnd = random.Random(7)
        pool = ["Hello,", "world.", "I'm", "57", "3.5", "1,200", "😀", "—", "well-known", "नमस्ते", "क्या", "है।", "kya", "hai", "१५", "A.I.", "$5", "...", "ok", "don't"]
        for trial in range(300):
            lang = rnd.choice(["en", "hi", "hi-en"]); n = rnd.randint(0, 60)
            words = [rnd.choice(pool) for _ in range(n)]
            be = EvenBackend(none_rate=rnd.choice([0, 0.1, 0.5]), fail=rnd.random() < 0.1, seed=trial)
            r = L.align_request(wav_bytes(rnd.choice([0.1, 1, 8, 30])), words, lang, be)
            self.assertEqual([e["text"] for e in r["words"]], words)                        # nothing lost, duplicated, reordered, rewritten
            self.assertEqual(sum(r["summary"][k] for k in ("ok", "low_confidence", "unaligned")), n)
    def test_validator_catches_every_violation(self):
        words = ["a", "b", "c"]; base = L.align_request(wav_bytes(5), words, "en", EvenBackend())["words"]
        import copy
        def mutate(f):
            o = copy.deepcopy(base); f(o); return o
        bad = [mutate(lambda o: o.pop(1)),                                      # dropped word
               mutate(lambda o: o.append(dict(o[0], index=3))),                  # duplicated word
               mutate(lambda o: o.reverse()),                                    # reordered
               mutate(lambda o: o[1].update(text="zzz")),                        # rewritten text
               mutate(lambda o: o[1].update(status="unaligned")),                # unaligned yet carries a time (fabrication)
               mutate(lambda o: o[1].update(start=None)),                        # timed word without time
               mutate(lambda o: o[1].update(start=99.0, end=99.5)),              # outside audio
               mutate(lambda o: o[2].update(start=0.0, end=0.1))]                # overlaps / goes back in time
        for i, o in enumerate(bad):
            with self.assertRaises(core.AlignmentContractError, msg=f"mutation {i} not caught"):
                core.validate_output(words, o, 5.0)

class Requests(unittest.TestCase):
    def test_rejects(self):
        be = EvenBackend()
        for args, status in (((wav_bytes(1, rate=44100), ["a"], "en"), 400), ((wav_bytes(1, channels=2), ["a"], "en"), 400),
                             ((b"not a wav", ["a"], "en"), 400), ((wav_bytes(1), ["a"], "fr"), 422), ((wav_bytes(131), ["a"], "en"), 413)):
            with self.assertRaises(L.RequestError) as c: L.align_request(*args, be)
            self.assertEqual(c.exception.status, status)

if __name__ == "__main__": unittest.main(verbosity=1)
