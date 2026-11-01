// node aligner/tests/test_proxy.js  -- tests api/use-credits.js align proxy against a fake upstream (no network needed)
const http = require('http'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'use-credits.js'), 'utf8');
const a = src.indexOf('const MAX_ALIGN_BODY_BYTES'), b = src.indexOf('module.exports = async');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok:   ' : '  FAIL: ') + m); if(!c) fails++; };
const up = http.createServer((q, r) => { const bufs = []; q.on('data', d => bufs.push(d)); q.on('end', () => { r.setHeader('content-type', 'application/json');
  r.end(JSON.stringify(q.url === '/health' ? { ok: true, secret: q.headers['x-align-secret'] } : { bytes: Buffer.concat(bufs).length, ct: q.headers['content-type'], secret: q.headers['x-align-secret'], url: q.url })); }); });
up.listen(0, async () => {
  process.env.ALIGNER_URL = 'http://127.0.0.1:' + up.address().port + '/'; process.env.ALIGN_SECRET = 's3';
  const h = new Function('process', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', src.slice(a, b) + ';return handleAlignProxy;')(process, fetch, AbortController, setTimeout, clearTimeout);
  const res = () => { const o = { code: 0, body: null, status(c){ o.code = c; return o; }, json(j){ o.body = j; return o; }, setHeader(){ return o; }, send(t){ o.body = JSON.parse(t); return o; } }; return o; };
  const mp = { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } };
  let r = res(); await h({ method: 'GET', headers: {} }, r, null, {}); ok(r.code === 200 && r.body.reachable && r.body.secret === 's3', 'health forwards the secret');
  r = res(); await h(mp, r, Buffer.alloc(1000), { credits: 5 }); ok(r.code === 200 && r.body.bytes === 1000 && r.body.url === '/align' && r.body.ct.startsWith('multipart/form-data'), 'align forwards body + content-type');
  r = res(); await h(mp, r, Buffer.alloc(1000), { credits: 0 }); ok(r.code === 402, 'no credits -> 402');
  r = res(); await h(mp, r, Buffer.alloc(1000), { credits: 0, credits_infinite: true }); ok(r.code === 200, 'infinite credits allowed');
  r = res(); await h(mp, r, Buffer.alloc(5 * 1024 * 1024), { credits: 5 }); ok(r.code === 413, 'too large -> 413');
  r = res(); await h({ method: 'POST', headers: { 'content-type': 'application/json' } }, r, Buffer.alloc(10), { credits: 5 }); ok(r.code === 400, 'non-multipart -> 400');
  up.close(); process.env.ALIGNER_URL = 'http://127.0.0.1:1/';
  r = res(); await h(mp, r, Buffer.alloc(10), { credits: 5 }); ok(r.code === 504 && r.body.reachable === false, 'upstream down -> 504 (explicit, not silent)');
  delete process.env.ALIGNER_URL; r = res(); await h({ method: 'GET', headers: {} }, r, null, {}); ok(r.code === 503 && r.body.configured === false, 'not configured -> 503 configured:false');
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED'); process.exit(fails ? 1 : 0);
});
