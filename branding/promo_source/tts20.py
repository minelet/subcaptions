import sys, numpy as np, soundfile as sf, re, json, time
sys.path.insert(0,'/tmp/promo')
from script20 import SEGS
from kokoro_onnx import Kokoro
k=Kokoro('/tmp/promo/tts/kokoro-v1.0.onnx','/tmp/promo/tts/voices-v1.0.bin')
def trim(x,sr):
    a=np.abs(x); idx=np.where(a>0.01)[0]
    return x if not len(idx) else x[max(0,idx[0]-int(0.02*sr)):min(len(x),idx[-1]+int(0.05*sr))]
res={}
for sid,spk,_ in SEGS:
    parts=[p.strip() for p in re.split(r'(?<=[.!?])\s+',spk) if p.strip()]; out=[]
    for i,p in enumerate(parts):
        for _ in range(3):
            x,sr=k.create(p,voice='am_michael',speed=1.18,lang='en-us'); x=np.asarray(x,dtype=np.float32)
            if np.isfinite(x).all() and np.abs(x).max()>0.05: break
        out.append(trim(x,sr))
        if i<len(parts)-1: out.append(np.zeros(int(0.10*sr),np.float32))
    y=np.concatenate(out); sf.write(f'/tmp/promo/tts20/{sid}.wav',y,24000); res[sid]=len(y)/24000; print(f'{sid:8s} {res[sid]:5.2f}s',flush=True)
json.dump(res,open('/tmp/promo/tts20/durations.json','w')); print('total',round(sum(res.values()),2))
