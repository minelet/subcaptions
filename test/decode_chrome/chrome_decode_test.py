import json, re, subprocess, threading, http.server, socketserver, functools, sys
from playwright.sync_api import sync_playwright
import os; HERE=os.path.dirname(os.path.abspath(__file__)); ROOT=HERE
H=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
class Q(H.func):
    def log_message(self,*a): pass
H=functools.partial(Q, directory=ROOT)
socketserver.TCPServer.allow_reuse_address=True
srv=socketserver.TCPServer(('127.0.0.1',0),H); PORT=srv.server_address[1]; threading.Thread(target=srv.serve_forever,daemon=True).start()
def grab(path):
    s=open(path,encoding='utf-8').read()
    a=s.index('async function extractAudioSamplesStreaming(file){'); b=s.index('async function extractAudioChunks(file){')
    return s[a:b]
OLD=grab(os.environ['LITIX_OLD_HTML']); NEW=grab(os.environ['LITIX_NEW_HTML'])
truth=json.load(open(ROOT+'/media/truth.json'))
EXPECT={'normal':lambda x:x,'normal_late':lambda x:x+12,'hole':lambda x:x if x<20 else x+10}
with sync_playwright() as p:
    br=p.chromium.launch(args=['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'])
    pg=br.new_page(); logs=[]; pg.on('console',lambda m:logs.append(m.text))
    pg.goto('http://127.0.0.1:%d/t.html' % PORT); pg.wait_for_function('window.ready===true')
    pg.evaluate("window.getSharedDecodeAudioContext=()=>new AudioContext();")
    for label,code in (('OLD (current site)',OLD),('NEW (candidate)',NEW)):
        pg.evaluate("(code)=>{window.__fn=new Function('return ('+code.replace(/^async function extractAudioSamplesStreaming/,'async function')+')')()}", code)
        print('==',label)
        for name in ('normal','normal_late','hole'):
            r=pg.evaluate("""async (name)=>{
              const blob=await (await fetch('media/'+name+'.webm')).blob();
              const out=await window.__fn(blob);
              const s=out.samples, rate=out.sampleRate, fl=Math.round(rate*0.1), n=Math.floor(s.length/fl), e=[];
              for(let f=0;f<n;f++){let q=0;for(let i=0;i<fl;i++){const v=s[f*fl+i];q+=v*v}e.push(q/fl)}
              return {dur:s.length/rate, e, info:window.__litixAudioInfo||null};}""", name)
            e=r['e']; srt=sorted(e); thr=srt[int(len(e)*0.1)]+0.3*(srt[int(len(e)*0.9)]-srt[int(len(e)*0.1)]) if False else None
            # loudness threshold in energy domain: midway between 10th and 90th percentile (log)
            import math
            db=[10*math.log10(x+1e-10) for x in e]; sd=sorted(db); q,l=sd[int(len(db)*.1)],sd[int(len(db)*.9)]; lim=q+0.3*(l-q)
            snd=[1 if d>lim else 0 for d in db]
            exp=[(EXPECT[name](a),EXPECT[name](b)) for a,b in truth if (name!='hole' or (a<19.9 or a>=20.2) and a<50) and not (name=='hole' and a<20<b)]
            tot=hit=0
            for a,b in exp:
                for f in range(int(a*10)+1,int(b*10)):
                    if f<len(snd): tot+=1; hit+=snd[f]
            # words that should be audible
            if name=='hole' and label.startswith('NEW'):
                bins={}
                for a,b in exp:
                    for f in range(int(a*10)+1,int(b*10)):
                        if f<len(snd): k=int(f/100); bins.setdefault(k*10,[0,0]); bins[k*10][0]+=1; bins[k*10][1]+=snd[f]
                print('   per 10s: ',{k:f'{100*v[1]//max(v[0],1)}%' for k,v in sorted(bins.items())})
            print(f"  {name:12s} decoded {r['dur']:.1f}s  expected-speech frames that are loud: {100*hit/max(tot,1):.0f}%  info={json.dumps(r['info']) if r['info'] else None}")
    br.close()
