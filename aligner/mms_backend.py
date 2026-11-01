"""mms_backend.py -- real acoustic alignment with torchaudio's MMS forced aligner (CTC). NOT RUN BY THE UNIT TESTS.
Needs: torch, torchaudio (>=2.1).  The model is ~1.2 GB in fp32; first call downloads it.
Everything model-specific is isolated here so the contract layer never depends on it."""
from __future__ import annotations
from typing import List, Optional, Sequence
import numpy as np
import align_core as core
from service_logic import Backend

class MMSBackend(Backend):
    name = "torchaudio-MMS_FA"
    def __init__(self, device: str = "cpu"):
        import torch, torchaudio
        self.torch = torch
        self.bundle = torchaudio.pipelines.MMS_FA
        self.model = self.bundle.get_model(with_star=False).to(device).eval()
        self.tokenizer = self.bundle.get_tokenizer()
        self.aligner = self.bundle.get_aligner()
        self.device = device
    def align(self, samples: np.ndarray, flat_tokens: Sequence[str]) -> List[Optional[core.TokenSpan]]:
        t = self.torch
        x = t.from_numpy(np.ascontiguousarray(samples))[None].to(self.device)
        x = (x - x.mean()) / (x.std() + 1e-7)
        with t.inference_mode():
            emission, _ = self.model(x)
        word_spans = self.aligner(emission[0], self.tokenizer(list(flat_tokens)))   # one list of TokenSpan per token-word
        sec_per_frame = (x.shape[1] / emission.shape[1]) / self.bundle.sample_rate
        out: List[Optional[core.TokenSpan]] = []
        for spans in word_spans:
            if not spans: out.append(None); continue
            out.append(core.TokenSpan(start=spans[0].start * sec_per_frame, end=spans[-1].end * sec_per_frame,
                                      score=float(sum(s.score for s in spans) / len(spans))))
        return out
