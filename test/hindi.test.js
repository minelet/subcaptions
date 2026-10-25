// Hindi / Hinglish tests. Runs the REAL engine block from index.html with a fake decoder and fake server.
const fs=require('fs');
const src=fs.readFileSync(process.argv[2]||'public/index.html','utf8');
const S=src.indexOf('LITIX SUBTITLE ENGINE — START'),E=src.indexOf('LITIX SUBTITLE ENGINE — END');
const engine=src.slice(src.lastIndexOf('/*',S),src.indexOf('\n',E));
const fn=n=>{const a=src.indexOf('\nfunction '+n+'(');if(a<0)throw new Error('missing '+n);return src.slice(a,src.indexOf('\n}\n',a)+3)};
const fillers=(src.match(/\nconst FILLER_WORDS = new Set\(\[[\s\S]*?\]\);/)||[''])[0];
const helpers=['estimateWordTimesEvenly','clipWordOverlaps','scoreWordImportance','normalizeSubtitleTiming','computeEnergyEnvelope','smoothEnergyEnvelope','refineWordBoundariesWithAudio','finishGeneration'].map(fn).join('\n');
let CFG={}; const log={chat:[],calls:[],errors:[]}; const els={};
global.window={}; global.fetch=async()=>({ok:true,json:async()=>({credits:5})});
const body=`
 let style={maxWordsPerSub:3,minWordsPerSub:1}, subtitles=[], rawWords=[], rawSegments=[], isGenerating=false, lastChargedCredits=0, currentUser=null;
 const currentFile=(()=>{const f=new Blob(['x']);Object.defineProperty(f,'name',{value:'v.mp4'});return f})(); const vp={duration:CFG.audioSec||40};
 const $=id=>id==='lang-sel'?{value:CFG.lang||'hi-en'}:(els[id]||(els[id]={style:{},classList:{add(){},remove(){}},textContent:'',disabled:false}));
 function renderList(){} function updateSubCount(){} function enforceLineBudget(){return false}
 function resetOutput(){subtitles=[];rawSegments=[];rawWords=[]}
 function showProgress(){} function hideProgress(){} function showError(m){log.errors.push(m)}
 async function extractAudioChunks(){const sec=CFG.audioSec||40;const samples=new Float32Array(sec*16000);for(let i=0;i<samples.length;i++)samples[i]=(Math.random()-.5)*.02;
   return {chunks:[{offset:0,usableEnd:Infinity,blob:new Blob(['x']),name:'audio_part0.wav'}],samples,sampleRate:16000}}
 async function callTranscribeProxy(ep,form){ log.calls.push(ep); return CFG.server(ep,form) }
 ${fillers}\n${helpers}\n${engine}
 return {convertTranscript, transcribeChunk, run:startGroqTranscription, get subs(){return subtitles}, get gen(){return isGenerating}};`;
const mk=cfg=>{CFG=cfg;log.chat=[];log.calls=[];log.errors=[];Object.keys(els).forEach(k=>delete els[k]);return new Function('CFG','log','els',body)(cfg,log,els)};
const resp=(d,status=200)=>({ok:status<400,status,clone(){return this},json:async()=>d,text:async()=>typeof d==='string'?d:JSON.stringify(d)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ok=(c,m)=>{if(!c)fails++;console.log(c?'  ok:  ':'  FAIL:',m)};
const DEV=/[\u0900-\u097F]/;
// fake language model. hooks: bad(innerWords, callNo) => true makes the answer one word short for that sentence; down => HTTP 500; garbage => not JSON
function model(h={}){let n=0;return (ep,form)=>{
  if(ep!=='chat') return h.whisper(ep,form);
  n++; if(h.down) return resp('upstream down',500);
  const req=JSON.parse(form); const sys=req.messages[0].content, want=/Devanagari script\. Words already/.test(sys)?'hi':'hi-en';
  const payload=JSON.parse(req.messages[1].content); log.chat.push({n,sys,payload});
  if(h.garbage) return resp({choices:[{message:{content:'sorry, here you go: ...'}}]});
  const out = Array.isArray(payload[0])
    ? payload.map(inner=>{ let r=inner.map(w=> want==='hi-en' ? (/(?!\p{Script=Latin})\p{L}/u.test(w)?'r'+w.length:w) : (/\p{L}/u.test(w)&&!DEV.test(w)?'हि_'+w.length:w)); if(h.bad&&h.bad(inner,n)) r=r.slice(0,-1); return r})
    : payload.map(t=>'T:'+t);
  return resp({choices:[{message:{content:'```json\n'+JSON.stringify(out)+'\n```'}}]})}};
const W=(t,s,e)=>({text:t,start:s,end:e});
const segs=[{start:0,end:2,text:'नमस्ते दोस्तों कैसे हो'},{start:3,end:5,text:'आज हम meeting करेंगे'}];
const words=()=>[W('नमस्ते',.1,.5),W('दोस्तों',.6,1.0),W('कैसे',1.1,1.4),W('हो',1.5,1.9),W('आज',3.1,3.4),W('हम',3.5,3.8),W('meeting',3.9,4.4),W('करेंगे',4.5,4.9)];
const sameTimes=(a,b)=>a.length===b.length&&a.every((w,i)=>w.start===b[i].start&&w.end===b[i].end);

(async()=>{ console.info=()=>{};console.warn=()=>{};console.error=()=>{};
 console.log('1. Hindi speech, Devanagari wanted, text already Devanagari (except one English word)');
 let a=mk({server:model({whisper:()=>{}})}); let r=await a.convertTranscript(words().slice(0,4),[segs[0]],'hi','hindi');
 ok(log.chat.length===0,'nothing to change -> language model NOT called'); ok(r.words.map(w=>w.text).join(' ')==='नमस्ते दोस्तों कैसे हो'&&sameTimes(r.words,words().slice(0,4)),'words and real timestamps identical');
 r=await a.convertTranscript(words(),segs,'hi','hindi');
 ok(log.chat.length===1&&log.chat[0].payload.length===1,'only the sentence with an English word is sent ('+log.chat[0].payload.length+' of 2)');
 ok(r.words[6].text==='हि_7'&&r.words.filter(w=>DEV.test(w.text)).length===8,'only "meeting" changed; Devanagari words untouched');
 ok(sameTimes(r.words,words())&&r.warnings.length===0,'all 8 real timestamps preserved, no warnings');

 console.log('2. Hindi speech, Hinglish wanted: real timing kept, spelling changed');
 a=mk({server:model({whisper:()=>{}})}); r=await a.convertTranscript(words(),segs,'hi-en','hindi');
 ok(r.words.every(w=>!DEV.test(w.text)),'no Devanagari left: '+r.words.map(w=>w.text).join(' ')); ok(sameTimes(r.words,words()),'all real timestamps preserved (old code replaced them with even guesses)');
 ok(log.chat.length===1&&log.chat[0].payload.length===2,'both sentences in ONE request'); ok(r.segments.length===2&&r.segments[0].start===0&&r.segments[1].end===5,'sentence boundaries kept');

 console.log('3. model returns a wrong word count for one sentence');
 a=mk({server:model({whisper:()=>{},bad:(inner,n)=>n===1&&inner.includes('हम')})}); r=await a.convertTranscript(words(),segs,'hi-en','hindi');
 ok(log.chat.length===2&&log.chat[1].payload.length===1,'only the bad sentence is retried, alone'); ok(sameTimes(r.words,words())&&r.words.every(w=>!DEV.test(w.text))&&r.warnings.length===0,'retry succeeded: real timing kept, no warning');
 a=mk({server:model({whisper:()=>{},bad:inner=>inner.includes('हम')})}); r=await a.convertTranscript(words(),segs,'hi-en','hindi');
 ok(sameTimes(r.words.slice(0,4),words().slice(0,4)),'the good sentence keeps exact timing'); const s2=r.words.slice(4);
 ok(s2.length>0&&s2[0].start>=3-1e-6&&s2[s2.length-1].end<=5+1e-6&&s2.every((w,i)=>i===0||w.start>=s2[i-1].start),'the bad sentence falls back to whole-sentence text, spread inside 3s–5s: '+s2.map(w=>w.text).join(' '));
 ok(r.warnings.length===1&&/timing/.test(r.warnings[0]),'user is told: "'+r.warnings[0]+'"');

 console.log('4. language service down / garbage answer');
 a=mk({server:model({whisper:()=>{},down:true})}); r=await a.convertTranscript(words(),segs,'hi-en','hindi');
 ok(sameTimes(r.words,words())&&r.words.map(w=>w.text).join(' ')===words().map(w=>w.text).join(' ')&&r.segments.length===2,'HTTP 500 -> no crash, original words and timing kept'); ok(r.warnings.length>=1&&/failed/.test(r.warnings[0]),'user is told: "'+r.warnings[0]+'"');
 a=mk({server:model({whisper:()=>{},garbage:true})}); r=await a.convertTranscript(words(),segs,'hi-en','hindi');
 ok(sameTimes(r.words,words())&&r.words.map(w=>w.text).join(' ')===words().map(w=>w.text).join(' '),'garbage answer -> no crash, original text AND timing kept'); ok(r.warnings.length>=1,'user is told about it');

 console.log('4b. Urdu-script output (Whisper often labels Hindi as Urdu)');
 a=mk({server:model({whisper:()=>{}})}); r=await a.convertTranscript([W('سلام',1,1.5),W('دوستو',1.5,2.1)],[{start:1,end:2.2,text:'سلام دوستو'}],'hi','urdu');
 ok(r.words.map(w=>w.text).join(' ')==='हि_4 हि_5'&&sameTimes(r.words,[W('',1,1.5),W('',1.5,2.1)]),'Urdu-script words rewritten to Devanagari, real timing kept: '+r.words.map(w=>w.text).join(' '));
 a=mk({server:model({whisper:()=>{}})}); r=await a.convertTranscript([W('سلام',1,1.5),W('दोस्त',1.5,2.1)],[{start:1,end:2.2,text:'سلام दोस्त'}],'hi-en','urdu');
 ok(r.words.map(w=>w.text).join(' ')==='r4 r5','Urdu AND Devanagari words both turned Roman for Hinglish: '+r.words.map(w=>w.text).join(' '));
 console.log('5. English speech, Hindi wanted -> translate whole sentences, spread by word length');
 a=mk({server:model({whisper:()=>{}})}); const es=[{start:10,end:14,text:'It is a wonderful morning'}];
 r=await a.convertTranscript([W('It',10,10.3),W('is',10.3,10.6)],es,'hi','english');
 ok(r.segments[0].text==='T:It is a wonderful morning'&&r.words.length===5,'sentence translated, 5 words made from it: '+r.words.map(w=>w.text).join(' '));
 ok(r.words[0].start>=10&&r.words[4].end<=14.0001&&r.words.every((w,i)=>i===0||w.start>=r.words[i-1].start),'words stay inside 10s–14s, in order');
 const wf=r.words.find(w=>w.text==='wonderful'),wi=r.words.find(w=>w.text==='is'); ok(wf&&wi&&(wf.end-wf.start)>(wi.end-wi.start),'a long word gets more time than a short one');
 a=mk({server:model({whisper:()=>{},garbage:true})}); r=await a.convertTranscript([],es,'hi','english');
 ok(r.segments[0].text==='It is a wonderful morning'&&r.warnings.length===1,'garbage answer -> English kept for that sentence + warning');

 console.log('6. Devanagari "enough words?" check (was blind to Hindi)');
 const hiData={language:'hindi',duration:10,words:[{word:'नमस्ते',start:1,end:2}],segments:[{start:1,end:9,text:' नमस्ते दोस्तों आज हम सब मिलकर बात करेंगे',no_speech_prob:0,avg_logprob:-.1,compression_ratio:1}]};
 a=mk({server:()=>resp(hiData)}); await a.transcribeChunk({offset:0,usableEnd:Infinity,blob:new Blob(['x']),name:'a.wav'},0,'hi');
 ok(log.calls.length===3,'too few Hindi words -> retried twice (3 requests total): '+log.calls.length);

 console.log('7. FULL RUN through startGroqTranscription (Hindi speech, 40 words)');
 const hindiWhisper=()=>{const ws=[],sg=[];for(let k=0;k<40;k++)ws.push({word:'शब्द'+k+(k%6===5?'।':''),start:1+k*.5,end:1.4+k*.5});
   for(let k=0;k<40;k+=6){const g=ws.slice(k,k+6);sg.push({start:g[0].start,end:g[g.length-1].end,text:' '+g.map(w=>w.word).join(' '),no_speech_prob:.01,avg_logprob:-.2,compression_ratio:1.2})}
   return resp({language:'hindi',duration:40,words:ws,segments:sg})};
 a=mk({lang:'hi-en',server:model({whisper:hindiWhisper})}); await a.run(); await sleep(800);
 let all=a.subs.flatMap(c=>c.wordTimes);
 ok(log.errors.length===0&&a.gen===false,'no error, finished'); ok(all.length===40,'40 words on screen: '+all.length); ok(all.every(w=>!DEV.test(w.text)),'all Roman: '+all.slice(0,4).map(w=>w.text).join(' '));
 const real=k=>1+k*.5; let worst=0; all.forEach((w,k)=>{worst=Math.max(worst,Math.abs(w.start-real(k)))}); ok(worst<0.35,'word times still match the real speech (worst drift '+worst.toFixed(2)+'s)');
 ok(!(els.err&&els.err.textContent),'no warning shown to the user');
 a=mk({lang:'hi-en',server:model({whisper:hindiWhisper,down:true})}); await a.run(); await sleep(800);
 all=a.subs.flatMap(c=>c.wordTimes);
 ok(log.errors.length===0&&all.length===40&&a.gen===false,'conversion service down -> captions STILL generated (Devanagari kept)');
 ok(els.err&&/Note:/.test(els.err.textContent)&&/failed/.test(els.err.textContent),'visible note: "'+(els.err&&els.err.textContent).slice(0,110)+'…"');
 a=mk({lang:'hi',server:model({whisper:hindiWhisper})}); await a.run(); await sleep(800);
 ok(log.chat.length===0&&a.subs.length>0,'Hindi speech + Hindi wanted + already Devanagari -> zero model calls, instant');
 console.log(fails?`\n${fails} FAILED`:'\nHINDI ALL PASSED'); process.exit(fails?1:0);
})();
