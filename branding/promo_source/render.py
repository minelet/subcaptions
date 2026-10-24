import numpy as np, math, subprocess, sys, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
W,H,FPS,DUR=1080,1920,30,16.0
NF=int(DUR*FPS)
_fc={}
def FONT(n,s):
    k=(n,s)
    if k not in _fc: _fc[k]=ImageFont.truetype(f'/tmp/promo/Poppins-{n}.ttf',s)
    return _fc[k]
clamp=lambda x,a=0.0,b=1.0:max(a,min(b,x))
def out_cubic(x): x=clamp(x); return 1-(1-x)**3
def in_cubic(x): x=clamp(x); return x**3
def out_back(x,s=1.9):
    x=clamp(x); return 1+(s+1)*(x-1)**3+s*(x-1)**2
# ---------- shake ----------
HITS=[(0.0,16),(0.5,16),(1.0,20),(1.5,30),(2.5,22),(4.0,26),(10.0,12),(11.0,12),(12.0,12),(13.0,18)]
def shake(t):
    dx=dy=0.0
    for h,a in HITS:
        if t>=h:
            e=math.exp(-(t-h)*13)*a; dx+=e*math.sin((t-h)*70); dy+=e*math.cos((t-h)*83)
    return dx,dy
SH=(0,0)
# ---------- cached text ----------
_tc={}
def txt(text,font='Black',size=100,fill=(255,255,255),stroke=0,sf=(0,0,0),maxw=None,glow=None):
    if maxw:
        while size>20 and FONT(font,size).getlength(text)+stroke*2>maxw: size-=4
    k=(text,font,size,fill,stroke,sf,glow)
    if k in _tc: return _tc[k]
    f=FONT(font,size); pad=stroke+(40 if glow else 6)
    w=int(f.getlength(text))+pad*2; h=int(size*1.55)+pad*2
    im=Image.new('RGBA',(w,h),(0,0,0,0)); d=ImageDraw.Draw(im)
    if glow:
        g=Image.new('RGBA',(w,h),(0,0,0,0)); gd=ImageDraw.Draw(g)
        gd.text((pad,pad),text,font=f,fill=glow+(255,),stroke_width=max(stroke,4),stroke_fill=glow+(255,))
        g=g.filter(ImageFilter.GaussianBlur(16)); im=Image.alpha_composite(im,g); im=Image.alpha_composite(im,g); d=ImageDraw.Draw(im)
    d.text((pad,pad),text,font=f,fill=fill+(255,),stroke_width=stroke,stroke_fill=sf+(255,))
    bb=im.getbbox(); im=im.crop(bb) if bb else im
    _tc[k]=im; return im
def put(cv,im,cx,cy,scale=1.0,alpha=1.0,rot=0.0,shake=True):
    if alpha<=0.01: return
    if scale!=1.0: im=im.resize((max(1,int(im.width*scale)),max(1,int(im.height*scale))),Image.BICUBIC)
    if rot: im=im.rotate(rot,expand=True,resample=Image.BICUBIC)
    if alpha<1.0:
        a=im.getchannel('A').point(lambda v:int(v*alpha)); im=im.copy(); im.putalpha(a)
    ox,oy=(SH if shake else (0,0))
    cv.alpha_composite(im,(int(cx-im.width/2+ox),int(cy-im.height/2+oy))) if (0<=cx-im.width/2+ox<W and 0<=cy-im.height/2+oy<H and cx+im.width/2+ox<=W and cy+im.height/2+oy<=H) else _put_clip(cv,im,int(cx-im.width/2+ox),int(cy-im.height/2+oy))
def _put_clip(cv,im,x,y):
    x0,y0=max(0,x),max(0,y); x1,y1=min(W,x+im.width),min(H,y+im.height)
    if x1<=x0 or y1<=y0: return
    cv.alpha_composite(im.crop((x0-x,y0-y,x1-x,y1-y)),(x0,y0))
def rrect(w,h,r,fill,outline=None,ow=0):
    im=Image.new('RGBA',(w,h),(0,0,0,0)); d=ImageDraw.Draw(im)
    d.rounded_rectangle([0,0,w-1,h-1],radius=r,fill=fill,outline=outline,width=ow); return im
# ---------- backgrounds ----------
def make_bg(c0,c1,glowc):
    yy,xx=np.mgrid[0:H,0:W].astype(np.float32); v=yy/H
    a=np.zeros((H,W,3),np.float32)
    for i in range(3): a[...,i]=c0[i]*(1-v)+c1[i]*v
    gd=np.exp(-(((xx-W/2)/520)**2+((yy-H*0.5)/760)**2))
    for i in range(3): a[...,i]+=gd*glowc[i]
    return Image.fromarray(np.clip(a,0,255).astype(np.uint8)).convert('RGBA')
BG_DARK=make_bg((6,10,26),(10,22,58),(10,40,110))
BG_HOOK=make_bg((8,6,14),(30,8,20),(70,15,25))
rng=random.Random(5); PARTS=[(rng.random()*W,rng.random()*H,rng.uniform(0.3,1.0),rng.uniform(3,9)) for _ in range(46)]
def particles(cv,t,col=(120,190,255)):
    d=ImageDraw.Draw(cv,'RGBA')
    for x,y,s,r in PARTS:
        yy=(y-t*60*s)%H; xx=x+math.sin(t*s*1.7+y)*18
        d.ellipse([xx-r,yy-r,xx+r,yy+r],fill=col+(int(40+80*s),))
def blur_bg():
    s=Image.open('/tmp/logo/fr_6.6.png').convert('RGB'); cw=int(s.height*9/16); x0=(s.width-cw)//2
    im=s.crop((x0,0,x0+cw,s.height)).resize((W,H),Image.LANCZOS).filter(ImageFilter.GaussianBlur(22))
    a=np.asarray(im).astype(np.float32)*0.75; return Image.fromarray(np.clip(a,0,255).astype(np.uint8)).convert('RGBA')
BG_CTA=blur_bg()
# ---------- fake video cards ----------
def make_card(top,mid,bot,sun,mount,w=700,h=1240):
    yy=np.linspace(0,1,h)[:,None]; a=np.zeros((h,w,3),np.float32)
    for i in range(3):
        a[...,i]=np.where(yy<0.55,top[i]+(mid[i]-top[i])*(yy/0.55),mid[i]+(bot[i]-mid[i])*((yy-0.55)/0.45))
    im=Image.fromarray(np.clip(a,0,255).astype(np.uint8)).convert('RGBA'); d=ImageDraw.Draw(im)
    d.ellipse([w*0.52,h*0.20,w*0.52+260,h*0.20+260],fill=sun)
    d.polygon([(0,h*0.62),(w*0.28,h*0.40),(w*0.5,h*0.58),(w*0.74,h*0.34),(w,h*0.60),(w,h),(0,h)],fill=mount)
    d.polygon([(0,h*0.74),(w*0.35,h*0.55),(w*0.62,h*0.72),(w,h*0.58),(w,h),(0,h)],fill=tuple(int(c*0.7) for c in mount))
    d.rounded_rectangle([40,h-70,w-40,h-62],radius=4,fill=(255,255,255,70)); d.rounded_rectangle([40,h-70,40+int((w-80)*0.38),h-62],radius=4,fill=(255,255,255,220))
    m=Image.new('L',(w,h),0); ImageDraw.Draw(m).rounded_rectangle([0,0,w-1,h-1],radius=64,fill=255); im.putalpha(m)
    ring=Image.new('RGBA',(w,h),(0,0,0,0)); ImageDraw.Draw(ring).rounded_rectangle([0,0,w-1,h-1],radius=64,outline=(255,255,255,70),width=5)
    return Image.alpha_composite(im,ring)
CARD_A=make_card((255,138,92),(196,78,138),(52,38,122),(255,225,150,255),(56,40,112,255))
CARD_B=make_card((60,200,230),(30,110,210),(14,30,90),(220,250,255,255),(10,40,100,255))
ICON=Image.open('/tmp/promo/icon.png').convert('RGBA')
def flash(cv,t,times):
    for ct in times:
        if 0<=t-ct<0.14:
            a=0.85*math.exp(-(t-ct)*26); ov=Image.new('RGBA',(W,H),(255,255,255,int(255*a))); cv.alpha_composite(ov)
# ---------- scenes ----------
def scene_hook(cv,t):
    cv.alpha_composite(BG_HOOK); particles(cv,t,(255,120,120))
    def pop(text,t0,cy,**k):
        p=(t-t0)/0.18
        if p<0: return None
        im=txt(text,**k); sc=1.0+0.7*(1-out_back(p)); put(cv,im,W/2,cy,sc,clamp(p*4)); return im
    pop('STOP POSTING',0.0,640,font='Black',size=140,fill=(255,255,255),stroke=8,maxw=980)
    pop('VIDEOS WITHOUT',0.5,840,font='Black',size=140,fill=(255,255,255),stroke=8,maxw=980)
    p=(t-1.0)/0.18
    if p>=0:
        im=txt('CAPTIONS',font='Black',size=150,fill=(10,10,10),maxw=900); bw,bh=im.width+90,im.height+60
        box=rrect(bw,bh,36,(255,214,0,255)); sc=1.0+0.7*(1-out_back(p)); put(cv,box,W/2,1075,sc,clamp(p*4)); put(cv,im,W/2,1075,sc,clamp(p*4))
        q=(t-1.5)/0.22
        if q>0:
            L=int(bw*clamp(q)); d=ImageDraw.Draw(cv); x0=W/2-bw/2-30+SH[0]; y=1075+SH[1]
            d.line([(x0,y),(x0+L+60*clamp(q),y)],fill=(255,40,60,255),width=22)
def scene_scroll(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t)
    p=(t-2.0)/0.2
    if p>=0: put(cv,txt('NO CAPTIONS?',font='Black',size=118,fill=(255,214,0),stroke=7,maxw=960) if t<3.5 else txt('FIX IT. FAST.',font='Black',size=118,fill=(255,255,255),stroke=7,maxw=960),W/2,300,1.0+0.5*(1-out_back(p if t<3.5 else (t-3.5)/0.2)),1)
    # card 1
    c1y=1010
    if t>=3.0: c1y-=in_cubic((t-3.0)/0.28)*2300
    if c1y>-700:
        sc=1.0+0.8*(1-out_cubic((t-2.0)/0.2)) if t<2.2 else 1.0
        put(cv,CARD_A,W/2,c1y,sc*0.92,1.0)
        q=(t-2.5)/0.15
        if q>0 and t<3.0+0.25:
            st=txt('SCROLLED PAST',font='Black',size=84,fill=(255,255,255),maxw=620); bx=rrect(st.width+70,st.height+44,22,(235,35,55,255),(255,255,255,255),6)
            s=1.0+0.9*(1-out_back(q)); put(cv,bx,W/2,c1y+120,s,clamp(q*4),rot=-11); put(cv,st,W/2,c1y+120,s,clamp(q*4),rot=-11)
    # card 2 rises, then flicks
    if 3.0<=t<3.8:
        if t<3.35: c2y=1010+ (1-out_cubic((t-3.0)/0.35))*2200
        else: c2y=1010-in_cubic((t-3.5)/0.28)*2300 if t>=3.5 else 1010
        put(cv,CARD_B,W/2,c2y,0.92,1.0)
def caption_draw(cv,t,cx,cy,lines,style,t0s):
    # lines: list of lists of tokens; t0s: reveal time per token (flat order)
    flat=[tok for ln in lines for tok in ln]
    size=100
    while size>40:
        f=FONT('Black',size); ws=[sum(f.getlength(tk)+size*0.30 for tk in ln)-size*0.30 for ln in lines]
        if max(ws)<=640: break
        size-=4
    lh=size*1.38; y=cy-lh*(len(lines)-1)/2; idx=0
    last=max(i for i,tt in enumerate(t0s) if t>=tt) if any(t>=tt for tt in t0s) else -1
    for ln in lines:
        wsl=[FONT('Black',size).getlength(tk) for tk in ln]; gap=size*0.30; tot=sum(wsl)+gap*(len(ln)-1); x=cx-tot/2
        for tk,w in zip(ln,wsl):
            i=idx; idx+=1
            if t<t0s[i]: x+=w+gap; continue
            active=(i==last); p=(t-t0s[i])/0.16; sc=(1.0+0.38*(1-out_back(p))) if active else 1.0
            if style=='A':
                im=txt(tk,font='Black',size=size,fill=(255,214,0) if active else (255,255,255),stroke=max(6,size//11))
            elif style=='B':
                im=txt(tk,font='Black',size=size,fill=(255,255,255),stroke=max(5,size//14))
                if active:
                    bx=rrect(im.width+44,im.height+30,26,(255,30,140,255)); put(cv,bx,x+w/2,y,sc,1.0)
                    im=txt(tk,font='Black',size=size,fill=(255,255,255),stroke=0)
            else:
                im=txt(tk,font='Black',size=size,fill=(255,255,255) if active else (190,235,255),stroke=0,glow=(0,200,255) if active else (0,140,220))
            put(cv,im,x+w/2,y,sc,1.0); x+=w+gap
        y+=lh
SENT=[ # (lines, style, t0s, shown_from, shown_until)
 ([["ADD","SUBTITLES"],["TO ANY","VIDEO"]],'A',[4.0,4.5,5.0,5.5],4.0,6.0),
 ([["IN","JUST"],["SECONDS"]],'B',[6.0,6.5,7.0],6.0,8.0),
 ([["ANIMATED","STYLES"]],'C',[8.0,8.5],8.0,10.0)]
def scene_demo(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t)
    b=(t-4.0)%0.5; pulse=1.0+0.022*math.exp(-b*11)
    # card in with a pop
    p=(t-4.0)/0.22; csc=0.94*(1.0+0.35*(1-out_back(p))) if p<1 else 0.94
    put(cv,CARD_A,W/2,1010,csc*pulse,1.0)
    # top pill
    pill=rrect(640,96,48,(0,76,255,255)); put(cv,pill,W/2,300,1.0,clamp((t-4.0)/0.2))
    put(cv,ICON.resize((66,66),Image.LANCZOS),W/2-250,300,1.0,clamp((t-4.0)/0.2))
    put(cv,txt('AUTO SUBTITLES',font='Bold',size=44,fill=(255,255,255)),W/2+20,300,1.0,clamp((t-4.0)/0.2))
    for lines,style,t0s,a,bz in SENT:
        if a<=t<bz: caption_draw(cv,t,W/2,1010+300,lines,style,t0s)
STEPS=[("1","UPLOAD YOUR VIDEO",10.0,-1),("2","PICK A CAPTION STYLE",11.0,1),("3","EXPORT & POST",12.0,-1)]
def check(cv,cx,cy,r,prog):
    d=ImageDraw.Draw(cv); pts=[(cx-r*0.5,cy+r*0.02),(cx-r*0.12,cy+r*0.42),(cx+r*0.55,cy-r*0.4)]
    d.ellipse([cx-r+SH[0],cy-r+SH[1],cx+r+SH[0],cy+r+SH[1]],fill=(34,197,94,int(255*clamp(prog*3))))
    if prog>0.2:
        q=clamp((prog-0.2)/0.6); seg1=pts[:2]; 
        d.line([(pts[0][0]+SH[0],pts[0][1]+SH[1]),(pts[0][0]+(pts[1][0]-pts[0][0])*clamp(q*2)+SH[0],pts[0][1]+(pts[1][1]-pts[0][1])*clamp(q*2)+SH[1])],fill=(255,255,255,255),width=14)
        if q>0.5: d.line([(pts[1][0]+SH[0],pts[1][1]+SH[1]),(pts[1][0]+(pts[2][0]-pts[1][0])*clamp((q-0.5)*2)+SH[0],pts[1][1]+(pts[2][1]-pts[1][1])*clamp((q-0.5)*2)+SH[1])],fill=(255,255,255,255),width=14)
def scene_steps(cv,t):
    cv.alpha_composite(BG_DARK); particles(cv,t)
    p=(t-10.0)/0.2; put(cv,txt("IT'S THAT EASY",font='Black',size=104,fill=(255,255,255),stroke=6,maxw=960),W/2,340,1.0+0.5*(1-out_back(p)),clamp(p*4))
    for k,(n,label,t0,side) in enumerate(STEPS):
        q=(t-t0)/0.28
        if q<0: continue
        cy=700+k*300; ex=out_back(q,1.4); x=W/2+side*(1-ex)*900
        row=rrect(900,210,44,(255,255,255,255) if k!=1 else (255,255,255,255)); put(cv,row,x,cy,1.0,clamp(q*3))
        circ=Image.new('RGBA',(130,130),(0,0,0,0)); ImageDraw.Draw(circ).ellipse([0,0,129,129],fill=(0,76,255,255)); put(cv,circ,x-340,cy,1.0,clamp(q*3))
        put(cv,txt(n,font='Black',size=84,fill=(255,255,255)),x-340,cy,1.0,clamp(q*3))
        put(cv,txt(label,font='Bold',size=54,fill=(12,24,50),maxw=560),x+60,cy,1.0,clamp(q*3))
        cp=(t-12.6)/0.35
        if t>=12.6: check(cv,int(x+365),int(cy),34,clamp(cp-k*0.0))
def scene_cta(cv,t):
    cv.alpha_composite(BG_CTA); particles(cv,t,(160,220,255))
    p=(t-13.0)/0.3; put(cv,ICON.resize((380,380),Image.LANCZOS),W/2,640,1.0+0.9*(1-out_back(p)),clamp(p*4))
    q=(t-13.25)/0.25
    if q>=0:
        parts=[('Liti',(255,255,255)),('X',(70,170,255)),(' AI',(255,255,255))]
        ims=[txt(s,font='Black',size=150,fill=c) for s,c in parts]; tw=sum(i.width for i in ims)+30; x=W/2-tw/2
        for im in ims:
            put(cv,im,x+im.width/2,985,1.0+0.5*(1-out_back(q)),clamp(q*4)); x+=im.width+10
    q=(t-13.55)/0.25
    if q>=0: put(cv,txt('Auto subtitles for any video',font='Medium',size=56,fill=(215,232,255),maxw=940),W/2,1130,1.0,clamp(q*3))
    q=(t-13.8)/0.3
    if q>=0:
        pl=rrect(520,130,65,(0,76,255,255),(255,255,255,255),5); put(cv,pl,W/2,1300,1.0+0.5*(1-out_back(q)),clamp(q*3))
        put(cv,txt('litix.in',font='Black',size=78,fill=(255,255,255)),W/2,1300,1.0+0.5*(1-out_back(q)),clamp(q*3))
    q=(t-14.2)/0.3
    if q>=0:
        pu=1.0+0.05*math.sin((t-14.2)*9); put(cv,txt('NOW IN BETA  -  TRY IT TODAY',font='Bold',size=44,fill=(255,214,0),maxw=940),W/2,1440,pu,clamp(q*3))
def render(t):
    global SH; SH=shake(t)
    cv=Image.new('RGBA',(W,H),(0,0,0,255))
    if t<2.0: scene_hook(cv,t)
    elif t<4.0: scene_scroll(cv,t)
    elif t<10.0: scene_demo(cv,t)
    elif t<13.0: scene_steps(cv,t)
    else: scene_cta(cv,t)
    flash(cv,t,[2.0,4.0,10.0,13.0])
    if t>15.6:
        a=clamp((t-15.6)/0.4); cv.alpha_composite(Image.new('RGBA',(W,H),(0,0,0,int(255*a))))
    return cv.convert('RGB')
if __name__=='__main__':
    if sys.argv[1]=='test':
        for tt in [0.35,0.9,1.9,2.7,3.3,4.7,5.6,7.2,9.0,10.6,11.4,12.9,13.9,15.0]:
            render(tt).resize((360,640)).save(f'/tmp/promo/t_{tt}.png')
        print('ok')
    else:
        pr=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-i','/tmp/promo/promo.wav',
            '-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart','/tmp/promo/litix_promo_short.mp4'],stdin=subprocess.PIPE)
        for i in range(NF): pr.stdin.write(render(i/FPS).tobytes())
        pr.stdin.close(); pr.wait(); print('done')
