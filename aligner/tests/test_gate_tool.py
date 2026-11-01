"""Self-test of the GATE LOGIC with a test-double aligner. This proves the gate can fail and pass; it is NOT evidence about real speech."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..")); sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import verify_real_audio as g
from test_contract import wav_bytes, EvenBackend

import align_core as core
class Confident(EvenBackend):
    """Even spacing with high confidence, so only TIMING decides pass/fail."""
    def align(self, samples, toks):
        d = len(samples) / 16000.0; n = len(toks)
        return [core.TokenSpan(d * i / n, d * (i + 0.9) / n, 0.9) if self.r.random() >= self.none_rate else None for i in range(n)]
def word(i): return chr(97 + i // 26) * 2 + chr(97 + i % 26)
class Gate(unittest.TestCase):
    def truth(self, shift=0.0, lang="en"):
        n = 40; return {"language": lang, "transcript": " ".join(word(i) for i in range(n)),
                        "marks": [{"index": i, "start": 20.0 * i / n + shift} for i in range(n)]}
    def test_passes_when_marks_agree(self):
        v = g.summarize([g.evaluate_clip(wav_bytes(20), self.truth(), Confident()) for _ in range(3)])
        self.assertTrue(v["en"]["passed"], v)
    def test_fails_when_times_are_off(self):
        v = g.summarize([g.evaluate_clip(wav_bytes(20), self.truth(shift=1.5), Confident()) for _ in range(3)])
        self.assertFalse(v["en"]["passed"]); self.assertTrue(any("within" in r for r in v["en"]["reasons"]))
    def test_fails_with_too_little_evidence(self):
        v = g.summarize([g.evaluate_clip(wav_bytes(20), self.truth(), Confident())])
        self.assertFalse(v["en"]["passed"]); self.assertTrue(any("clips" in r for r in v["en"]["reasons"]))
    def test_flagged_marks_count_as_failures(self):
        v = g.summarize([g.evaluate_clip(wav_bytes(20), self.truth(), Confident(none_rate=0.6, seed=s)) for s in range(3)])
        self.assertFalse(v["en"]["passed"])
    def test_wer(self):
        wer, mp = g.edit_map("a b c d".split(), "a x c d e".split())
        self.assertAlmostEqual(wer, 0.5); self.assertEqual(mp, {0: 0, 2: 2, 3: 3})

if __name__ == "__main__": unittest.main()
