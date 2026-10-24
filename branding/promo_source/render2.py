import sys, math, subprocess
sys.path.insert(0,'/tmp/promo')
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import render as R
from render import txt, put, rrect, out_back, out_cubic, in_cubic, clamp, W, H, FPS, CARD_A, CARD_B, ICON, particles, flash
import timeline as T
from timeline import WORDS, STARTS, SCENE_END, wst
R.HITS=[(t,a) for t,a in T.HITS]
S=STARTS
BG_DARK=R.BG_DARK; BG_HOOK=R.BG_HOOK
_cc={}
def chip(text,fill=(255,255,255),fg=(12,24,50),size=46,padx=40,pady=22,outline=None):
    k=(text,fill,fg,size,padx,pady,outline)
    if k not in _cc:
        t=txt(text,font='Black',size=size,fill=fg); b=rrect(t.width+padx*2,t.height+pady*2,(t.height+pady*2)//2,fill+(255,),outline,5 if outline else 0)
        b.alpha_composite(t,(padx,pady)); _cc[k]=b
    return _cc[k]
def ps(t,t0,dur=0.2,amp=0.6):
    if t<t0: return None
    p=(t-t0)/dur; return 1.0+amp*(1-out_back(p)), clamp(p*4)
def popput(cv,im,x,y,t,t0,amp=0.6,rot=0.0,dur=0.2):
    r=ps(t,t0,dur,amp)
    if r: put(cv,im,x,y,r[0],r[1],rot=rot)
def bgrings(cv,t,cy=640):
    d=ImageDraw.Draw(cv,'RGBA')
    for i in range(9):
        r=190+i*85+8*math.sin(t*1.4+i); a=int(110-i*10)
        d.ellipse([W/2-r,cy-r,W/2+r,cy+r],outline=(120,200,255,max(a,20)),width=4)
# ---------- captions (Litix-style, narration) ----------
def chunks_for(sid):
    ws=WORDS[sid]; out=[]; cur=[]
    for i,(w,a,b) in enumerate(ws):
        cur.append((w.upper(),a,b))
        if len(cur)==3 or w[-1] in '.,!?' : out.append(cur); cur=[]
    if cur: out.append(cur)
    return out
CHUNKS={s:chunks_for(s) for s in T.ORDER}
def captions(cv,t,sid,y=1430):
    ch=CHUNKS[sid]; cur=None
    for i,c in enumerate(ch):
        if t>=c[0][1]: cur=(i,c)
    if not cur: return
    i,c=cur; end=(ch[i+1][0][1] if i+1<len(ch) else SCENE_END[sid]-0.05)
    if t>end+0.12: return
    size=78
    while size>40 and sum(R.FONT('Black',size).getlength(w) for w,_,_ in c)+size*0.3*(len(c)-1)>980: size-=4
    gap=size*0.30; ws=[R.FONT('Black',size).getlength(w) for w,_,_ in c]; x=W/2-(sum(ws)+gap*(len(c)-1))/2
    last=max(j for j,(w,a,b) in enumerate(c) if t>=a)
    for j,((w,a,b),wd) in enumerate(zip(c,ws)):
        if t<a: x+=wd+gap; continue
        act=(j==last); p=(t-a)/0.16; sc=(1.0+0.34*(1-out_back(p))) if act else 1.0
        im=txt(w,font='Black',size=size,fill=(255,214,0) if act else (255,255,255),stroke=max(7,size//10))
        put(cv,im,x+wd/2,y,sc,1.0); x+=wd+gap
# ---------- scenes ----------
def sc_hook(cv,t):
    cv.alpha_composite(BG_HOOK); particles(cv,t,(255,120,120))
    def line(text,i,cy):
        t0=wst('hook',i); r=ps(t,t0,0.18,0.7)
        if r: put(cv,txt(text,font='Black',size=140,fill=(255,255,255),stroke=8,maxw=980),W/2,cy,r[0],r[1])
    line('STOP POSTING',0,640); line('VIDEOS WITHOUT',2,840)
    t0=wst('hook',4); r=ps(t,t0,0.18,0.7)
    if r:
        im=txt('CAPTIONS',font='Black',size=150,fill=(10,10,10),maxw=900); bw,bh=im.width+90,im.height+60
        put(cv,rrect(bw,bh,36,(255,214,0,255)),W/2,1075,r[0],r[1]); put(cv,im,W/2,1075,r[0],r[1])
        q=(t-(t0+0.45))/0.22
        if q>0:
            d=ImageDraw.Draw(cv); x0=W/2-bw/2-30+R.SH[0]; y=1075+R.SH[1]
            d.line([(x0,y),(x0+int(bw*clamp(q))+60*clamp(q),y)],fill=(255,40,60,255),width=22)
def sc_scroll(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t)
    a=S['scroll']; ev=[wst('scroll',1),wst('scroll',1)+0.38,wst('scroll',1)+0.76,wst('scroll',9)]
    cards=[CARD_A,CARD_B,CARD_A,CARD_B,CARD_A]
    idx=sum(1 for e in ev if t>=e+0.3); cy=1000
    r=ps(t,a,0.2,0.4)
    put(cv,txt('NO CAPTIONS?',font='Black',size=112,fill=(255,214,0),stroke=7,maxw=960),W/2,290,(r[0] if r else 1),1)
    for k,e in enumerate(ev):
        if e<=t<e+0.3:
            p=(t-e)/0.3; put(cv,cards[k],W/2,cy-in_cubic(p)*2300,0.88); put(cv,cards[k+1],W/2,cy+(1-out_cubic(p))*2200,0.88); break
    else: put(cv,cards[idx],W/2,cy,0.88)
    t0=wst('scroll',8)
    if t0<=t<ev[3]+0.3:
        st=txt('SCROLLED PAST',font='Black',size=84,fill=(255,255,255),maxw=620); bx=rrect(st.width+70,st.height+44,22,(235,35,55,255),(255,255,255,255),6)
        q=(t-t0)/0.15; s=1.0+0.9*(1-out_back(q)); y=cy+130 - (in_cubic((t-ev[3])/0.3)*2300 if t>=ev[3] else 0)
        put(cv,bx,W/2,y,s,clamp(q*4),rot=-11); put(cv,st,W/2,y,s,clamp(q*4),rot=-11)
def browser(cv,cx,cy,sc,t,t0):
    w,h=900,780; bw=rrect(w,h,34,(244,247,252,255),(255,255,255,255),4); d=ImageDraw.Draw(bw)
    d.rounded_rectangle([0,0,w-1,96],radius=34,fill=(26,38,72,255)); d.rectangle([0,60,w-1,96],fill=(26,38,72,255))
    for i,c in enumerate([(255,95,87),(254,188,46),(40,200,64)]): d.ellipse([34+i*40,34,56+i*40,56],fill=c+(255,))
    d.rounded_rectangle([230,22,w-70,76],radius=27,fill=(44,60,104,255)); bw.alpha_composite(txt('litix.in',font='Bold',size=34,fill=(210,225,255)),(w//2-95,28))
    cc=CARD_A.resize((int(700*0.5),int(1240*0.5)),Image.LANCZOS).crop((0,0,350,610)); bw.alpha_composite(cc,(w//2-175,110))
    for i,(bwid,col) in enumerate([(170,(0,76,255)),(130,(200,208,224)),(150,(200,208,224))]):
        d.rounded_rectangle([40,150+i*70,40+bwid,190+i*70],radius=20,fill=col+(255,))
    for i in range(3): d.rounded_rectangle([w-210,150+i*70,w-40,190+i*70],radius=20,fill=(200,208,224,255))
    # live caption inside
    cap=['ADD','SUBTITLES','AUTO'][int(((t-t0)/0.5))%3] if t>=t0 else 'ADD'
    bw.alpha_composite(txt(cap,font='Black',size=46,fill=(255,214,0),stroke=6),(w//2-80,560))
    r=ps(t,t0,0.25,0.5)
    if r: put(cv,bw,cx,cy,sc*r[0],r[1])
def sc_intro(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t)
    a=wst('intro',2); b=wst('intro',12)
    mv=out_cubic((t-b)/0.35) if t>=b else 0
    iy=640-mv*330; isc=1.0-0.42*mv
    r=ps(t,a,0.3,0.9)
    if r:
        put(cv,ICON.resize((340,340),Image.LANCZOS),W/2,iy,r[0]*isc,r[1])
        parts=[('Liti',(255,255,255)),('X',(70,170,255)),(' AI',(255,255,255))]; ims=[txt(s,font='Black',size=140,fill=c) for s,c in parts]
        tw=sum(i.width for i in ims)+30; x=W/2-tw*isc/2; ty=iy+(260*isc)
        for im in ims: put(cv,im,x+im.width*isc/2,ty,r[0]*isc,r[1]); x+=(im.width+10)*isc
    browser(cv,W/2,1000,1.0,t,b)
def sc_upload(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t); a=S['upload']
    r=ps(t,a,0.25,0.5)
    dz=Image.new('RGBA',(860,520),(0,0,0,0)); d=ImageDraw.Draw(dz)
    d.rounded_rectangle([0,0,859,519],radius=48,fill=(255,255,255,255))
    for k in range(0,860,40): d.line([(k,3),(k+20,3)],fill=(0,76,255,255),width=6); d.line([(k,516),(k+20,516)],fill=(0,76,255,255),width=6)
    for k in range(0,520,40): d.line([(3,k),(3,k+20)],fill=(0,76,255,255),width=6); d.line([(856,k),(856,k+20)],fill=(0,76,255,255),width=6)
    d.ellipse([380,110,480,210],fill=(0,76,255,255)); d.polygon([(430,128),(404,160),(456,160)],fill=(255,255,255,255)); d.rectangle([420,156,440,192],fill=(255,255,255,255))
    dz.alpha_composite(txt('UPLOAD YOUR VIDEO',font='Black',size=56,fill=(12,24,50),maxw=700),(430-int(txt('UPLOAD YOUR VIDEO',font='Black',size=56,fill=(12,24,50),maxw=700).width/2),270))
    dz.alpha_composite(txt('or just audio',font='Medium',size=40,fill=(100,116,140)),(430-int(txt('or just audio',font='Medium',size=40,fill=(100,116,140)).width/2),350))
    if r: put(cv,dz,W/2,560+6*math.sin(t*5),r[0],r[1])
    cols=[((255,92,92),(255,255,255)),((255,170,0),(20,20,20)),((40,200,120),(255,255,255)),((120,90,255),(255,255,255)),((0,190,230),(10,20,40)),((255,60,160),(255,255,255))]
    names=['MP4','MOV','MP3','WAV','M4A','WEBM']; times=[wst('upload',7),wst('upload',8),wst('upload',9),wst('upload',10),wst('upload',10)+0.18,wst('upload',10)+0.36]
    pos=[(W/2-290,940),(W/2,940),(W/2+290,940),(W/2-290,1090),(W/2,1090),(W/2+290,1090)]
    for n,(f,g),tt,(x,y) in zip(names,cols,times,pos): popput(cv,chip(n,f,g,size=54),x,y,t,tt,0.8)
def waveform(cv,t,cx,cy,w,amp,n=34,col=(70,170,255)):
    d=ImageDraw.Draw(cv,'RGBA'); bw=w/n
    for i in range(n):
        h=amp*(0.25+0.75*abs(math.sin(i*0.7+t*6)*math.cos(i*0.31+t*3.3)))
        x=cx-w/2+i*bw+R.SH[0]; d.rounded_rectangle([x+3,cy-h+R.SH[1],x+bw-3,cy+h+R.SH[1]],radius=int(bw/2-2),fill=col+(255,))
def sc_lang(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t); a=S['lang']; b=wst('lang',9)
    r=ps(t,a,0.2,0.4)
    if t<b+0.1:
        put(cv,txt('SPOKEN LANGUAGE',font='Black',size=70,fill=(255,255,255),stroke=5,maxw=960),W/2,330,(r[0] if r else 1),1)
        tm=[wst('lang',5),wst('lang',6),wst('lang',8)]
        for k,(n,tt) in enumerate(zip(['ENGLISH','HINDI','HINGLISH'],tm)):
            act=(t>=tt and (k==2 or t<tm[k+1]))
            im=chip(n,(0,76,255) if act else (255,255,255),(255,255,255) if act else (12,24,50),size=68,padx=70,pady=34,outline=(0,76,255) if not act else (255,255,255))
            rr=ps(t,a+0.1+0.12*k,0.2,0.5)
            if rr: put(cv,im,W/2,640+k*210,rr[0]*(1.08 if act else 1.0),rr[1])
    else:
        q=ps(t,b,0.25,0.5)
        put(cv,txt('WORD-LEVEL TIMING',font='Black',size=70,fill=(255,255,255),stroke=5,maxw=960),W/2,330,(q[0] if q else 1),1)
        waveform(cv,t,W/2,640,820,150)
        words=[wst('lang',i) for i in (12,14,16,19)]; labels=['writes','captions','timing','every word']
        for k,(lbl,tt) in enumerate(zip(labels,words)):
            im=chip(lbl,(255,255,255),(12,24,50),size=52,padx=44,pady=24)
            popput(cv,im,W/2,880+k*125,t,tt,0.7)
            rr=ps(t,tt+0.05,0.2,0.3)
            if rr: put(cv,txt(f'00:0{k+1}.{k*2+2}0',font='Bold',size=34,fill=(110,190,255)),W/2+330,880+k*125,1.0,rr[1])
def sc_styles(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t); a=S['styles']
    tabs=['SHORTS','VIDEOS','DYNAMIC','VIRAL']; tt=[wst('styles',14),wst('styles',15),wst('styles',16),wst('styles',18)]
    ps_=ps(t,a,0.2,0.4); 
    for k,n in enumerate(tabs):
        act=(t>=tt[k] and (k==3 or t<tt[k+1])); x=W/2-390+k*260
        im=chip(n,(0,76,255) if act else (24,40,84),(255,255,255),size=30,padx=24,pady=16,outline=(90,150,255) if not act else (255,255,255))
        if ps_: put(cv,im,x,300,ps_[0]*(1.12 if act else 1.0),ps_[1])
    sc=0.80; put(cv,CARD_A,W/2,880,sc*(1.0+0.02*math.exp(-((t-a)%0.5)*10)))
    cy=1090
    def sty(name):
        if t<wst('styles',4): return None
        if t<wst('styles',5): return 'A','POP'
        if t<wst('styles',6): return 'C','GLOW'
        if t<wst('styles',7): return 'B','BOXES'
        return 'K','KEYWORD'
    s_=sty('x')
    if s_:
        k,w=s_; t0={'A':wst('styles',4),'C':wst('styles',5),'B':wst('styles',6),'K':wst('styles',8)}[k]; p=(t-t0)/0.16; sc2=1.0+0.4*(1-out_back(p))
        if k=='A': im=txt(w,font='Black',size=110,fill=(255,214,0),stroke=11)
        elif k=='C': im=txt(w,font='Black',size=110,fill=(255,255,255),stroke=0,glow=(0,200,255))
        elif k=='B':
            im=txt(w,font='Black',size=104,fill=(255,255,255)); bx=rrect(im.width+60,im.height+40,30,(255,30,140,255)); put(cv,bx,W/2,cy,sc2,1.0)
        else:
            put(cv,txt('BIG',font='Black',size=64,fill=(255,255,255),stroke=6),W/2,cy-96,sc2,1.0); im=txt('KEYWORD',font='Black',size=124,fill=(255,60,170),stroke=12,sf=(255,255,255))
        put(cv,im,W/2,cy+(30 if k=='K' else 0),sc2,1.0)
def sc_edit(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t); a=S['edit']
    pn=rrect(900,980,46,(255,255,255,255)); r=ps(t,a,0.25,0.35)
    d=ImageDraw.Draw(pn)
    # row1 text field
    d.rounded_rectangle([40,40,860,160],radius=26,fill=(238,242,250,255))
    fix=t>=wst('edit',1)
    word='GREAT' if fix else 'GRATE'; col=(34,170,90) if fix else (225,50,60)
    pn.alpha_composite(txt('LITIX IS',font='Bold',size=54,fill=(12,24,50)),(70,62)); pn.alpha_composite(txt(word,font='Black',size=54,fill=col),(70+int(txt('LITIX IS ',font='Bold',size=54,fill=(12,24,50)).width)+20,62))
    if not fix: d.line([(330,128),(500,128)],fill=(225,50,60,255),width=6)
    # row2 font
    if t>=wst('edit',5):
        pn.alpha_composite(chip('Aa  Montserrat',(0,76,255),(255,255,255),size=48,padx=46,pady=24),(40,220))
        pn.alpha_composite(chip('Aa  Impact',(238,242,250),(12,24,50),size=48,padx=46,pady=24),(40+int(chip('Aa  Montserrat',(0,76,255),(255,255,255),size=48,padx=46,pady=24).width)+24,220))
    # row3 colors
    cols=[(255,214,0),(255,60,170),(0,200,255),(40,200,120),(255,255,255),(255,92,92)]
    for i,c in enumerate(cols):
        tt=wst('edit',7)+0.07*i
        if t>=tt:
            rr=ps(t,tt,0.18,0.8); s=int(96*rr[0]); d.ellipse([40+i*142+48-s//2,470+48-s//2,40+i*142+48+s//2,470+48+s//2],fill=c+(255,),outline=(12,24,50,255) if c==(255,255,255) else None,width=4)
    # row4 toggle
    on=t<wst('edit',12)
    d.rounded_rectangle([40,650,860,790],radius=40,fill=(238,242,250,255))
    pn.alpha_composite(txt('Max 1 line' if on else 'Up to 2 lines',font='Bold',size=54,fill=(12,24,50)),(80,690))
    d.rounded_rectangle([670,675,820,765],radius=45,fill=((0,76,255,255) if on else (150,160,180,255)))
    kx=790 if on else 700; d.ellipse([kx-36,684,kx+36,756],fill=(255,255,255,255))
    if r: put(cv,pn,W/2,780,r[0],r[1])
def sc_export(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t); a=S['export']
    r=ps(t,a,0.25,0.4)
    ph=rrect(500,880,64,(18,26,52,255),(255,255,255,255),6); inner=CARD_A.resize((460,int(1240*460/700)),Image.LANCZOS).crop((0,0,460,840))
    m=Image.new('L',(460,840),0); ImageDraw.Draw(m).rounded_rectangle([0,0,459,839],radius=48,fill=255); inner.putalpha(m); ph.alpha_composite(inner,(20,20))
    ph.alpha_composite(txt('SUBTITLES',font='Black',size=54,fill=(255,214,0),stroke=7),(250-int(txt('SUBTITLES',font='Black',size=54,fill=(255,214,0),stroke=7).width/2),640))
    if r: put(cv,ph,W/2-170,690,r[0],r[1])
    b=wst('export',3); rr=ps(t,b,0.25,0.9)
    if rr: put(cv,txt('9:16',font='Black',size=150,fill=(255,255,255),stroke=9,sf=(0,76,255)),W/2+290,610,rr[0],rr[1],rot=6)
    # progress
    p=clamp((t-a)/max(0.6,(wst('export',3)-a)))
    bar=rrect(760,40,20,(40,56,100,255)); d=ImageDraw.Draw(bar); d.rounded_rectangle([0,0,int(760*p),39],radius=20,fill=(34,197,94,255))
    put(cv,bar,W/2,1290,1.0,clamp((t-a)*4))
    if p>=1.0: put(cv,txt('EXPORTED',font='Black',size=54,fill=(34,197,94)),W/2,1230+0,1.0,clamp((t-(a+0.6))*6)) if False else None
    for n,i,f,g in (('SHORTS',6,(255,60,60),(255,255,255)),('REELS',7,(255,60,170),(255,255,255)),('TIKTOK',9,(0,200,230),(10,20,40))):
        x={'SHORTS':W/2-300,'REELS':W/2,'TIKTOK':W/2+300}[n]; popput(cv,chip(n,f,g,size=40,padx=32,pady=18),x,1190,t,wst('export',i),0.8)
def sc_cutter(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t); a=S['cutter']
    r=ps(t,wst('cutter',2),0.25,0.6)
    if r: put(cv,txt('AI VIDEO CUTTER',font='Black',size=96,fill=(255,255,255),stroke=6,maxw=960),W/2,330,r[0],r[1])
    d=ImageDraw.Draw(cv,'RGBA'); x0=W/2-430+R.SH[0]; y=640+R.SH[1]
    r2=ps(t,a+0.15,0.25,0.3)
    if r2:
        d.rounded_rectangle([x0,y-60,x0+860,y+60],radius=28,fill=(36,52,98,255))
        for i in range(40): d.rectangle([x0+20+i*20,y-30+(i*7%40),x0+30+i*20,y+30-(i*11%30)],fill=(80,130,220,200))
    segs=[(120,250),(420,540),(640,770)]; best=wst('cutter',8)
    for k,(s0,s1) in enumerate(segs):
        tt=best+0.18*k
        if t>=tt:
            p=clamp((t-tt)/0.2); d.rounded_rectangle([x0+s0,y-70,x0+s1,y+70],radius=24,outline=(255,214,0,255),width=8)
            ov=Image.new('RGBA',(160,230),(0,0,0,0)); 
            put(cv,chip(f'CLIP {k+1}',(255,214,0),(12,24,50),size=40,padx=34,pady=18),W/2-290+k*290,1010,p*0+1.0,clamp(p*3))
    t0=wst('cutter',11); rr=ps(t,t0,0.15,1.0)
    if rr:
        st=txt('COMING SOON',font='Black',size=96,fill=(255,255,255),maxw=760); bx=rrect(st.width+80,st.height+50,26,(0,76,255,255),(255,255,255,255),7)
        put(cv,bx,W/2,1250,rr[0],rr[1],rot=-6); put(cv,st,W/2,1250,rr[0],rr[1],rot=-6)
def sc_cta(cv,t):
    cv.alpha_composite(BG_DARK); bgrings(cv,t,620); particles(cv,t,(160,220,255)); a=S['cta']
    r=ps(t,a,0.3,0.9); 
    if r: put(cv,ICON.resize((400,400),Image.LANCZOS),W/2,620,r[0],r[1])
    q=ps(t,a+0.25,0.25,0.5)
    if q:
        parts=[('Liti',(255,255,255)),('X',(70,170,255)),(' AI',(255,255,255))]; ims=[txt(s,font='Black',size=150,fill=c) for s,c in parts]; tw=sum(i.width for i in ims)+30; x=W/2-tw/2
        for im in ims: put(cv,im,x+im.width/2,990,q[0],q[1]); x+=im.width+10
    q=ps(t,a+0.5,0.25,0.3)
    if q: put(cv,txt('Auto subtitles for any video',font='Medium',size=56,fill=(215,232,255),maxw=940),W/2,1130,1.0,q[1])
    q=ps(t,wst('cta',8),0.3,0.5)
    if q:
        put(cv,rrect(540,140,70,(0,76,255,255),(255,255,255,255),5),W/2,1300,q[0],q[1]); put(cv,txt('litix.in',font='Black',size=82,fill=(255,255,255)),W/2,1300,q[0],q[1])
    q=ps(t,wst('cta',3),0.3,0.3)
    if q: put(cv,txt('NOW IN BETA  -  TRY IT TODAY',font='Bold',size=44,fill=(255,214,0),maxw=940),W/2,1450,1.0+0.04*math.sin(t*8),q[1])
SCENES=[('hook',sc_hook,False),('scroll',sc_scroll,True),('intro',sc_intro,True),('upload',sc_upload,True),('lang',sc_lang,True),('styles',sc_styles,True),('edit',sc_edit,True),('export',sc_export,True),('cutter',sc_cutter,True),('cta',sc_cta,False)]
FLASH=[S[s] for s in T.ORDER[1:]]
def render(t):
    R.SH=R.shake(t); cv=Image.new('RGBA',(W,H),(0,0,0,255))
    for sid,fn,cap in SCENES:
        if S[sid]<=t<SCENE_END[sid] or (sid=='cta' and t>=S[sid]):
            fn(cv,t)
            if cap: captions(cv,t,sid)
            break
    flash(cv,t,FLASH)
    if t>T.TOTAL-0.45:
        cv.alpha_composite(Image.new('RGBA',(W,H),(0,0,0,int(255*clamp((t-(T.TOTAL-0.45))/0.45)))))
    return cv.convert('RGB')
if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='test':
        ts=[float(x) for x in sys.argv[2:]]
        for tt in ts: render(tt).resize((360,640)).save(f'/tmp/promo/u_{tt}.png')
        print('ok',T.TOTAL)
    else:
        f0,f1,out=int(sys.argv[2]),int(sys.argv[3]),sys.argv[4]
        pr=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',out],stdin=subprocess.PIPE)
        for i in range(f0,f1): pr.stdin.write(render(i/FPS).tobytes())
        pr.stdin.close(); pr.wait(); print('done',out)
