// Lock-screen simulation: start Google HD narration, then "lock": document.hidden=true, setTimeout/setInterval/rAF frozen,
// OfflineAudioContext stalls, and (like iOS) play() is refused while hidden unless the element is already playing or it is called
// synchronously from that element's 'ended' handler. Narration must keep advancing across several chunk handoffs.
//   node tests/lock-test.mjs [appRoot] [latencyMs]
import { chromium } from 'playwright'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { startServer } from './synth.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const ROOT = path.resolve(process.argv[2] || path.join(here, '..'));
const LAT = +(process.argv[3] || 120);
const W = 'the quiet river carried small boats beyond ancient stone bridges while travellers watched evening light settle'.split(' ');
const DOC = Array.from({ length: 14 }, (_, p) => Array.from({ length: 18 + (p % 4) * 9 }, (_, i) => W[(p * 5 + i) % W.length] + ((i % 9 === 8) ? '.' : '')).join(' ') + '.').join('\n\n');
const LOCK = () => {
  window.__lock = { on: false, refused: 0, played: 0, lastEnded: -1 };
  const oPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { const L = window.__lock;
    if (L.on && this.paused && !this.__inEnded) { L.refused++; return Promise.reject(new DOMException('locked', 'NotAllowedError')); }
    L.played++; return oPlay.call(this); };
  // 'ended' handler runs synchronously with a flag set, so play() inside it counts as "continuing playback" (iOS allows that)
  Object.defineProperty(HTMLMediaElement.prototype, 'onended', { configurable: true, get() { return this.__oe || null; }, set(f) { this.__oe = f; if (!this.__oeHooked) { this.__oeHooked = true; this.addEventListener('ended', (e) => { if (!this.__oe) return; this.__inEnded = true; try { this.__oe.call(this, e); } finally { this.__inEnded = false; } }); } } });
  window.__doLock = () => { const L = window.__lock; L.on = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const st = window.setTimeout; window.setTimeout = function () { L.timers = (L.timers || 0) + 1; return 0; }; window.setTimeout.__orig = st; window.setInterval = () => 0; window.requestAnimationFrame = () => 0;
    const OAC = window.OfflineAudioContext; if (OAC) window.OfflineAudioContext = class { constructor() {} decodeAudioData() { return new Promise(() => {}); } }; };
};
const srv = await startServer(ROOT, { latency: LAT }); let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
for (const voice of ['gtts:en-US-Chirp3-HD-Charon', 'gtts:en-US-Neural2-J']) {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((s) => localStorage.setItem('sr.settings', JSON.stringify(s)), { relayUrl: srv.url.replace(/\/$/, ''), relayToken: 't', voice, voicePicked: true, hdDefaulted: true, gDefaulted: true, wpm: 300, paraGap: 1000 });
  await p.addInitScript(LOCK);
  await p.goto(srv.url); await p.waitForTimeout(500);
  await p.click('#pasteBtn'); await p.fill('#pasteTitle', 'Lock test'); await p.fill('#pasteText', DOC); await p.click('#pasteSave'); await p.waitForTimeout(600);
  await p.click('#narrateBtn'); await p.waitForTimeout(100); await p.click('#stage'); await p.waitForTimeout(300); if (!(await p.evaluate(() => window.__sr.R.playing))) { console.log('  (stage click did not start; using play())'); await p.evaluate(() => window.__sr.play()); }
  await p.waitForTimeout(4000); console.log(await p.evaluate(() => JSON.stringify({ pl: window.__sr.R.playing, narr: window.__sr.R.narr, cur: !!window.__sr.EL.cur, paused: window.__sr.EA.paused, ct: window.__sr.EA.currentTime, src: String(window.__sr.EA.src).slice(0,30), view: document.querySelector('#readerView')?.className, words: window.__sr.R.words?.length })), errs);
  await p.waitForFunction(() => window.__sr && !window.__sr.EA.paused && window.__sr.EA.currentTime > 0.3, null, { timeout: 15000 });
  const c0 = await p.evaluate(() => window.__sr.EL.cur.w0);
  await p.evaluate(() => { window.__gaps = 0; const EA = window.__sr.EA; EA.addEventListener('ended', () => { if (EA._keep && !EA.loop) window.__gaps++; }); window.__doLock(); });
  const seen = new Set(); let stuck = 0;
  for (let s = 0; s < 120; s++) { await p.waitForTimeout(500); const st = await p.evaluate(() => ({ w0: window.__sr.EL.cur && window.__sr.EL.cur.w0, playing: window.__sr.R.playing, paused: window.__sr.EA.paused, i: window.__sr.R.i, keep: !!window.__sr.EA._keep, ct: +window.__sr.EA.currentTime.toFixed(1), dur: window.__sr.EA.duration, ready: [...window.__sr.EL.ready.keys()], L: window.__lock.refused }));
    seen.add(st.w0); if (st.paused) stuck++; if (s % 10 === 0) console.log('  ', JSON.stringify(st)); if (seen.size >= 3) break; }
  const st = await p.evaluate(() => ({ gaps: window.__gaps, i: window.__sr.R.i, playing: window.__sr.R.playing, refused: window.__lock.refused }));
  ok(seen.size >= 3, `${voice}: locked, advanced through ${seen.size - 1} chunk handoffs after chunk w0=${c0} (refused play: ${st.refused}, still playing: ${st.playing}, paused samples ${stuck})`);
  ok(st.gaps >= 1, `${voice}: ${st.gaps} paragraph pause(s) played as silence while locked`);
  ok(!errs.length, `${voice}: no page errors ${errs.join(' | ')}`);
  await b.close();
}
srv.close?.(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
