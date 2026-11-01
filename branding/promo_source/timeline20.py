import json, re, sys
sys.path.insert(0,'/tmp/promo')
from script20 import SEGS
D=json.load(open('/tmp/promo/tts20/durations.json'))
GAP=0.10; T0=0.08
STARTS={}; t=T0
for sid,_,_ in SEGS: STARTS[sid]=t; t+=D[sid]+GAP
END_SPEECH=t-GAP; TOTAL=round(END_SPEECH+0.9,2)
ORDER=[s[0] for s in SEGS]
SCENE_END={sid:(STARTS[ORDER[i+1]] if i+1<len(ORDER) else TOTAL) for i,sid in enumerate(ORDER)}
WORDS={}
for sid,_,show in SEGS:
    ws=show.split(); wts=[]
    for w in ws:
        core=re.sub(r'[^A-Za-z0-9]','',w); x=max(2,len(core))+1.0
        if w[-1] in '.!?': x+=3.2
        elif w[-1]==',': x+=1.6
        wts.append(x)
    tot=sum(wts); cur=STARTS[sid]; lst=[]
    for w,x in zip(ws,wts):
        span=D[sid]*x/tot; lst.append((w,cur,cur+span)); cur+=span
    WORDS[sid]=lst
def wst(sid,i): return WORDS[sid][i][1]
# ---- key moments shared by video + audio ----
HITS=[(wst('hook',0),24),(wst('hook',1),20),(wst('hook',2),12),(wst('hook',7),22),(STARTS['listen'],12),(wst('listen',8),14),(STARTS['styles'],12),(STARTS['export'],12),(wst('export',6),18),(STARTS['cta'],26)]
POPS=[wst('hook',3),wst('hook',4),wst('hook',6),wst('listen',4),wst('listen',5),wst('listen',7),wst('listen',9),wst('listen',10),wst('listen',11),
      wst('styles',4),wst('styles',5),wst('styles',6),wst('styles',7),wst('export',2),wst('export',8),wst('export',9),wst('export',11),wst('cta',3),wst('cta',7)]
WHOOSH_IN=[STARTS[s] for s in ORDER[1:]]
if __name__=='__main__':
    print('TOTAL',TOTAL,'END_SPEECH',round(END_SPEECH,2))
    for s in ORDER: print(f'{s:8s} {STARTS[s]:6.2f} -> {SCENE_END[s]:6.2f}')
