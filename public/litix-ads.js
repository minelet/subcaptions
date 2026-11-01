/* Litix – Google rewarded-ad adapter. Load BEFORE /litix-wm.js.
   Fill in ONE of the two options below. Leave both blank and the ad button
   simply stays hidden (buy-only gate), so nothing breaks.

   OPTION A – AdSense / Google Ad Placement API (adBreak type 'reward')
     ADSENSE_CLIENT = 'ca-pub-XXXXXXXXXXXXXXXX'
   OPTION B – Google Ad Manager rewarded ad (GPT)
     GPT_AD_UNIT = '/1234567/litix_rewarded'
*/
(function(){
  var ENABLED        = false; // flip to true ONLY after Google approves the site + rewarded ads
  var ADSENSE_CLIENT = 'ca-pub-3780585730195648';
  var GPT_AD_UNIT    = '';   // e.g. '/21775744923/litix_rewarded'
  var TIMEOUT_MS     = 10000; // give up if Google never answers

  var mode = !ENABLED ? '' : /^ca-pub-\d{10,}$/.test(ADSENSE_CLIENT) ? 'adsense'
           : /^\/\d+\/.+/.test(GPT_AD_UNIT) ? 'gpt' : '';
  if(!mode) return;

  window.LITIX_AD_CONFIG = { provider: 'custom' };

  function load(src, attrs){
    var s = document.createElement('script'); s.async = true; s.src = src;
    s.crossOrigin = 'anonymous';
    for(var k in (attrs||{})) s.setAttribute(k, attrs[k]);
    document.head.appendChild(s);
  }
  // Shows a "Play ad" button inside the existing gate box. Google wants the
  // viewer to opt in with a tap, so the ad starts from a real click.
  function promptPlay(box, onPlay){
    if(!box){ onPlay(); return; }
    box.innerHTML = '<div style="font-weight:700;font-size:16px">Ad ready</div>' +
      '<div style="font-size:13px;opacity:.7;margin:8px 0 4px">Watch it to the end to remove the watermark.</div>';
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Play ad';
    b.style.cssText = 'display:block;width:100%;margin-top:10px;padding:12px 14px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;border:0;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff';
    b.onclick = function(){ b.disabled = true; onPlay(); };
    box.appendChild(b);
  }
  function loadingMsg(box){ if(box) box.innerHTML = '<div style="font-size:14px;opacity:.8">Loading ad…</div>'; }

  /* ── Option A: AdSense Ad Placement API ───────────────────────────── */
  if(mode === 'adsense'){
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function(o){ window.adsbygoogle.push(o); };
    load('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + ADSENSE_CLIENT,
         { 'data-ad-client': ADSENSE_CLIENT });
    window.adConfig({ preloadAdBreaks: 'on', sound: 'on' });

    window.LITIX_SHOW_AD = function(box){
      return new Promise(function(resolve, reject){
        var viewed = false, started = false, done = false;
        loadingMsg(box);
        var timer = setTimeout(function(){
          if(!started && !done){ done = true; reject(new Error('No ad available right now. Please try again in a bit.')); }
        }, TIMEOUT_MS);
        window.adBreak({
          type: 'reward',
          name: 'remove-watermark',
          beforeReward: function(showAdFn){ started = true; clearTimeout(timer); promptPlay(box, showAdFn); },
          adViewed:    function(){ viewed = true; },
          adDismissed: function(){ viewed = false; },
          adBreakDone: function(info){
            clearTimeout(timer);
            if(done) return; done = true;
            if(viewed) resolve(true);
            else if(started) reject(new Error('Ad was closed before finishing.'));
            else reject(new Error('No ad available right now. Please try again in a bit.'));
          }
        });
      });
    };
  }

  /* ── Option B: Google Ad Manager rewarded (GPT) ───────────────────── */
  if(mode === 'gpt'){
    window.googletag = window.googletag || { cmd: [] };
    load('https://securepubads.g.doubleclick.net/tag/js/gpt.js');

    window.LITIX_SHOW_AD = function(box){
      return new Promise(function(resolve, reject){
        var granted = false, ready = false, finished = false, slot = null;
        loadingMsg(box);
        var timer = setTimeout(function(){
          if(!ready && !finished){ finished = true; reject(new Error('No ad available right now. Please try again in a bit.')); }
        }, TIMEOUT_MS);
        googletag.cmd.push(function(){
          var ps = googletag.pubads();
          slot = googletag.defineOutOfPageSlot(GPT_AD_UNIT, googletag.enums.OutOfPageFormat.REWARDED);
          if(!slot){ clearTimeout(timer); finished = true; return reject(new Error('Rewarded ads are not supported on this device.')); }
          slot.addService(ps);
          ps.addEventListener('rewardedSlotReady', function(e){
            if(e.slot !== slot) return; ready = true; clearTimeout(timer);
            promptPlay(box, function(){ e.makeRewardVisible(); });
          });
          ps.addEventListener('rewardedSlotGranted', function(e){ if(e.slot === slot) granted = true; });
          ps.addEventListener('rewardedSlotClosed', function(e){
            if(e.slot !== slot || finished) return; finished = true;
            googletag.destroySlots([slot]);
            granted ? resolve(true) : reject(new Error('Ad was closed before finishing.'));
          });
          googletag.enableServices();
          googletag.display(slot);
        });
      });
    };
  }
})();
