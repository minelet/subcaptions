import sys; sys.path.insert(0,'/tmp/promo')
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly
from scipy.io import wavfile
import timeline20 as T
SR=48000; DUR=T.TOTAL; N=int(SR*DUR); t=np.arange(N)/SR
rng=np.random.default_rng(33); B=0.5
ML=np.zeros(N); MR=np.zeros(N)       # music + sfx bus
def add(sig,start,pan=0.0,gain=1.0):
    i=int(round(start*SR)); sig=sig[:max(0,N-i)]
    if len(sig)==0 or i<0: return
    ML[i:i+len(sig)]+=sig*gain*np.sqrt(0.5*(1-pan)); MR[i:i+len(sig)]+=sig*gain*np.sqrt(0.5*(1+pan))
def filt(x,kind,f): return sosfilt(butter(2,f,btype=kind,fs=SR,output='sos'),x)
def bp(x,lo,hi): return sosfilt(butter(2,[lo,hi],btype='band',fs=SR,output='sos'),x)
def ex(n,a,d): tt=np.arange(n)/SR; return np.minimum(tt/max(a,1e-4),1)*np.exp(-tt/d)
def kick(s,g=1.0):
    n=int(0.32*SR); tt=np.arange(n)/SR; f=45+110*np.exp(-tt*28); ph=2*np.pi*np.cumsum(f)/SR
    add(np.sin(ph)*np.exp(-tt/0.11)+filt(rng.standard_normal(n),'high',3000)*np.exp(-tt/0.006)*0.25,s,gain=g)
def hat(s,g=0.2,op=False):
    n=int((0.18 if op else 0.05)*SR); add(filt(rng.standard_normal(n),'high',7000)*ex(n,0.001,0.09 if op else 0.02),s,pan=0.25,gain=g)
def clap(s,g=0.45):
    n=int(0.22*SR); x=bp(rng.standard_normal(n),900,5500)*ex(n,0.001,0.07); add(x,s,gain=g)
def bass(s,f,d=0.22,g=0.5):
    n=int(d*SR); tt=np.arange(n)/SR; sig=np.sin(2*np.pi*f*tt)+0.35*np.sin(2*np.pi*2*f*tt)
    add(filt(sig,'low',420)*np.minimum(tt/0.004,1)*np.exp(-tt/(d*0.7)),s,gain=g)
def pluck(s,f,g=0.1,pan=0.0,d=0.2):
    n=int(0.5*SR); tt=np.arange(n)/SR; sig=np.sin(2*np.pi*f*tt)+0.5*np.sin(2*np.pi*2*f*tt+0.4)+0.25*np.sin(2*np.pi*3*f*tt)
    add(sig*ex(n,0.002,d),s,pan=pan,gain=g)
def whoosh(s,dur,f0,f1,g=0.5,up=True):
    n=int(dur*SR); x=rng.standard_normal(n); out=np.zeros(n); seg=1024
    for k in range(0,n,seg):
        fc=f0*(f1/f0)**(k/n); out[k:k+seg]=bp(x[k:k+seg],max(60,fc*0.5),min(SR/2-200,fc*1.6))[:len(out[k:k+seg])]
    tt=np.arange(n)/SR; sh=(tt/dur)**2 if up else np.sin(np.pi*tt/dur)
    add(out/np.max(np.abs(out)+1e-9)*sh,s,gain=g)
def hit(s,g=1.0,low=60):
    n=int(0.9*SR); tt=np.arange(n)/SR; f=low*0.6+low*np.exp(-tt*12); ph=2*np.pi*np.cumsum(f)/SR
    add(np.sin(ph)*np.exp(-tt/0.3)+filt(rng.standard_normal(n),'low',1500)*np.exp(-tt/0.08)*0.7,s,gain=g)
    add(filt(rng.standard_normal(int(0.3*SR)),'high',4000)*ex(int(0.3*SR),0.001,0.06)*0.3,s,gain=g*0.7)
def pop(s,f=900,g=0.28,pan=0.0):
    n=int(0.16*SR); tt=np.arange(n)/SR; ff=f*(0.5+0.5*np.exp(-tt*40)); ph=2*np.pi*np.cumsum(ff)/SR
    add(np.sin(ph)*ex(n,0.001,0.045),s,pan=pan,gain=g)
def ding(s,f=1318.5,g=0.2):
    n=int(0.9*SR); tt=np.arange(n)/SR; add((np.sin(2*np.pi*f*tt)+0.3*np.sin(2*np.pi*f*2.76*tt))*ex(n,0.001,0.25),s,gain=g)
# ---- sfx on the shared moments ----
for i,(ht,amp) in enumerate(T.HITS): hit(ht,0.55+amp/60,low=60 if amp<20 else 52)
for k,pt in enumerate(T.POPS): pop(pt,[900,1050,1250,1500][k%4],0.34,pan=(-1)**k*0.3)
for w in T.WHOOSH_IN: whoosh(w-0.28,0.28,500,6000,0.4)
# ---- groove: starts when the product intro starts ----
g0=0.0; g1=T.TOTAL-0.5; bar=B
nb=int((g1-g0)/B)
for k in range(nb):
    b=g0+k*B; kick(b,0.9); hat(b+B/2,0.18)
    if k%2==1: clap(b,0.4)
    if k%4==3: hat(b+B*0.75,0.16,True)
notesA=[55.0,55.0,82.41,55.0,65.41,65.41,98.0,65.41]
for k in range(int((g1-g0)/(B/2))): bass(g0+k*B/2,notesA[k%8],g=0.5)
arp=[220,261.63,329.63,392.0,440.0,392.0,329.63,261.63]
for k in range(int((g1-g0)/(B/4))):
    s=g0+k*B/4
    if s>=T.STARTS['listen']: pluck(s,arp[k%8]*(2 if (k//8)%2 else 1),g=0.075,pan=(-1)**k*0.4)
# ---- logo sting at the end card ----
c=T.STARTS['cta']
for j,fr in enumerate([220.0,329.63,440.0,554.37,659.25,987.77]):
    n=int(2.8*SR); tt=np.arange(n)/SR
    add((np.sin(2*np.pi*fr*tt)+0.3*np.sin(2*np.pi*fr*2.005*tt))*ex(n,0.004,1.2+0.2*j)*0.08,c+0.012*j,pan=(-1)**j*0.35)
# ---- voice bus ----
V=np.zeros(N)
for sid,_,_ in T.SEGS if hasattr(T,'SEGS') else __import__('script20').SEGS:
    x,sr=sf.read(f'/tmp/promo/tts20/{sid}.wav'); x=resample_poly(x.astype(np.float64),2,1)  # 24k -> 48k
    x=filt(x,'high',70); x=x/np.max(np.abs(x))*0.88
    i=int(round(T.STARTS[sid]*SR)); V[i:i+len(x)]+=x[:max(0,N-i)]
# ducking: music/sfx get quieter whenever the voice is speaking
env=filt(np.abs(V),'low',9); env=np.clip(env/0.12,0,1); duck=1-0.55*env
ir=rng.standard_normal(int(0.9*SR))*np.exp(-np.arange(int(0.9*SR))/SR/0.25); ir=filt(ir,'low',6000); ir/=np.sqrt(np.sum(ir**2))
ML+=0.10*fftconvolve(ML,ir)[:N]; MR+=0.10*fftconvolve(MR,ir)[:N]
pk=max(np.abs(ML).max(),np.abs(MR).max()); ML,MR=ML/pk*0.55*duck,MR/pk*0.55*duck
L=V+ML; R=V+MR
fo=np.clip((DUR-t)/0.5,0,1)*np.clip(t/0.01,0,1); L*=fo; R*=fo
st=np.tanh(np.stack([L,R],1)*1.1)/np.tanh(1.1)*0.95
wavfile.write('/tmp/promo/mix20.wav',SR,(st*32767).astype(np.int16))
print('dur',DUR,'peak',np.abs(st).max().round(3),'rms',np.sqrt((st**2).mean()).round(3))
# check duck works: rms of non-voice bus during speech vs gap
