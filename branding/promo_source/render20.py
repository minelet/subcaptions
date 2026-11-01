import sys, math, subprocess
sys.path.insert(0,'/tmp/promo')
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import render as R
import render2 as R2                       # reuse chip/ps/popput/waveform helpers
from render import txt, put, rrect, out_back, out_cubic, in_cubic, clamp, W, H, FPS, CARD_A, ICON, particles, flash
import timeline20 as T
from timeline20 import WORDS, STARTS, SCENE_END, wst
from render2 import chip, ps, popput, waveform
R.HITS=[(t,a) for t,a in T.HITS]; S=STARTS
# ---------- blurred real-website backgrounds ----------
def blurred(path,x0,tint=(0,24,80)):
    im=Image.open(path).convert('RGB'); sc=2300/im.height; im=im.resize((int(im.width*sc),2300),Image.LANCZOS)
    x0=min(x0,im.width-1300); im=im.crop((x0,0,x0+1300,2300)).filter(ImageFilter.GaussianBlur(26))
    a=np.asarray(im).astype(np.float32)*0.50+np.array(tint,np.float32)*0.50
    yy,xx=np.mgrid[0:2300,0:1300]; r=np.sqrt(((xx-650)/650)**2+((yy-1150)/1150)**2); a*=(1-0.30*np.clip(r-0.5,0,1))[...,None]
    return Image.fromarray(np.clip(a,0,255).astype(np.uint8)).convert('RGBA')
BG={'hook':blurred('/tmp/promo/shot_editor.png',1500,(40,6,20)),'listen':blurred('/tmp/promo/shot_drop.png',0),
    'styles':blurred('/tmp/promo/shot_tabs.png',0),'export':blurred('/tmp/promo/shot_editor.png',1600),'cta':blurred('/tmp/promo/shot_editor.png',1200)}
def bg(cv,t,key):
    ox=int(110+100*math.sin(t*0.7)); oy=int(190+80*math.cos(t*0.55)); cv.alpha_composite(BG[key].crop((ox,oy,ox+W,oy+H)))
# ---------- real UI crops ----------
def roundmask(im,r):
    m=Image.new('L',im.size,0); ImageDraw.Draw(m).rounded_rectangle([0,0,im.width-1,im.height-1],radius=r,fill=255); im=im.convert('RGBA'); im.putalpha(m); return im
def window(im,pad=10,r=34):
    im=roundmask(im,r); w=Image.new('RGBA',(im.width+pad*2,im.height+pad*2),(0,0,0,0)); d=ImageDraw.Draw(w)
    sh=Image.new('RGBA',w.size,(0,0,0,0)); ImageDraw.Draw(sh).rounded_rectangle([pad,pad+14,w.width-pad,w.height-pad+14],radius=r,fill=(0,0,0,150)); sh=sh.filter(ImageFilter.GaussianBlur(18)); w.alpha_composite(sh)
    d.rounded_rectangle([0,0,w.width-1,w.height-1],radius=r+pad//2,fill=(255,255,255,255)); w.alpha_composite(im,(pad,pad)); return w
PANEL_RAW=Image.open('/tmp/promo/shot_tabs.png').crop((124,104,884,1160))
DROP_RAW=Image.open('/tmp/promo/shot_drop.png').crop((1642,144,2442,624))
PANEL=window(PANEL_RAW.resize((int(760*1.04),int(1056*1.04)),Image.LANCZOS))
DROP=window(DROP_RAW.resize((int(800*1.08),int(480*1.08)),Image.LANCZOS))
# ---------- extras ----------
def star(d,cx,cy,r,col):
    pts=[]; 
    for i in range(8):
        a=i*math.pi/4; rr=r if i%2==0 else r*0.28; pts.append((cx+rr*math.cos(a),cy+rr*math.sin(a)))
    d.polygon(pts,fill=col)
def burst(cv,t,t0,cx,cy,n=9,dist=240,col=(255,224,80)):
    p=(t-t0)/0.55
    if not 0<=p<1: return
    d=ImageDraw.Draw(cv,'RGBA'); e=out_cubic(p)
    for i in range(n):
        a=i*2*math.pi/n+0.4; r=dist*e*(0.7+0.3*((i*37)%5)/4); star(d,cx+r*math.cos(a)+R.SH[0],cy+r*math.sin(a)+R.SH[1],26*(1-p)+4,col+(int(255*(1-p)),))
def topbar(cv,t):
    d=ImageDraw.Draw(cv,'RGBA'); d.rounded_rectangle([40,26,W-40,36],radius=5,fill=(255,255,255,70)); d.rounded_rectangle([40,26,40+int((W-80)*clamp(t/T.TOTAL)),36],radius=5,fill=(255,214,0,255))
def ring(cv,cx,cy,r,prog,col=(255,214,0)):
    d=ImageDraw.Draw(cv,'RGBA'); x,y=cx+R.SH[0],cy+R.SH[1]
    d.ellipse([x-r,y-r,x+r,y+r],fill=(10,20,50,235)); d.arc([x-r+6,y-r+6,x+r-6,y+r-6],-90,-90+360*clamp(prog),fill=col+(255,),width=12)
    d.polygon([(x+6,y-34),(x-18,y+6),(x-1,y+6),(x-8,y+34),(x+20,y-8),(x+3,y-8)],fill=col+(255,))   # lightning bolt
# ---------- captions (Litix style, narration) ----------
def chunks_for(sid):
    ws=WORDS[sid]; out=[]; cur=[]
    for w,a,b in ws:
        cur.append((w.upper(),a,b))
        if len(cur)==3 or w[-1] in '.,!?': out.append(cur); cur=[]
    if cur: out.append(cur)
    return out
CHUNKS={s:chunks_for(s) for s in T.ORDER}
def captions(cv,t,sid,y=1460):
    ch=CHUNKS[sid]; cur=None
    for i,c in enumerate(ch):
        if t>=c[0][1]: cur=(i,c)
    if not cur: return
    i,c=cur; end=(ch[i+1][0][1] if i+1<len(ch) else SCENE_END[sid]-0.05)
    if t>end+0.1: return
    size=80
    while size>40 and sum(R.FONT('Black',size).getlength(w) for w,_,_ in c)+size*0.3*(len(c)-1)>980: size-=4
    gap=size*0.30; ws=[R.FONT('Black',size).getlength(w) for w,_,_ in c]; x=W/2-(sum(ws)+gap*(len(c)-1))/2
    last=max(j for j,(w,a,b) in enumerate(c) if t>=a)
    for j,((w,a,b),wd) in enumerate(zip(c,ws)):
        if t<a: x+=wd+gap; continue
        act=(j==last); p=(t-a)/0.14; sc=(1.0+0.34*(1-out_back(p))) if act else 1.0
        put(cv,txt(w,font='Black',size=size,fill=(255,214,0) if act else (255,255,255),stroke=max(7,size//10)),x+wd/2,y,sc,1.0); x+=wd+gap
# ---------- scenes ----------
def sc_hook(cv,t):
    bg(cv,t,'hook'); a=wst('hook',0); b=wst('hook',2)
    if t<0.25:
        ov=Image.new('RGBA',(W,H),(255,30,50,int(150*(1-t/0.25)))); cv.alpha_composite(ov)
    if t<b:      # phase A: giant pattern-interrupt
        r=ps(t,a,0.16,0.9)
        if r: put(cv,txt('STOP',font='Black',size=330,fill=(255,255,255),stroke=14,sf=(235,35,55),maxw=980),W/2,640,r[0],r[1])
        r=ps(t,wst('hook',1),0.16,0.9)
        if r:
            im=txt('SCROLLING',font='Black',size=170,fill=(12,12,12),maxw=900); bx=rrect(im.width+80,im.height+56,34,(255,214,0,255))
            put(cv,bx,W/2,960,r[0],r[1],rot=-3); put(cv,im,W/2,960,r[0],r[1],rot=-3)
        burst(cv,t,a,W/2,640,10,380,(255,255,255)); burst(cv,t,wst('hook',1),W/2,960,10,380)
    else:        # phase B: show the product doing the thing
        q=clamp((t-b)/0.3); e=out_cubic(q)
        put(cv,txt('STOP SCROLLING',font='Black',size=96,fill=(255,214,0),stroke=8,maxw=960),W/2,250,1.0+0.5*(1-e)*0,1.0)
        sc=0.84*(1.0+0.5*(1-out_back((t-b)/0.25))); put(cv,CARD_A,W/2,900,sc,clamp((t-b)*6))
        R.caption_draw(cv,t,W/2,1000+60,[["ADD","SUBTITLES"],["TO ANY","VIDEO"]],'A',[wst('hook',2),wst('hook',3),wst('hook',4),wst('hook',6)])
        t7=wst('hook',7); r=ps(t,t7,0.2,0.7)
        if r:
            put(cv,chip('IN SECONDS',(0,76,255),(255,255,255),size=64,padx=56,pady=28,outline=(255,255,255)),W/2,1390,r[0],r[1])
            ring(cv,W/2+410,610,78,(t-t7)/max(0.4,WORDS['hook'][8][2]-t7))
            burst(cv,t,t7,W/2+410,610,8,220)
def sc_listen(cv,t):
    bg(cv,t,'listen'); a=S['listen']; w8=wst('listen',8); f=1-clamp((t-w8)/0.18)
    r=ps(t,a,0.25,0.35)
    if r and f>0:
        put(cv,DROP,W/2,520,r[0],r[1]*f)
        put(cv,txt('UPLOAD YOUR VIDEO',font='Black',size=58,fill=(255,255,255),stroke=6,maxw=900),W/2,215,1.0,r[1]*f)
        tm=[wst('listen',4),wst('listen',5),wst('listen',7)]; xs=[W/2-330,W/2,W/2+330]
        for k,n in enumerate(['ENGLISH','HINDI','HINGLISH']):
            act=(t>=tm[k] and (k==2 or t<tm[k+1]))
            im=chip(n,(0,76,255) if act else (255,255,255),(255,255,255) if act else (12,24,50),size=40,padx=34,pady=22,outline=(0,76,255) if not act else (255,255,255))
            rr=ps(t,tm[k],0.2,0.7)
            if rr: put(cv,im,xs[k],960,rr[0]*(1.1 if act else 1.0),rr[1]*f)
    if t>=w8:
        q=ps(t,w8,0.25,0.4); put(cv,txt('EVERY WORD, AUTOMATIC',font='Black',size=66,fill=(255,255,255),stroke=6,maxw=960),W/2,300,(q[0] if q else 1),1)
        waveform(cv,t,W/2,660,820,150)
        for k,(lbl,i) in enumerate([('writes',9),('every',10),('word',11)]):
            tt=wst('listen',i); popput(cv,chip(lbl,(255,255,255),(12,24,50),size=54,padx=50,pady=24),W/2-90,940+k*135,t,tt,0.7)
            rr=ps(t,tt+0.05,0.2,0.3)
            if rr: put(cv,txt(f'00:0{k+1}.{k*2+2}0',font='Bold',size=36,fill=(150,210,255)),W/2+250,940+k*135,1.0,rr[1])
            burst(cv,t,tt,W/2-90,940+k*135,6,160)
def sc_styles(cv,t):
    bg(cv,t,'styles'); a=S['styles']; r=ps(t,a,0.25,0.35)
    if r: put(cv,PANEL,W/2,850,r[0],r[1])
    ox=W/2-PANEL.width/2+10; oy=850-PANEL.height/2+10; k=1.04
    cards={4:(24,90,370,310),5:(24,330,370,550),6:(390,90,736,310)}
    d=ImageDraw.Draw(cv,'RGBA'); cur=None
    for i in (4,5,6):
        if t>=wst('styles',i): cur=i
    if cur:
        x0,y0,x1,y1=cards[cur]; p=(t-wst('styles',cur))/0.18; pad=int(14*(1-out_back(p))+4)
        d.rounded_rectangle([ox+x0*k-pad+R.SH[0],oy+y0*k-pad+R.SH[1],ox+x1*k+pad+R.SH[0],oy+y1*k+pad+R.SH[1]],radius=30,outline=(255,40,150,255),width=9)
        burst(cv,t,wst('styles',cur),ox+(x0+x1)/2*k,oy+(y0+y1)/2*k,8,200,(255,80,170))
    t7=wst('styles',7); rr=ps(t,t7,0.2,0.9)
    if rr:
        st=txt('BIG KEYWORDS',font='Black',size=92,fill=(255,255,255),stroke=0,maxw=860); bx=rrect(st.width+80,st.height+50,28,(255,30,140,255),(255,255,255,255),7)
        put(cv,bx,W/2,150,rr[0],rr[1],rot=-4); put(cv,st,W/2,150,rr[0],rr[1],rot=-4)
def sc_export(cv,t):
    bg(cv,t,'export'); a=S['export']
    # fix-a-word row
    fixt=wst('export',2); r=ps(t,a,0.2,0.4); fix=t>=fixt
    if r:
        put(cv,chip('GRATE' if not fix else 'GREAT',(255,255,255),(225,50,60) if not fix else (34,170,90),size=62,padx=60,pady=28,outline=(225,50,60) if not fix else (34,170,90)),W/2,185,r[0]*(1.12 if (fix and t<fixt+0.2) else 1.0),r[1])
        if fix: burst(cv,t,fixt,W/2,185,8,200,(120,255,170))
    ph=rrect(500,880,64,(18,26,52,255),(255,255,255,255),6); inner=CARD_A.resize((460,int(1240*460/700)),Image.LANCZOS).crop((0,0,460,840))
    m=Image.new('L',(460,840),0); ImageDraw.Draw(m).rounded_rectangle([0,0,459,839],radius=48,fill=255); inner.putalpha(m); ph.alpha_composite(inner,(20,20))
    wd='SUBTITLES' if t<fixt else 'SUBTITLES'; ph.alpha_composite(txt(wd,font='Black',size=54,fill=(255,214,0),stroke=7),(250-int(txt(wd,font='Black',size=54,fill=(255,214,0),stroke=7).width/2),640))
    r2=ps(t,a+0.1,0.25,0.4)
    if r2: put(cv,ph,W/2-170,700,r2[0],r2[1])
    b=wst('export',6); rr=ps(t,b,0.25,0.9)
    if rr:
        put(cv,txt('9:16',font='Black',size=170,fill=(255,255,255),stroke=10,sf=(0,76,255)),W/2+290,600,rr[0],rr[1],rot=6); burst(cv,t,b,W/2+290,600,10,300)
    p=clamp((t-wst('export',4))/max(0.5,wst('export',7)-wst('export',4)))
    bar=rrect(760,40,20,(40,56,100,255)); dd=ImageDraw.Draw(bar); dd.rounded_rectangle([0,0,max(2,int(760*p)),39],radius=20,fill=(34,197,94,255))
    put(cv,bar,W/2,1290,1.0,clamp((t-wst('export',3))*5))
    for n,i,f,g in (('SHORTS',8,(255,60,60),(255,255,255)),('REELS',9,(255,60,170),(255,255,255)),('TIKTOK',11,(0,200,230),(10,20,40))):
        x={'SHORTS':W/2-300,'REELS':W/2,'TIKTOK':W/2+300}[n]; popput(cv,chip(n,f,g,size=40,padx=32,pady=18),x,1190,t,wst('export',i),0.8); burst(cv,t,wst('export',i),x,1190,6,150)
def sc_cta(cv,t):
    bg(cv,t,'cta'); R2.bgrings(cv,t,640); particles(cv,t,(160,220,255)); a=S['cta']
    r=ps(t,a,0.3,0.9)
    if r: put(cv,ICON.resize((420,420),Image.LANCZOS),W/2,640,r[0],r[1]); burst(cv,t,a,W/2,640,12,420)
    q=ps(t,a+0.2,0.25,0.5)
    if q:
        parts=[('Liti',(255,255,255)),('X',(70,170,255)),(' AI',(255,255,255))]; ims=[txt(s,font='Black',size=160,fill=c) for s,c in parts]; tw=sum(i.width for i in ims)+30; x=W/2-tw/2
        for im in ims: put(cv,im,x+im.width/2,1010,q[0],q[1]); x+=im.width+10
    q=ps(t,a+0.4,0.25,0.3)
    if q: put(cv,txt('Auto subtitles for any video',font='Medium',size=58,fill=(225,238,255),maxw=940),W/2,1150,1.0,q[1])
    q=ps(t,wst('cta',7),0.3,0.5)
    if q:
        put(cv,rrect(560,150,75,(0,76,255,255),(255,255,255,255),6),W/2,1320,q[0],q[1]); put(cv,txt('litix.in',font='Black',size=88,fill=(255,255,255)),W/2,1320,q[0],q[1]); burst(cv,t,wst('cta',7),W/2,1320,10,300)
    q=ps(t,wst('cta',3),0.3,0.3)
    if q: put(cv,txt('NOW IN BETA  -  TRY IT TODAY',font='Bold',size=46,fill=(255,214,0),maxw=940),W/2,1470,1.0+0.04*math.sin(t*8),q[1])
SCENES=[('hook',sc_hook,False),('listen',sc_listen,True),('styles',sc_styles,True),('export',sc_export,True),('cta',sc_cta,False)]
FLASH=[S[s] for s in T.ORDER[1:]]
def render(t):
    R.SH=R.shake(t); cv=Image.new('RGBA',(W,H),(0,0,0,255)); cur=None
    for sid,fn,cap in SCENES:
        if S[sid]<=t<SCENE_END[sid] or (sid=='cta' and t>=S[sid]):
            fn(cv,t); cur=sid
            if cap: captions(cv,t,sid)
            break
    topbar(cv,t); flash(cv,t,FLASH)
    img=cv.convert('RGB')
    # punch-in zoom at every scene start
    for st in S.values():
        if 0<=t-st<0.22 and st>0.2:
            z=1.0+0.07*(1-out_cubic((t-st)/0.22)); cw,ch=int(W/z),int(H/z); x0,y0=(W-cw)//2,(H-ch)//2
            img=img.crop((x0,y0,x0+cw,y0+ch)).resize((W,H),Image.BICUBIC)
    if t>T.TOTAL-0.4:
        a=clamp((t-(T.TOTAL-0.4))/0.4); img=Image.blend(img,Image.new('RGB',(W,H),(0,0,0)),a)
    return img
if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='test':
        ts=[float(x) for x in sys.argv[2:]]
        ims=[render(t).resize((360,640)) for t in ts]
        s=Image.new('RGB',(360*len(ims),640)); [s.paste(im,(i*360,0)) for i,im in enumerate(ims)]; s.save('/tmp/promo/sheet20.png'); print('ok')
    else:
        f0,f1,out=int(sys.argv[2]),int(sys.argv[3]),sys.argv[4]
        pr=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',out],stdin=subprocess.PIPE)
        for i in range(f0,f1): pr.stdin.write(render(i/FPS).tobytes())
        pr.stdin.close(); pr.wait(); print('done',out)
