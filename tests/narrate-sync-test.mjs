// Narration sync test: drives the REAL app (narrate mode, Google HD / Neural2 / device voice) against a fake voice with known word times,
// samples the highlighted word every frame, and checks it against the word actually being spoken.
//   node tests/narrate-sync-test.mjs [appRoot]        (appRoot defaults to the repo; pass an old checkout to see the old code fail)
import { chromium } from 'playwright'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
import { startServer, synth } from './synth.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const ROOT = path.resolve(process.argv[2] || path.join(here, '..'));
const TOL = 1; // words ("about 1 word"): >=99% of frames within 1 word, every frame within 2 (the fake voice has random mid-sentence hesitations the app cannot know about)
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const LEX = 'the quiet river carried small boats beyond ancient stone bridges while travellers watched evening light settle across distant hills and farmers counted their harvest before winter arrived'.split(' ');
// 12 paragraphs of very different lengths; includes a footnote marker, _italics_, an ALL-CAPS word and an [Illustration] (all cleaned for speech)
function makeDoc() {
  const lens = [14, 40, 9, 63, 22, 31, 12, 55, 18, 27, 45, 16]; const paras = []; let c = 0;
  lens.forEach((n, pi) => { const w = []; for (let i = 0; i < n; i++) { let t = LEX[(c * 7 + i * 3 + pi) % LEX.length]; c++;
      if (i % 11 === 10) t += ','; if (i % 17 === 16 && i < n - 1) t += '.'; if (i === 4 && pi % 3 === 1) t += ' [' + (pi + 1) + ']'; if (i === 2 && pi % 4 === 0) t = '_' + t + '_'; if (i === 6 && pi === 3) t = 'NEVERTHELESS'; w.push(t); }
    w[w.length - 1] = w[w.length - 1].replace(/[,.]$/, '') + '.'; w[0] = w[0][0].toUpperCase() + w[0].slice(1); paras.push(w.join(' ')); });
  paras.splice(5, 0, '[Illustration: A drawing of the old bridge]'); return paras.join('\n\n');
}
const DOC = makeDoc();

async function openApp(srv, extra = {}, { fakeSpeech = false } = {}) {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const settings = { relayUrl: srv.url.replace(/\/$/, ''), relayToken: 't', voice: 'gtts:en-US-Chirp3-HD-Charon', voicePicked: true, hdDefaulted: true, gDefaulted: true, wpm: 300, ...extra };
  await p.addInitScript((s) => { localStorage.setItem('sr.settings', JSON.stringify(s)); }, settings);
  if (fakeSpeech) await p.addInitScript(fakeSpeechJs);
  await p.goto(srv.url); await p.waitForTimeout(500);
  await p.click('#pasteBtn'); await p.fill('#pasteTitle', 'Sync test'); await p.fill('#pasteText', DOC); await p.click('#pasteSave'); await p.waitForTimeout(600);
  return { b, p, errs };
}
// in-page recorder: one row per animation frame
const RECORDER = () => { window.__rec = { frames: [], chunks: [] }; window.__refs = []; let last = null;
  const f = () => { const c = window.__sr.EL.cur; if (c && c !== last) { last = c; window.__refs.push(c); window.__rec.chunks.push({ w0: c.w0, w1: c.w1, map: c.map || null, key: c.sp ? c.sp.map((x) => x.t).join(' ') : null, t0: performance.now() }); }
    const EA = window.__sr.EA; window.__rec.frames.push([window.__rec.chunks.length - 1, EA.currentTime, window.__sr.R.i, EA.paused || EA.seeking ? 1 : 0, performance.now(), EA.playbackRate]); requestAnimationFrame(f); }; requestAnimationFrame(f); };
async function startNarration(p) { await p.evaluate(RECORDER); await p.click('#narrateBtn'); await p.waitForTimeout(100); await p.click('#stage'); }

// expected highlighted displayed-word for chunk `ch` at media time ct
// error is measured in SPOKEN words (silent illustration / footnote tokens are skipped by design, so they don't count as words)
const spokenAt = (ch, tr, ct) => { let j = 0; for (let k = 0; k < tr.starts.length; k++) if (tr.starts[k] <= ct) j = k; else break; return j; };
const spokenOf = (ch, ri) => Math.max(0, ch.map.filter((d) => d <= ri).length - 1);
function expectedAt(ch, tr, ct) { return ch.map[spokenAt(ch, tr, ct)]; }
async function analyse(p, srv, label, { from = 0, to = 1e9, minStart = 0.0 } = {}) {
  const rec = await p.evaluate(() => window.__rec); const truth = new Map(await (await fetch(srv.url + 'truth')).json());
  // builds without explicit spoken->displayed maps (old code): chunk i is request i, words matched by letters
  const log = srv.log.filter((l) => l.chirp === (rec.chirp ?? l.chirp)); const W = await p.evaluate(() => window.__sr.R.words.map((w) => w.t)); const nz = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  rec.chunks.forEach((ch, ci) => { if (!ch.key) ch.key = srv.log[ci]?.key; if (!ch.map && ch.key) { const sp = ch.key.split(' '); ch.map = []; let j = 0; for (let k = ch.w0; k < ch.w1 && j < sp.length; k++) if (nz(W[k]) === nz(sp[j])) { ch.map.push(k); j++; } } });
  const rows = []; let worst = { e: 0 }; const per = new Map();
  for (const [ci, ct, ri, paused, now] of rec.frames) {
    if (ci < 0 || paused || ct <= 0.02 || now < from || now > to) continue; const ch = rec.chunks[ci]; const tr = truth.get(ch.key); if (!tr) continue;
    if (ri < ch.w0 - 1 || ri > ch.w1) continue; // between chunks (R.i already advanced to the next one)
    const lo = spokenAt(ch, tr, ct - 0.06), hi = spokenAt(ch, tr, ct + 0.06), rj = spokenOf(ch, ri); const e = rj < lo ? rj - lo : rj > hi ? rj - hi : 0; rows.push(e); // +-60 ms: sampler and app run in the same animation frame
     const a = per.get(ci) || { max: 0, n: 0 }; a.n++; a.max = Math.max(a.max, Math.abs(e)); per.set(ci, a); if (Math.abs(e) > Math.abs(worst.e)) worst = { e, ci, ct, ri };
  }
  const maxAbs = Math.max(0, ...rows.map(Math.abs)); const bad = rows.filter((e) => Math.abs(e) > TOL).length; const frac = rows.length ? bad / rows.length : 1;
  console.log(`  ${label}: ${rec.chunks.length} chunks, ${rows.length} frames, max |error| ${maxAbs} words, frames off by >${TOL}: ${bad}${worst.ci != null ? ` (worst: chunk ${worst.ci} @${worst.ct?.toFixed(1)}s, error ${worst.e})` : ''}`);
  if (process.env.DEBUG && worst.ci != null) { const refs = await p.evaluate(() => window.__refs.map((c) => ({ t: c.t, anchors: c.anchors, st: c.st, sp: (c.sp || []).map((x) => x.t) }))); const ch = rec.chunks[worst.ci], tr = truth.get(ch.key), rf = refs[worst.ci]; { const W = await p.evaluate(() => window.__sr.R.words.map((w) => w.t)); const exp = expectedAt(ch, tr, worst.ct); console.log('  DEBUG worst frame: app word', worst.ri, W[worst.ri], '| expected', exp, W[exp], '| chunk', ch.w0, ch.w1); }
  console.log('  DEBUG chunk', worst.ci, 'anchors', rf.anchors, 'dur', tr.dur.toFixed(1)); rf.sp.forEach((w, j) => { const d = rf.st[j] - tr.starts[j]; if (Math.abs(d) > 0.3) console.log('   ', j, w, 'truth', tr.starts[j].toFixed(2), 'app', rf.st[j].toFixed(2), 'diff', d.toFixed(2)); }); }
  console.log('  per-chunk max error: ' + [...per].map(([ci, a]) => `${rec.chunks[ci].w1 - rec.chunks[ci].w0}w:${a.max}`).join('  '));
  // boundary check: at each chunk start and each paragraph start (in the audio) the highlight must be on the right word
  const bnd = []; rec.chunks.forEach((ch, ci) => { const tr = truth.get(ch.key); if (!tr) return; const words = ch.key.split(' ');
    const pts = [[0.05, 'chunk start']]; let pi = 0; words.forEach((w, k) => { if (k && /[.”"]$/.test(words[k - 1]) && tr.starts[k] - tr.starts[k - 1] > 1.0) pts.push([tr.starts[k] + 0.12, 'para/long-pause start']); });
    for (const [ct, kind] of pts) { const exp = spokenAt(ch, tr, ct); const fr = rec.frames.filter((f) => f[0] === ci && !f[3] && Math.abs(f[1] - ct) < 0.05).pop(); if (fr) bnd.push({ kind, e: spokenOf(ch, fr[2]) - exp }); } });
  const bmax = Math.max(0, ...bnd.map((x) => Math.abs(x.e))); console.log(`  boundaries checked: ${bnd.length}, max boundary error ${bmax} words`);
  return { maxAbs, bad, frac, bmax, nb: bnd.length, rec, rows: rows.length };
}

const fakeSpeechJs = () => { // minimal speechSynthesis: speaks at a per-sentence random speed, optionally emitting word boundary events
  const w = window; w.__fake = { boundaries: true, log: [] }; let timers = [];
  w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.rate = 1; } };
  Object.defineProperty(w, 'speechSynthesis', { configurable: true, value: { getVoices: () => [], cancel() { timers.forEach(clearTimeout); timers = []; }, speak(u) { const words = [...u.text.matchAll(/\S+/g)]; const base = performance.now(); let t = 300 + 100 * Math.random(); const sp = (0.85 + 0.3 * (u.text.length % 7) / 7);
    const at = (ms, fn) => timers.push(setTimeout(fn, ms)); at(t, () => u.onstart && u.onstart({}));
    words.forEach((m) => { const L = m[0].length; if (w.__fake.boundaries) { const tt = t; at(tt, () => u.onboundary && u.onboundary({ name: 'word', charIndex: m.index })); } w.__fake.log.push({ at: base + t, w: m[0] }); t += (90 + 38 * L) * sp * (/[.,;!?]$/.test(m[0]) ? 1.5 : 1); });
    at(t + 150, () => u.onend && u.onend({})); } } });
};

(async () => {
  const only = process.env.ONLY || 'ABCD'; const onlyA = false; const srv = await startServer(ROOT); console.log('app root', ROOT, '| doc words', DOC.split(/\s+/).length);
  // ---- A. Google Chirp 3 HD (estimated word timings), 13 consecutive paragraphs, mixed chunk sizes ----
  console.log('A. Chirp 3 HD narration, 13 paragraphs');
  if (only.includes('A')) { const { b, p, errs } = await openApp(srv); await startNarration(p); await p.waitForTimeout(+process.env.A_MS || 105000);
    const r = await analyse(p, srv, 'Chirp3 HD'); const nChunks = r.rec.chunks.length;
    const paras = await p.evaluate(() => window.__sr.R.words[window.__sr.R.i].p + 1); ok(nChunks >= 4 && paras >= 10, `narrated ${paras} paragraphs in ${nChunks} chunks (ramp 150/500/1000/1500 chars)`);
    ok(r.frac <= 0.01 && r.maxAbs <= 2, `highlight within ${TOL} word of the spoken word on >=99% of frames, never >2 (off-by-more-than-1: ${(r.frac * 100).toFixed(2)}%, max ${r.maxAbs})`);
    ok(r.nb >= 10 && r.bmax <= TOL, `highlight right at ${r.nb} chunk/paragraph boundaries (max ${r.bmax})`);
    ok(errs.length === 0, 'no page errors ' + errs.join('|')); await b.close(); }
  // ---- B. pause/resume, speed change, seek (new code exposes seek/play/pause hooks) ----
  console.log('B. pause/resume, speed change, seek');
  if (only.includes('B')) { const { b, p, errs } = await openApp(srv); const has = await p.evaluate(() => !!window.__sr.seek); if (!has) console.log('  (skipped: no seek hook in this build)');
    else { await startNarration(p); await p.waitForTimeout(16000);
      const t0 = await p.evaluate(() => performance.now());
      await p.evaluate(() => window.__sr.pause()); await p.waitForTimeout(800); const riP = await p.evaluate(() => window.__sr.R.i);
      await p.evaluate(() => window.__sr.play()); await p.waitForTimeout(7000);
      await p.evaluate(() => window.__sr.setWpm(480)); await p.waitForTimeout(7000);
      const rate = await p.evaluate(() => window.__sr.EA.playbackRate); ok(rate > 1.05, 'speed change applied to the audio (playbackRate ' + rate.toFixed(2) + ')');
      const target = await p.evaluate(() => window.__sr.R.words.findIndex((w, i, a) => i > 220 && a[i - 1].p !== w.p)); // jump ahead to a paragraph start
      await p.evaluate((t) => window.__sr.seek(t), target); await p.waitForTimeout(9000);
      await p.evaluate(() => window.__sr.seek(20)); await p.waitForTimeout(9000);
      const r = await analyse(p, srv, 'pause/resume + speed + seek'); const ri = await p.evaluate(() => window.__sr.R.i);
      ok(riP > 0, 'paused mid-narration at word ' + riP);
      ok(r.frac <= 0.01 && r.maxAbs <= 2, `highlight within ${TOL} word through pause/resume, speed change and two seeks (off>1: ${(r.frac * 100).toFixed(2)}%, max ${r.maxAbs})`);
      ok(ri >= 20 && ri < 120, 'after seeking back to word 20 narration continues from there (now at ' + ri + ')'); }
    ok(errs.length === 0, 'no page errors ' + errs.join('|')); await b.close(); }
  // ---- C. exact-timestamp voice (Neural2 / ElevenLabs path): must stay in sync too ----
  console.log('C. Neural2 (exact timings)');
  if (only.includes('C')) { const { b, p, errs } = await openApp(srv, { voice: 'gtts:en-US-Neural2-J' }); await startNarration(p); await p.waitForTimeout(40000);
    const r = await analyse(p, srv, 'Neural2'); ok(r.rows > 50 && r.frac <= 0.01 && r.maxAbs <= 2, `exact voice within ${TOL} word (max ${r.maxAbs})`); ok(errs.length === 0, 'no page errors'); await b.close(); }
  // ---- D. device voice with word-boundary events, and without ----
  if (only.includes('D')) for (const boundaries of [true, false]) {
    console.log('D. device voice, boundary events ' + (boundaries ? 'on' : 'off (estimator only)'));
    const { b, p, errs } = await openApp(srv, { voice: '', relayUrl: '', relayToken: '', rate: 1 }, { fakeSpeech: true }); await p.evaluate((x) => { window.__fake.boundaries = x; }, boundaries);
    await p.evaluate(() => { window.__rec = { f: [] }; const f = () => { window.__rec.f.push([performance.now(), window.__sr.R.i]); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await p.click('#narrateBtn'); await p.waitForTimeout(100); await p.click('#stage'); await p.waitForTimeout(30000);
    const out = await p.evaluate(() => ({ f: window.__rec.f, log: window.__fake.log, words: window.__sr.R.words.map((w) => w.t), i: window.__sr.R.i }));
    // expected: the last word the fake voice has started; app: the highlighted word, both as indices into the SPOKEN word list
    const nz = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''); const dmap = []; let j = 0; for (let k = 0; k < out.words.length && j < out.log.length; k++) if (nz(out.words[k]) === nz(out.log[j].w)) { dmap.push(k); j++; }
    const errs2 = []; for (const [now, ri] of out.f) { if (now < out.log[0].at + 100) continue; let e = -1; for (let q = 0; q < out.log.length; q++) if (out.log[q].at <= now) e = q; else break; if (e < 0 || e >= out.log.length - 1) continue; let lo = -1, hi = -1; for (let q = 0; q < out.log.length; q++) { if (out.log[q].at <= now - 60) lo = q; if (out.log[q].at <= now + 60) hi = q; } const a = dmap.filter((d) => d <= ri).length - 1; errs2.push(a < lo ? a - lo : a > hi ? a - hi : 0); }
    const mx = Math.max(0, ...errs2.map(Math.abs)), mean = errs2.reduce((s2, x) => s2 + Math.abs(x), 0) / Math.max(1, errs2.length), off1 = errs2.filter((x) => Math.abs(x) > 1).length / Math.max(1, errs2.length);
    console.log(`  device voice: ${errs2.length} frames, max |error| ${mx} words, mean |error| ${mean.toFixed(2)}, frames off by >1: ${(off1 * 100).toFixed(1)}%`);
    if (boundaries) ok(off1 <= 0.01 && mx <= 2, 'with boundary events the highlight tracks every word (off>1: ' + (off1 * 100).toFixed(1) + '%, max ' + mx + ')');
    else ok(mx <= 5 && mean <= 1.5, 'without boundary events the estimator stays bounded and re-anchors each sentence (max ' + mx + ', mean ' + mean.toFixed(2) + ')');
    ok(out.i > 40, 'device narration advanced to word ' + out.i); ok(errs.length === 0, 'no page errors ' + errs.join('|')); await b.close(); }
  srv.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
