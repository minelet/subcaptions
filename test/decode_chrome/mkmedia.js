const fs=require('fs');const {makeClip}=require('./synth.js');
const clip=makeClip(11,{dur:60,noise:0.01,pauseMax:1.5});
const n=clip.samples.length, buf=Buffer.alloc(44+n*2);
buf.write('RIFF',0);buf.writeUInt32LE(36+n*2,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(16000,24);buf.writeUInt32LE(32000,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(n*2,40);
for(let i=0;i<n;i++)buf.writeInt16LE(Math.max(-32767,Math.min(32767,Math.round(clip.samples[i]*32767))),44+i*2);
fs.writeFileSync('media/speech.wav',buf);
fs.writeFileSync('media/truth.json',JSON.stringify(clip.words.map(w=>[w.start,w.end])));
