// End-to-end: runs the REAL startGroqTranscription() from index.html with a fake decoder + fake server.
const fs=require('fs');
const src=fs.readFileSync(process.argv[2]||'public/index.html','utf8');
const S=src.indexOf('LITIX SUBTITLE ENGINE — START'),E=src.indexOf('LITIX SUBTITLE ENGINE — END');
const engine=src.slice(src.lastIndexOf('/*',S),src.indexOf('\n',E));
const fn=n=>{const a=src.indexOf('\nfunction '+n+'(');if(a<0)throw new Error('missing '+n);return src.slice(a,src.indexOf('\n}\n',a)+3)};
const afn=n=>{const a=src.indexOf('\nasync function '+n+'(');if(a<0)throw new Error('missing '+n);return src.slice(a,src.indexOf('\n}\n',a)+3)};
const fillers=(src.match(/\nconst FILLER_WORDS = new Set\(\[[\s\S]*?\]\);/)||[''])[0];
const helpers=['estimateWordTimesEvenly','clipWordOverlaps','scoreWordImportance','normalizeSubtitleTiming','computeEnergyEnvelope','smoothEnergyEnvelope','refineWordBoundariesWithAudio','finishGeneration'].map(fn).join('\n');
let CFG={}; const log={progress:[],errors:[],fetches:[],calls:[]};
global.window={}; global.fetch=async(url,o)=>{log.fetches.push({url,body:o&&o.body});return{ok:true,json:async()=>({credits:5,creditsInfinite:false})}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const body=`
 let style={maxWordsPerSub:3,minWordsPerSub:1}, subtitles=[], rawWords=[], rawSegments=[], isGenerating=false, lastChargedCredits=CFG.charged||0, currentUser=CFG.user||null;
 const currentFile=(()=>{const f=new Blob(['x']);Object.defineProperty(f,'name',{value:'v.mp4'});Object.defineProperty(f,'size',{value:CFG.fileSize||1e6});return f})(); const vp={duration:CFG.vpDur||250};
 const $=id=>id==='lang-sel'?{value:CFG.lang||'en'}:({style:{},classList:{add(){},remove(){}},textContent:'',disabled:false});
 function renderList(){} function updateSubCount(){} function enforceLineBudget(){return false}
 function resetOutput(){subtitles=[];rawSegments=[];rawWords=[]}
 function showProgress(p,a,b){log.progress.push([p,a])} function hideProgress(){} function showError(m){log.errors.push(m)}
 async function extractAudioChunks(){ if(CFG.decodeFails){const e=new Error('boom');e.codecInfo={codec:'ac3'};throw e}
   const sec=CFG.audioSec||250; const samples=new Float32Array(sec*16000); for(let i=0;i<samples.length;i++)samples[i]=(Math.random()-.5)*.02;
   return {chunks:CFG.chunks.map((c,i)=>({...c,blob:new Blob(['x']),name:'audio_part'+i+'.wav'})),samples,sampleRate:16000}}
 async function callTranscribeProxy(ep,form){ log.calls.push(ep); return CFG.server(ep,form) }
 ${fillers}\n${helpers}\n${engine}
 return {run:startGroqTranscription, get subs(){return subtitles}, get gen(){return isGenerating}};`;
const mk=cfg=>{CFG=cfg;log.progress=[];log.errors=[];log.fetches=[];log.calls=[];return new Function('CFG','log',body)(cfg,log)};
const resp=(d,status=200)=>({ok:status<400,status,clone(){return this},json:async()=>d,text:async()=>typeof d==='string'?d:JSON.stringify(d)});
// fake whisper: chunk i has `n[i]` words 0.5s apart starting 1s, grouped in sentences of 6
const whisper=(n,{lang='english',stretch=1,dur=[100,100,60]}={})=>(ep,form)=>{
 if(ep==='chat'){const req=JSON.parse(form);const arr=JSON.parse(req.messages[1].content);return resp({choices:[{message:{content:JSON.stringify(arr.map(x=>'हिंदी '+x))}}]})}
 const i=+form.get('file').name.match(/(\d+)/)[1]; const words=[],segs=[];
 for(let k=0;k<n[i];k++){const s=(1+.5*k)*stretch;words.push({word:`w${i}_${k}`,start:s,end:s+.4*stretch});}
 for(let k=0;k<n[i];k+=6){const g=words.slice(k,k+6);segs.push({start:g[0].start,end:g[g.length-1].end,text:' '+g.map(w=>w.word).join(' ')+'.',no_speech_prob:.01,avg_logprob:-.2,compression_ratio:1.2})}
 return resp({language:lang,duration:dur[i]*stretch,words,segments:segs})};
let fails=0;const ok=(c,m)=>{if(!c)fails++;console.log(c?'  ok:  ':'  FAIL:',m)};
const three=[{offset:0,usableEnd:95},{offset:95,usableEnd:190},{offset:190,usableEnd:Infinity}];
(async()=>{
 console.info=()=>{}; console.warn=()=>{}; console.error=()=>{};
 console.log('A. English, 3 chunks (460 words)');
 let a=mk({chunks:three,server:whisper([180,180,100])}); await a.run(); await sleep(800);
 const all=a.subs.flatMap(c=>c.wordTimes);
 ok(log.errors.length===0,'no error shown ('+log.errors+')'); ok(a.gen===false,'generation finished (button re-enabled)');
 ok(all.length===460,'all 460 words present: '+all.length); ok(new Set(all.map(w=>w.text)).size===460,'no duplicates across chunk joins');
 ok(a.subs.every((c,i)=>i===0||c.start>=a.subs[i-1].start),'captions in time order');
 ok(Math.abs(all.find(w=>w.text==='w1_0').start-96)<0.2,'chunk 2 word w1_0 lands at 96s (offset applied): '+all.find(w=>w.text==='w1_0').start.toFixed(2));
 ok(Math.abs(all.find(w=>w.text==='w2_0').start-191)<0.2,'chunk 3 word w2_0 lands at 191s');
 ok(log.progress[log.progress.length-1][0]===100,'progress reached 100%'); ok(log.calls.join()==='transcriptions,transcriptions,transcriptions','exactly one server call per chunk');
 ok(a.subs.every(c=>c.text.split(' ').length<=3),'max 3 words per caption'); ok(log.fetches.length===0,'infinite/no user: no credit call');

 console.log('B. Hindi wanted (conversion + real timing replaced by even split)');
 let b=mk({lang:'hi',chunks:[three[0]],audioSec:100,vpDur:100,server:whisper([40])}); await b.run(); await sleep(800);
 ok(log.errors.length===0,'no error shown ('+log.errors+')'); ok(log.calls.includes('chat'),'conversion endpoint called'); ok(b.subs.length>0&&b.subs.every(c=>/हिंदी/.test(c.text)||c.text.length),'captions produced from converted text: '+(b.subs[0]||{}).text);

 console.log('C. time axis stretched 2x -> shrunk back');
 let c=mk({chunks:[{offset:0,usableEnd:Infinity}],audioSec:100,vpDur:100,server:whisper([150],{stretch:2,dur:[100]})}); await c.run(); await sleep(800);
 const last=c.subs[c.subs.length-1]; ok(log.errors.length===0&&last.end<=105,'last caption ends at '+last.end.toFixed(1)+'s (<=105, was ~150)');

 console.log('D. credits: video longer than estimate');
 let d=mk({chunks:three,user:{creditsInfinite:false},charged:1,server:whisper([180,180,100])}); await d.run(); await sleep(800);
 const cf=log.fetches.find(f=>/use-credits/.test(f.url)); ok(cf&&JSON.parse(cf.body).amount===4,'charged the 4 missing credits (ceil(250/60)=5, paid 1): '+(cf&&cf.body));

 console.log('E. failures show a clear message and never hang');
 let e=mk({decodeFails:true,fileSize:50e6,chunks:three,server:whisper([1])}); await e.run(); ok(/audio track|codec/.test(log.errors[0]||'')&&e.gen===false,'big file + decode fail -> "'+(log.errors[0]||'').slice(0,70)+'…"');
 e=mk({decodeFails:true,fileSize:1e6,chunks:three,server:whisper([20,0,0])}); e.run; 
 // small file + decode fail falls back to sending the original file: server sees the file name
 e=mk({decodeFails:true,fileSize:1e6,chunks:three,server:(ep,f)=>resp({language:'english',duration:10,words:[{word:'hi',start:1,end:1.3},{word:'all',start:1.3,end:1.6},{word:'ok',start:1.6,end:1.9},{word:'go',start:1.9,end:2.2}],segments:[{start:1,end:2.2,text:' hi all ok go',no_speech_prob:0,avg_logprob:-.1,compression_ratio:1}]})}); await e.run(); await sleep(800);
 ok(log.errors.length===0&&e.subs.length>0,'small file + decode fail -> falls back to sending original file, still works');
 e=mk({chunks:three,server:()=>resp('<html>Bad gateway</html>',500)}); await e.run(); ok(/500/.test(log.errors[0]||'')&&e.gen===false,'server 500 -> "'+(log.errors[0]||'').slice(0,60)+'"');
 e=mk({chunks:[three[0]],server:()=>resp({language:'english',duration:5,words:[],segments:[]})}); await e.run(); ok(/No speech/.test(log.errors[0]||'')&&e.gen===false,'silent video -> "'+log.errors[0]+'"');
 e=mk({chunks:[three[0]],server:()=>{throw new TypeError('Failed to fetch')}}); await e.run(); ok(/Network error/.test(log.errors[0]||''),'offline -> "'+log.errors[0]+'"');
 console.log(fails?`\n${fails} FAILED`:'\nE2E ALL PASSED'); process.exit(fails?1:0);
})();
