/**
 * "Toad Guru" login page. Served to anyone who is not logged in. It only ever posts the password to
 * ?r=login; the server checks it. CSP: scripts and styles need the per-response nonce, images only from this site.
 * No innerHTML anywhere (text is set with textContent).
 */
export function loginHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#4cdc96">
<title>Toad Guru</title><link rel="icon" href="/toad-icon.png">
<script>window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};</script>
<script defer src="/_vercel/insights/script.js"></script>
<style nonce="${nonce}">
:root{--green:#4cdc96;--green2:#35c47f;--deep:#0f7a47;--ink:#0d3b27;--paper:#fbfffc;--fw:min(150px,38vw)}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--green);color:var(--ink);font:16px/1.4 ui-rounded,"Trebuchet MS","Segoe UI",system-ui,sans-serif;overflow:hidden;
  background-image:radial-gradient(circle at 20% 15%,rgba(255,255,255,.35),transparent 42%),radial-gradient(circle at 85% 90%,rgba(15,122,71,.28),transparent 46%);
  background-size:140% 140%;animation:drift 18s ease-in-out infinite alternate}
@keyframes drift{from{background-position:0 0}to{background-position:100% 80%}}

/* ---- pond decoration ---- */
.bg{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.pad{position:absolute;width:var(--s);height:var(--s);border-radius:50%;background:conic-gradient(from 25deg,var(--green2) 0 322deg,transparent 322deg);
  opacity:.75;left:var(--x);top:var(--y);animation:float var(--d) ease-in-out infinite alternate}
.pad::after{content:"";position:absolute;inset:18%;border-radius:50%;border:2px solid rgba(255,255,255,.28)}
@keyframes float{from{transform:translate(0,0) rotate(0)}to{transform:translate(22px,-16px) rotate(24deg)}}
.ring{position:absolute;left:var(--x);top:var(--y);width:140px;height:140px;margin:-70px 0 0 -70px;border-radius:50%;border:2px solid rgba(255,255,255,.55);
  opacity:0;animation:ripple 6s ease-out infinite;animation-delay:var(--dl)}
@keyframes ripple{0%{transform:scale(.15);opacity:.8}100%{transform:scale(1.5);opacity:0}}
.fly{position:absolute;width:5px;height:5px;border-radius:50%;background:var(--ink);left:var(--x);top:var(--y);opacity:.7;animation:buzz var(--d) linear infinite}
@keyframes buzz{0%{transform:translate(0,0)}15%{transform:translate(60px,-30px)}30%{transform:translate(20px,-70px)}45%{transform:translate(-40px,-40px)}
  60%{transform:translate(-70px,10px)}75%{transform:translate(-10px,40px)}100%{transform:translate(0,0)}}

/* ---- layout ---- */
.wrap{position:relative;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px}
.stage{position:relative;width:min(380px,100%);height:calc(var(--fw) * 2.32 * .62);z-index:1}
.frogwrap{position:absolute;left:50%;bottom:calc(var(--fw) * 2.32 * -.38);width:var(--fw);transform:translate(-50%,var(--hide,0));
  transition:transform .5s cubic-bezier(.34,1.4,.64,1);animation:enter .9s cubic-bezier(.34,1.56,.64,1) both .15s}
@keyframes enter{from{transform:translate(-50%,130%)}to{transform:translate(-50%,var(--hide,0))}}
.gag{transform-origin:50% 100%}
.frogtilt{transform-origin:50% 100%;transform:rotate(var(--tilt,0deg));transition:transform .25s ease-out}
.frog{display:block;width:100%;height:auto;transform-origin:50% 100%;animation:breathe 3.6s ease-in-out infinite;user-select:none;-webkit-user-drag:none;cursor:pointer}
@keyframes breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.015,.985)}}

.g-hop{animation:hop .7s cubic-bezier(.3,.7,.4,1)}
@keyframes hop{0%{transform:scale(1,1)}18%{transform:scale(1.12,.86)}50%{transform:translateY(-46px) scale(.94,1.08)}82%{transform:scale(1.1,.9)}100%{transform:scale(1,1)}}
.g-wiggle{animation:wiggle .9s ease-in-out}
@keyframes wiggle{0%,100%{transform:rotate(0)}15%{transform:rotate(-9deg)}35%{transform:rotate(8deg)}55%{transform:rotate(-6deg)}75%{transform:rotate(4deg)}}
.g-lean{animation:lean 1.4s ease-in-out}
@keyframes lean{0%,100%{transform:translateX(0) rotate(0)}30%,70%{transform:translateX(26px) rotate(14deg)}}
.g-big{animation:big 1.5s ease-in-out}
@keyframes big{0%,100%{transform:scale(1)}30%,70%{transform:scale(1.4)}}
.g-flip{animation:flip 1s ease-in-out}
@keyframes flip{from{transform:rotateY(0)}to{transform:rotateY(360deg)}}
.g-spin{transform-origin:50% 38%;animation:spin 1s cubic-bezier(.3,.7,.4,1)}
@keyframes spin{from{transform:translateY(0) rotate(0)}40%{transform:translateY(-28px) rotate(180deg)}to{transform:translateY(0) rotate(360deg)}}
.g-shake{animation:shake .6s ease-in-out}
@keyframes shake{0%,100%{transform:translateX(0) rotate(0)}15%{transform:translateX(-12px) rotate(-10deg)}35%{transform:translateX(12px) rotate(10deg)}55%{transform:translateX(-9px) rotate(-7deg)}75%{transform:translateX(7px) rotate(5deg)}}
.g-jump{animation:jump 1s cubic-bezier(.4,0,.6,1) forwards}
@keyframes jump{0%{transform:scale(1,1)}20%{transform:scale(1.15,.82)}45%{transform:translateY(-120px) scale(.9,1.15)}100%{transform:translateY(-620px) scale(.8,1.2)}}

/* speech bubble */
.bubble{position:absolute;left:50%;top:-8px;transform:translate(-50%,-100%) scale(.6);transform-origin:50% 100%;background:#fff;color:var(--ink);font-weight:700;
  padding:8px 14px;border-radius:16px;box-shadow:0 6px 18px rgba(13,59,39,.22);opacity:0;pointer-events:none;white-space:nowrap;max-width:92vw;z-index:3;
  transition:opacity .2s,transform .25s cubic-bezier(.34,1.56,.64,1)}
.bubble::after{content:"";position:absolute;left:50%;bottom:-7px;width:14px;height:14px;background:#fff;transform:translateX(-50%) rotate(45deg);border-radius:3px}
.bubble.on{opacity:1;transform:translate(-50%,-100%) scale(1)}
.bubble.bad{background:#ffe3e3;color:#8a1020}.bubble.bad::after{background:#ffe3e3}

/* card */
.card{position:relative;z-index:2;width:min(380px,100%);background:var(--paper);border-radius:26px;padding:26px 24px 22px;
  box-shadow:0 22px 50px rgba(13,59,39,.28),0 0 0 1px rgba(255,255,255,.7) inset;animation:rise .8s cubic-bezier(.2,.8,.2,1) both .05s}
@keyframes rise{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}
.card.shake{animation:cardshake .5s ease-in-out}
@keyframes cardshake{0%,100%{transform:translateX(0)}20%{transform:translateX(-10px)}40%{transform:translateX(9px)}60%{transform:translateX(-6px)}80%{transform:translateX(4px)}}
h1{margin:0;text-align:center;font-size:34px;letter-spacing:-.5px;color:var(--deep);font-weight:900}
.tag{margin:4px 0 18px;text-align:center;color:#3f6b57;min-height:1.4em;transition:opacity .35s}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.field{position:relative}
input{width:100%;font:inherit;font-size:17px;padding:14px 64px 14px 16px;border-radius:14px;border:2px solid #cfeadc;background:#fff;color:var(--ink);outline:none;transition:border-color .2s,box-shadow .2s}
input:focus{border-color:var(--green);box-shadow:0 0 0 4px rgba(76,220,150,.3)}
.eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:var(--deep);font:inherit;font-size:13px;font-weight:700;padding:8px;cursor:pointer;border-radius:10px}
.eye:hover{background:#eaf9f1}
.go{margin-top:14px;width:100%;font:inherit;font-size:17px;font-weight:800;color:#fff;background:linear-gradient(180deg,#14a35f,var(--deep));border:0;border-radius:14px;padding:14px;cursor:pointer;
  box-shadow:0 8px 18px rgba(15,122,71,.38);transition:transform .15s,box-shadow .15s,filter .2s}
.go:hover{transform:translateY(-2px);box-shadow:0 12px 22px rgba(15,122,71,.42)}
.go:active{transform:translateY(1px) scale(.99)}
.go:disabled{filter:grayscale(.4) brightness(1.05);cursor:progress}
.err{min-height:1.3em;margin:10px 0 0;text-align:center;color:#b3122a;font-weight:700;font-size:14px}
.fine{margin:6px 0 0;text-align:center;font-size:12px;color:#6f9482}

/* he lies down on the card when idle or when he gives up */
.lying{position:absolute;left:50%;bottom:-4px;width:min(250px,66vw);height:auto;transform:translate(-50%,125%);opacity:0;z-index:1;
  transition:transform .65s cubic-bezier(.34,1.3,.64,1),opacity .2s;user-select:none;-webkit-user-drag:none}
body.nap .lying,body.giveup .lying{transform:translate(-50%,0);opacity:1}
body.giveup .lying.fall{animation:fall .95s cubic-bezier(.3,.8,.4,1) both}
@keyframes fall{0%{transform:translate(-50%,-320%) rotate(-30deg);opacity:1}58%{transform:translate(-50%,6%) rotate(5deg)}78%{transform:translate(-50%,-9%) rotate(-2deg)}100%{transform:translate(-50%,0) rotate(0)}}
body.hiding .frogwrap,body.nap .frogwrap,body.giveup .frogwrap{--hide:64%;opacity:0;transition:transform .45s cubic-bezier(.5,0,.4,1),opacity .15s ease .3s}
.zz{position:absolute;left:calc(50% + 70px);bottom:70px;font-weight:900;color:#fff;opacity:0;pointer-events:none;z-index:2;text-shadow:0 2px 6px rgba(13,59,39,.35)}
body.nap .zz{animation:zzz 2.6s ease-in infinite;animation-delay:var(--zd)}
@keyframes zzz{0%{opacity:0;transform:translate(0,0) scale(.6)}20%{opacity:1}100%{opacity:0;transform:translate(26px,-70px) scale(1.5)}}

/* thinking sticker on the card: shown while the password is being checked, and after a wrong one */
.think{position:absolute;right:-16px;top:-40px;width:92px;height:auto;z-index:4;pointer-events:none;transform:scale(0) rotate(-25deg);opacity:0;
  transition:transform .45s cubic-bezier(.34,1.7,.64,1),opacity .15s;filter:drop-shadow(0 8px 12px rgba(13,59,39,.3))}
.think.on{transform:scale(1) rotate(9deg);opacity:1;animation:wobble 1.6s ease-in-out .45s infinite}
@keyframes wobble{0%,100%{transform:scale(1) rotate(9deg)}50%{transform:scale(1.05) rotate(2deg)}}

@media (max-width:420px){h1{font-size:30px}.card{padding:22px 18px 18px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.frogwrap{transform:translate(-50%,var(--hide,0))}.think.on{transform:scale(1) rotate(9deg)}}
</style></head><body>
<div class="bg" aria-hidden="true">
  <span class="pad" id="p1"></span><span class="pad" id="p2"></span><span class="pad" id="p3"></span><span class="pad" id="p4"></span>
  <span class="ring" id="r1"></span><span class="ring" id="r2"></span><span class="ring" id="r3"></span>
  <span class="fly" id="f1"></span><span class="fly" id="f2"></span><span class="fly" id="f3"></span>
</div>
<main class="wrap">
  <div class="stage">
    <div class="bubble" id="bubble" role="status" aria-live="polite"></div>
    <div class="frogwrap" id="frogwrap"><div class="gag" id="gag"><div class="frogtilt" id="tilt">
      <img class="frog" id="frog" src="/toad-guru.png" alt="Toad Guru, a calm frog in a red shirt and yellow overalls" width="224" height="520" draggable="false">
    </div></div></div>
    <img class="lying" id="lying" src="/toad-lying.png" alt="" aria-hidden="true" width="560" height="452">
    <span class="zz" id="z1" aria-hidden="true">z</span><span class="zz" id="z2" aria-hidden="true">Z</span><span class="zz" id="z3" aria-hidden="true">z</span>
  </div>
  <form class="card" id="form" autocomplete="on">
    <img class="think" id="think" src="/toad-think.png" alt="" aria-hidden="true" width="280" height="278">
    <h1>Toad Guru</h1>
    <p class="tag" id="tag">Enlightenment costs one password.</p>
    <label class="sr" for="pw">Password</label>
    <div class="field">
      <input id="pw" name="password" type="password" autocomplete="current-password" placeholder="Password" required autofocus>
      <button class="eye" id="eye" type="button" aria-label="Show password" aria-pressed="false">show</button>
    </div>
    <button class="go" id="go" type="submit">Enter the swamp</button>
    <p class="err" id="err" role="alert"></p>
    <p class="fine">Click the toad. He enjoys it.</p>
  </form>
</main>
<script nonce="${nonce}">
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var body = document.body, gag = $('#gag'), tilt = $('#tilt'), bubble = $('#bubble'), form = $('#form'), card = $('#form');
  var pw = $('#pw'), err = $('#err'), go = $('#go'), tag = $('#tag'), eye = $('#eye'), frog = $('#frog'), lying = $('#lying'), think = $('#think');
  var base = location.pathname, busy = false, typing = false, wrong = 0, lastAct = Date.now(), bubbleTimer, thinkTimer, giveTimer;

  // pond decoration positions (set here so no inline style attributes are needed under the strict CSP)
  var deco = {
    p1: ['-4vw', '8vh', '150px', '9s'], p2: ['78vw', '62vh', '210px', '12s'], p3: ['6vw', '70vh', '120px', '10s'], p4: ['68vw', '6vh', '90px', '8s'],
    r1: ['25vw', '30vh', '', '0s'], r2: ['75vw', '35vh', '', '2s'], r3: ['50vw', '85vh', '', '4s'],
    f1: ['35vw', '55vh', '', '7s'], f2: ['62vw', '25vh', '', '9s'], f3: ['18vw', '45vh', '', '11s']
  };
  Object.keys(deco).forEach(function (id) {
    var e = document.getElementById(id), v = deco[id];
    if (!e) return;
    e.style.setProperty('--x', v[0]); e.style.setProperty('--y', v[1]);
    if (v[2]) e.style.setProperty('--s', v[2]);
    if (id.charAt(0) === 'r') e.style.setProperty('--dl', v[3]); else e.style.setProperty('--d', v[3]);
  });
  ['z1', 'z2', 'z3'].forEach(function (id, i) {
    var z = document.getElementById(id);
    z.style.setProperty('--zd', (i * 0.85) + 's'); z.style.fontSize = (16 + i * 6) + 'px';
  });

  var TAGS = ['Enlightenment costs one password.', 'Patience is a lily pad.', 'Think like a pond: still, deep, slightly damp.',
    'Ribbit is a complete sentence.', 'No flies were harmed in this login.', 'Every great swamp starts with a single hop.'];
  var CHAT = ['Ribbit.', 'Hop first, ask later.', 'Big brain energy.', 'Croak responsibly.', 'I only know two words. One is ribbit.',
    'Have you tried being less of a tadpole?', 'The pond sees all. Mostly bugs.', 'Namaste. Or whatever frogs say.'];
  var IDLE = ['hop', 'wiggle', 'lean', 'big', 'flip', 'spin'];
  var GAGLINE = { hop: 'Boing!', wiggle: 'Vibes.', lean: 'Casual lean.', big: 'Big brain energy.', flip: 'Wheee!', spin: 'Wheee!' };
  var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
  var on = function (c) { body.classList.add(c); }, off = function (c) { body.classList.remove(c); };

  function say(text, ms, bad) {
    bubble.textContent = text;
    bubble.className = 'bubble on' + (bad ? ' bad' : '');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { bubble.className = 'bubble'; }, ms || 2600);
  }
  function play(name) { gag.className = 'gag'; void gag.offsetWidth; gag.className = 'gag g-' + name; }
  gag.addEventListener('animationend', function (e) { if (e.target === gag && gag.className.indexOf('g-jump') < 0) gag.className = 'gag'; });

  // the thinking sticker (shown while the password is checked, and after a wrong one)
  function thinkOn(ms) { clearTimeout(thinkTimer); think.classList.add('on'); if (ms) thinkTimer = setTimeout(thinkOff, ms); }
  function thinkOff() { clearTimeout(thinkTimer); think.classList.remove('on'); }

  // rotating tagline
  var ti = 0;
  setInterval(function () {
    tag.style.opacity = '0';
    setTimeout(function () { ti = (ti + 1) % TAGS.length; tag.textContent = TAGS[ti]; tag.style.opacity = '1'; }, 350);
  }, 5200);

  // napping: after 30 s of nothing he lies down on the card; any movement wakes him
  function nap(yes) {
    if (yes) { if (body.classList.contains('nap') || busy) return; off('hiding'); on('nap'); say('zzz... wake me when you remember it.', 4000); }
    else if (body.classList.contains('nap')) { off('nap'); say("I'm up! I'm up!", 1800); play('hop'); }
  }
  function activity() { lastAct = Date.now(); if (body.classList.contains('nap')) nap(false); }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, activity, { passive: true }); });
  setInterval(function () { if (!busy && !typing && !document.hidden && Date.now() - lastAct > 30000) nap(true); }, 1000);
  lying.addEventListener('click', function () { nap(false); });

  // he gives up after every third wrong password: he falls over and lies on the card
  function giveUp() {
    clearTimeout(giveTimer);
    off('hiding'); on('giveup'); lying.classList.remove('fall'); void lying.offsetWidth; lying.classList.add('fall');
    say('I give up. Ribbit.', 3200, true);
    giveTimer = setTimeout(function () { off('giveup'); lying.classList.remove('fall'); say('Okay, one more try.', 1800); }, 4200);
  }

  // he looks toward the pointer
  var raf = 0;
  window.addEventListener('pointermove', function (e) {
    activity();
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var t = ((e.clientX / window.innerWidth) - 0.5) * 16;
      tilt.style.setProperty('--tilt', t.toFixed(1) + 'deg');
    });
  });

  // click the toad
  frog.addEventListener('click', function () {
    if (busy) return;
    var g = pick(IDLE); play(g); say(Math.random() < 0.5 ? GAGLINE[g] : pick(CHAT), 2400);
  });

  // random idle gags
  (function loop() {
    setTimeout(function () {
      if (!busy && !typing && !document.hidden && !body.classList.contains('nap') && !body.classList.contains('giveup')) { var g = pick(IDLE); play(g); if (Math.random() < 0.55) say(GAGLINE[g], 1800); }
      loop();
    }, 5500 + Math.random() * 5000);
  })();

  // "no peeking": he hides behind the card once you start typing the password (not on the automatic focus at page load)
  function hideToad() { if (!typing) { typing = true; if (!body.classList.contains('giveup')) { on('hiding'); say('No peeking!', 1600); } } }
  pw.addEventListener('keydown', hideToad);
  pw.addEventListener('pointerdown', hideToad);
  pw.addEventListener('blur', function () { typing = false; off('hiding'); });

  eye.addEventListener('click', function () {
    var show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.textContent = show ? 'hide' : 'show';
    eye.setAttribute('aria-pressed', show ? 'true' : 'false');
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    if (show) { off('hiding'); say('Hey! I said no peeking. Okay, fine.', 2200); }
    pw.focus();
  });

  function fail(msg, lines) {
    wrong++;
    err.textContent = msg;
    card.className = 'card'; void card.offsetWidth; card.className = 'card shake';
    off('hiding'); thinkOn(2600);
    if (wrong % 3 === 0) giveUp(); else { play('shake'); say(pick(lines), 2800, true); }
    busy = false; go.disabled = false; go.textContent = 'Enter the swamp';
    pw.value = ''; pw.focus();
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    err.textContent = '';
    busy = true; go.disabled = true; go.textContent = 'Hopping...';
    nap(false); thinkOn(0);
    fetch(base + '?r=login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dashboard': '1' },
      body: JSON.stringify({ password: pw.value })
    }).then(function (res) {
      if (res.ok) {
        thinkOff(); off('hiding'); on('win'); play('jump'); say('Ribbit! Welcome back.', 2000);
        setTimeout(function () { location.reload(); }, 1000);
        return;
      }
      if (res.status === 429) return fail('Too many tries. Come back in a few minutes.', ['The toad is meditating. Try later.', 'Too many croaks. Take a breath.']);
      return fail('Wrong password.', ['Ribbit?! That is not it.', 'Nope. Even the flies know better.', 'Wrong. The pond is disappointed.']);
    }).catch(function () {
      fail('Cannot reach the swamp. Check your connection.', ['Ribbit... the pond is offline.']);
    });
  });

  setTimeout(function () { say('Ribbit. Password, please.', 2800); }, 1200);
})();
</script></body></html>`;
}
