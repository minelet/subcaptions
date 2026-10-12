/* Litix watermark + rewarded-ad unlock.
   - LitixWM.prepare()  -> Promise<boolean>: asks the server (/api/me) whether this
     account's exports carry the watermark; if so shows the gate (ad / buy / continue).
     Resolves false only if the user cancels.
   - LitixWM.draw(ctx,w,h,t) -> call after each frame is drawn during export.
   Rule (enforced server-side in lib/auth.js watermarkFor): none until 10 credits
   have been used; after that watermark, unless the account bought credits, is
   unlimited, or watched an ad (60 min window). */
(function(){
  // ── Ads provider config ─────────────────────────────────────────────────
  // provider: 'none'   -> no ad option shown (buy-only gate)
  //           'custom' -> you define window.LITIX_SHOW_AD = () => Promise<boolean>
  //                       that shows your network's rewarded ad and resolves true when
  //                       the viewer finished it.
  //           'demo'   -> 15s placeholder countdown (testing only)
  var AD = window.LITIX_AD_CONFIG || { provider: 'none' };

  var on = false, skipUntil = 0;
  function csrf(){ var m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; }
  function post(body){
    return fetch('/api/me', { method:'POST', credentials:'same-origin', cache:'no-store',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'Request failed'); return j; }); });
  }
  function fetchState(){
    return fetch('/api/me', { cache:'no-store', credentials:'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(u){ on = !!(u && u.watermark); return u; })
      .catch(function(){ return null; });
  }

  // ── Animated watermark ──────────────────────────────────────────────────
  function draw(ctx, w, h, t){
    if(!on) return;
    t = +t || 0;
    var s = Math.min(w, h), fs = s * 0.15;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var cx = w/2 + Math.sin(t*0.55)*w*0.025, cy = h/2 + Math.cos(t*0.42)*h*0.012;
    ctx.translate(cx, cy); ctx.rotate(-0.1 + Math.sin(t*0.3)*0.012);
    var pulse = 0.5 + 0.5*Math.sin(t*1.5);
    ctx.font = '800 ' + fs + 'px Inter, "Helvetica Neue", Arial, sans-serif';
    var txt = 'LITIX', tw = ctx.measureText(txt).width;
    ctx.shadowColor = 'rgba(0,0,0,0.38)'; ctx.shadowBlur = fs*0.16;
    ctx.fillStyle = 'rgba(255,255,255,' + (0.19 + 0.05*pulse) + ')';
    ctx.fillText(txt, 0, 0);
    ctx.shadowBlur = 0;
    // shimmer sweep
    var ph = (t % 3.4) / 3.4, bx = -tw*0.8 + ph*tw*1.9;
    var g = ctx.createLinearGradient(bx - tw*0.22, -fs, bx + tw*0.22, fs);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillText(txt, 0, 0);
    // animated underline + tagline
    var bar = tw * (0.35 + 0.25*pulse);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.22 + 0.08*pulse) + ')';
    ctx.fillRect(-bar/2, fs*0.62, bar, Math.max(2, fs*0.035));
    ctx.font = '600 ' + (fs*0.21) + 'px Inter, "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText('litixtools.vercel.app', 0, fs*0.9);
    ctx.restore();
    // faint secondary marks so a crop of the middle still carries one
    ctx.save(); ctx.globalAlpha = 0.11; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '800 ' + (fs*0.34) + 'px Inter, "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('LITIX', w*(0.28 + 0.04*Math.sin(t*0.4)), h*0.2);
    ctx.fillText('LITIX', w*(0.72 - 0.04*Math.sin(t*0.4)), h*0.8);
    ctx.restore();
  }

  // ── Gate UI ─────────────────────────────────────────────────────────────
  function el(tag, css, html){ var e = document.createElement(tag); if(css) e.style.cssText = css; if(html!=null) e.innerHTML = html; return e; }
  function modal(build){
    return new Promise(function(resolve){
      var ov = el('div','position:fixed;inset:0;z-index:2147483000;background:rgba(5,8,16,.72);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,sans-serif');
      var box = el('div','width:100%;max-width:400px;background:#101522;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:22px;color:#e8ecf5;box-shadow:0 24px 60px rgba(0,0,0,.55)');
      ov.appendChild(box); document.body.appendChild(ov);
      build(box, function(v){ ov.remove(); resolve(v); });
    });
  }
  function btn(label, primary){
    var b = el('button', 'display:block;width:100%;margin-top:10px;padding:12px 14px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid ' +
      (primary ? 'transparent;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff' : 'rgba(255,255,255,.16);background:transparent;color:#cfd6e6'), label);
    b.type = 'button'; return b;
  }
  function runAd(box){
    var provider = AD.provider;
    if(provider === 'custom' && typeof window.LITIX_SHOW_AD === 'function') return Promise.resolve(window.LITIX_SHOW_AD());
    if(provider === 'demo'){
      return new Promise(function(res){
        box.innerHTML = '<div style="font-weight:700;font-size:16px">Ad playing (demo)</div><div id="lwm-cd" style="font-size:34px;font-weight:800;margin:14px 0">15</div><div style="font-size:12px;opacity:.65">Placeholder ad — connect a real provider in LITIX_AD_CONFIG.</div>';
        var n = 15, it = setInterval(function(){ n--; var c = box.querySelector('#lwm-cd'); if(c) c.textContent = n; if(n<=0){ clearInterval(it); res(true); } }, 1000);
      });
    }
    return Promise.resolve(false);
  }
  function watchAd(box){
    box.innerHTML = '<div style="font-size:14px;opacity:.8">Starting…</div>';
    return post({ action:'ad-start' }).then(function(s){
      var t0 = Date.now();
      return runAd(box).then(function(ok){
        if(!ok) throw new Error('Ad was not completed');
        var wait = Math.max(0, (s.minWatchMs||12000) - (Date.now()-t0)) + 300;
        return new Promise(function(r){ setTimeout(r, wait); });
      }).then(function(){ return post({ action:'ad-complete', nonce:s.nonce }); });
    });
  }
  function gate(){
    return modal(function(box, done){
      var canAd = AD.provider === 'demo' || (AD.provider === 'custom' && typeof window.LITIX_SHOW_AD === 'function');
      function render(msg){
        box.innerHTML = '<div style="font-size:18px;font-weight:700">Export has a Litix watermark</div>' +
          '<div style="font-size:13px;line-height:1.5;opacity:.72;margin-top:8px">You’ve used your first 10 free credits. ' + (canAd ? 'Watch a short ad to export clean for the next hour, or ' : '') + 'buy credits to remove it for good.</div>' +
          (msg ? '<div style="color:#fca5a5;font-size:12.5px;margin-top:10px">' + msg + '</div>' : '');
        if(canAd){ var a = btn('Watch an ad — remove watermark', true); a.onclick = function(){
          watchAd(box).then(function(){ return fetchState(); }).then(function(){ done(true); })
            .catch(function(e){ render(e.message || 'Could not verify the ad'); }); }; box.appendChild(a); }
        var b = btn('Buy credits', !canAd); b.onclick = function(){ done(false); if(typeof window.openBuyModal === 'function') window.openBuyModal(); else location.href = '/'; }; box.appendChild(b);
        var c = btn('Export with watermark'); c.onclick = function(){ skipUntil = Date.now() + 5*60*1000; done(true); }; box.appendChild(c);
      }
      render();
    });
  }

  window.LitixWM = {
    draw: draw,
    isOn: function(){ return on; },
    prepare: function(){
      return fetchState().then(function(u){
        if(!on) return true;
        if(Date.now() < skipUntil) return true;
        return gate();
      });
    },
    _config: AD
  };
})();
