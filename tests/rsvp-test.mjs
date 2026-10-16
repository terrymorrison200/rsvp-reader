// RSVP display test (v26): pivot letter choice, pivot pinned at the exact center, guide ticks centered, shrink-to-fit, timing.
//   node tests/rsvp-test.mjs [--shots dir]       (uses Playwright's chromium, or system Chrome if that is what is installed)
import { chromium } from 'playwright'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null; if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/json' };
const srv = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith(path.sep)) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
await new Promise((r) => srv.listen(0, r)); const URL_ = `http://localhost:${srv.address().port}/`;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: 'chrome' }); }

// [word, expected pivot letter]
const CASES = [['I', 'I'], ['a', 'a'], ['of', 'f'], ['“Hello,”', 'e'], ['(the)', 'h'], ['quick', 'u'], ['"Hunger,"', 'n'], ['Strange', 'r'], ['“Wonderful!”', 'n'], ['beautiful.', 'a'], ['understand,', 'e'],
  ['“Extraordinary,”', 'r'], ['unbelievable', 'e'], ['—"Responsibilities…"', 'o'], ['internationalization', 'r'], ['Internationalization.', 'r'], ['well-known', 'l'], ['don’t', 'o'], ['1984', '9'], ['$1,250,000.', '5'], ['NEVERTHELESS', 'E'], ['antidisestablishmentarianism', 'd'], ['...', '.']];
// independent reference implementation of the rule
const refIdx = (w) => { const ls = [...w.matchAll(/[\p{L}\p{N}]/gu)].map((m) => m.index); if (!ls.length) return w.search(/\S/); const L = ls.length; return ls[L <= 1 ? 0 : L <= 5 ? 1 : L <= 9 ? 2 : L <= 13 ? 3 : 4]; };

async function open(vp, extra = {}) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((s) => localStorage.setItem('sr.settings', JSON.stringify(s)), { wpm: 300, ...extra });
  await p.goto(URL_); await p.waitForTimeout(500);
  await p.click('#pasteBtn'); await p.fill('#pasteTitle', 'RSVP test'); await p.fill('#pasteText', 'Hello there world. Second sentence, with commas; and more!\n\nNew paragraph here.'); await p.click('#pasteSave'); await p.waitForTimeout(600);
  return { p, ctx, errs };
}
const setWord = (p, t) => p.evaluate((t) => { const r = __sr.R; r.words = [{ t, s: 0, p: 0, end: 0 }, { t: 'next', s: 0, p: 0, end: 3 }]; r.i = 0; __sr.render(); }, t);
const measure = (p) => p.evaluate(() => { const c = (e) => { const r = document.querySelector(e).getBoundingClientRect(); return { l: r.left, r: r.right, c: r.left + r.width / 2, t: r.top, b: r.bottom }; };
  const box = c('#rsvp'); return { box, orp: c('#wOrp'), pre: c('#wPre'), post: c('#wPost'), gt: c('.guide.top'), gb: c('.guide.bottom'), pivot: document.querySelector('#wOrp').textContent, text: document.querySelector('#wPre').textContent + document.querySelector('#wOrp').textContent + document.querySelector('#wPost').textContent,
    fs: parseFloat(getComputedStyle(document.querySelector('#word')).fontSize), color: getComputedStyle(document.querySelector('#wOrp')).color, vw: innerWidth }; });

for (const [name, vp] of [['portrait 390x844', { width: 390, height: 844 }], ['landscape 844x390', { width: 844, height: 390 }], ['small 320x568', { width: 320, height: 568 }]]) {
  for (const font of ['inter', 'literata', 'mono']) for (const size of [28, 56, 96]) {
    const { p, ctx, errs } = await open(vp, { font, size }); let bad = [];
    for (const [w, exp] of CASES) {
      await setWord(p, w); const m = await measure(p);
      if (m.text !== w) bad.push(`text ${w}`);
      if (m.pivot !== exp) bad.push(`pivot ${w}: got ${m.pivot} want ${exp}`);
      if (w[refIdx(w)] !== m.pivot) bad.push(`ref ${w}`);
      if (Math.abs(m.orp.c - m.box.c) > 1) bad.push(`center ${w}: ${m.orp.c.toFixed(2)} vs ${m.box.c.toFixed(2)}`);
      if (Math.abs(m.gt.c - m.orp.c) > 1 || Math.abs(m.gb.c - m.orp.c) > 1) bad.push(`guide ${w}`);
      if (m.pre.l < -0.5 || m.post.r > m.vw + 0.5) bad.push(`overflow ${w}: ${m.pre.l.toFixed(1)}..${m.post.r.toFixed(1)}`);
    }
    ok(!bad.length && !errs.length, `${name} ${font} ${size}px: ${CASES.length} words pivot/center/guides/fit` + (bad.length ? ' :: ' + bad.slice(0, 4).join(' | ') + ' ' + errs.join(';') : '')); await ctx.close();
  }
}
// shrink: a 28-letter word must shrink on a phone at big size, and not at a size where it fits
{ const { p, ctx } = await open({ width: 390, height: 844 }, { size: 56 }); await setWord(p, 'antidisestablishmentarianism'); const a = await measure(p); await setWord(p, 'cat'); const c = await measure(p);
  ok(a.fs < c.fs && c.fs >= 51, `long word shrinks (${a.fs.toFixed(1)}px) while short word keeps size (${c.fs.toFixed(1)}px)`); await ctx.close(); }
// multi-word chunk mode keeps the middle word's pivot centered
{ const { p, ctx } = await open({ width: 390, height: 844 }, { chunk: 3 }); await p.evaluate(() => { const r = __sr.R; r.words = ['the', 'wonderful', 'dog'].map((t) => ({ t, s: 0, p: 0, end: 0 })); r.i = 0; __sr.render(); }); const m = await measure(p);
  ok(m.pivot === 'n' && Math.abs(m.orp.c - m.box.c) <= 1, `chunk=3 pivot "${m.pivot}" centered (${(m.orp.c - m.box.c).toFixed(2)}px)`); await ctx.close(); }
// pivot readable in each theme (red vs background contrast >= 3:1: large text)
{ const lum = (c) => { const v = c.match(/\d+/g).slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  for (const theme of ['dark', 'oled', 'light', 'sepia']) { const { p, ctx } = await open({ width: 390, height: 844 }, { theme }); await setWord(p, 'Reading'); const [col, bg] = await p.evaluate(() => [getComputedStyle(document.querySelector('#wOrp')).color, getComputedStyle(document.body).backgroundColor]);
    const [a, c] = [lum(col), lum(bg)].sort((x, y) => y - x); const cr = (a + 0.05) / (c + 0.05); ok(cr >= 3, `${theme}: pivot ${col} on ${bg} contrast ${cr.toFixed(2)}:1`); await ctx.close(); } }

// v26 guide ticks: real elements, nonzero size, centered on the pivot, and VISIBLE (real rendered pixels differ from the background) in every theme
{ const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = (c) => { const v = [c.r, c.g, c.b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (x, y) => { const [a, c] = [lum(x), lum(y)].sort((m, n) => n - m); return (a + 0.05) / (c + 0.05); };
  for (const theme of ['dark', 'oled', 'light', 'sepia']) for (const dpr of [2, 3]) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript((s) => localStorage.setItem('sr.settings', JSON.stringify(s)), { wpm: 300, theme });
    await p.goto(URL_); await p.waitForTimeout(500); await p.click('#pasteBtn'); await p.fill('#pasteTitle', 'g'); await p.fill('#pasteText', 'Hello there world. More text here.'); await p.click('#pasteSave'); await p.waitForTimeout(600);
    await setWord(p, 'Reading'); await p.evaluate(() => { document.querySelector('#readerView').classList.add('reading'); }); await p.waitForTimeout(700);
    const g = await p.evaluate(() => { const o = {}; const bg = getComputedStyle(document.body).backgroundColor; o.bg = bg; o.gs = getComputedStyle(document.documentElement).getPropertyValue('--guide');
      for (const k of ['top', 'bottom']) { const e = document.querySelector('.guide.' + k); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hit = document.elementFromPoint(cx, cy);
        o[k] = { w: r.width, h: r.height, l: r.left, t: r.top, b: r.bottom, cx, cy, color: cs.backgroundColor, op: parseFloat(cs.opacity), disp: cs.display, vis: cs.visibility, hit: hit === e, tag: e.tagName, parentOk: e.parentElement.id === 'rsvp' }; }
      const o2 = document.querySelector('#wOrp').getBoundingClientRect(); o.pivotC = o2.left + o2.width / 2; o.pivotM = (o2.top + o2.bottom) / 2; o.fs = parseFloat(getComputedStyle(document.querySelector('#word')).fontSize);
      for (const k of ['top', 'bottom']) { const e = document.querySelector('.gline.' + k); const r = e.getBoundingClientRect(); o['line' + k] = { w: r.width, h: r.height, disp: getComputedStyle(e).display }; }
      return o; });
    const bgc = parse(g.bg); const fail = [];
    for (const k of ['top', 'bottom']) { const t = g[k], c = parse(t.color);
      if (!(t.w >= 1.5 && t.h >= 18 && t.h <= 24)) fail.push(`${k} size ${t.w}x${t.h}`);
      if (t.disp === 'none' || t.vis !== 'visible' || t.op < 1) fail.push(`${k} hidden ${t.disp}/${t.vis}/${t.op}`);
      if (!t.hit || t.tag !== 'DIV' || !t.parentOk) fail.push(`${k} not top-most real element`);
      if (Math.abs(t.cx - g.pivotC) > 0.6) fail.push(`${k} off pivot ${(t.cx - g.pivotC).toFixed(2)}`);
      const eff = { r: c.r * c.a + bgc.r * (1 - c.a), g: c.g * c.a + bgc.g * (1 - c.a), b: c.b * c.a + bgc.b * (1 - c.a) }; const cr = ratio(eff, bgc); if (cr < 2.5) fail.push(`${k} contrast ${cr.toFixed(2)}`); t.cr = cr; }
    if (!(g.top.b < g.pivotM - 0.4 * g.fs && g.bottom.t > g.pivotM + 0.4 * g.fs)) fail.push('ticks not above/below word');
    if (g.linetop.h < 1 || g.linetop.w < 100) fail.push('hairline size');
    // real pixels: screenshot, sample the tick centre vs a pixel 8px to the left of it
    const png = (await p.screenshot()).toString('base64');
    const px = await p.evaluate(async ({ png, pts, dpr }) => { const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode(); const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0);
      return pts.map(([x, y]) => { const d = cx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data; const l = cx.getImageData(Math.round((x - 8) * dpr), Math.round(y * dpr), 1, 1).data; return [[d[0], d[1], d[2]], [l[0], l[1], l[2]]]; }); }, { png, pts: [[g.top.cx, g.top.cy], [g.bottom.cx, g.bottom.cy]], dpr });
    px.forEach(([on, off], i) => { const cr = ratio({ r: on[0], g: on[1], b: on[2] }, { r: off[0], g: off[1], b: off[2] }); if (cr < 2) fail.push(`pixel ${i ? 'bottom' : 'top'} tick ${on} vs bg ${off} contrast ${cr.toFixed(2)}`); });
    ok(!fail.length && !errs.length, `${theme} @${dpr}x guides: ticks ${g.top.w}x${g.top.h.toFixed(0)} ${g.top.color} on ${g.bg}, contrast ${g.top.cr.toFixed(1)}:1, rendered pixel ${px[0][0]} vs bg ${px[0][1]}` + (fail.length ? ' :: ' + fail.join(' | ') + errs.join(';') : '')); await ctx.close(); }
  // guides can be turned off in settings
  { const { p, ctx } = await open({ width: 390, height: 844 }, { guides: false }); const d = await p.evaluate(() => getComputedStyle(document.querySelector('.guide.top')).display); ok(d === 'none', 'Guide marks setting off hides ticks'); await ctx.close(); } }
// app/sw versioning: cache name == app version, CSS/JS precached and cache-busted, shell fetched past the HTTP cache
{ const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const v = app.match(/APP_VER = '(v\d+)'/)[1], cn = sw.match(/const V='swiftread-(v\d+)'/)[1]; const assets = sw.match(/ASSETS=\[(.*?)\]/)[1];
  ok(v === cn, `app ${v} == sw cache swiftread-${cn}`); ok(/'styles\.css'/.test(assets) && /'app\.js'/.test(assets) && /'index\.html'/.test(assets), 'CSS/JS/HTML in precache list');
  ok(html.includes(`styles.css?v=${v.slice(1)}`) && html.includes(`app.js?v=${v.slice(1)}`), 'index.html links versioned CSS/JS'); ok(/cache:'reload'/.test(sw), 'sw bypasses HTTP cache for shell'); }

// timing
{ const { p, ctx } = await open({ width: 390, height: 844 }, { wpm: 300, smart: true, ramp: false });
  const T = await p.evaluate(() => { const tk = __sr.tokenize; const one = (s) => { const w = tk(s); __sr.R.rampN = 99; return { m: __sr.wordMult(w[0]), ms: __sr.delayFor([w[0]]) }; };
    const mid = (s) => { const w = tk(s); return __sr.wordMult(w[0]); }; // first word of a multi-word string (no end of para)
    __sr.S.smart = true; __sr.S.ramp = false;
    return { plain: mid('cat dog'), six: mid('simple dog'), nine: mid('wonderful dog'), twelve: mid('abcdefghijkl dog'), long30: mid('abcdefghijklmnopqrstuvwxyzabcd dog'), comma: mid('cat, dog'), semi: mid('cat; dog'), period: mid('cat. Dog'), bang: mid('cat! Dog'), q: mid('“cat?” Dog'), para: one('cat').m, paraMs: one('cat').ms, quote: mid('“cat” dog'), num: mid('1984 dog'), hy: mid('well-known dog'), caps: mid('NEVERTHELESS dog') }; });
  const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
  ok(near(T.plain, 1) && near(T.six, 1), `short/6-letter words x1.00 (${T.plain}, ${T.six})`);
  ok(near(T.nine, 1.45) && T.twelve > T.nine && near(T.long30, 1 + 0.9), `long words slower, capped (9:${T.nine.toFixed(2)} 12:${T.twelve.toFixed(2)} 30:${T.long30.toFixed(2)})`);
  ok(near(T.comma, 1.3) && near(T.semi, 1.3), `comma/semicolon x1.3 (${T.comma}, ${T.semi})`);
  ok(near(T.period, 1.75) && near(T.bang, 1.75) && near(T.q, 1.75), `. ! ? (incl. closing quote) x1.75 (${T.period}, ${T.bang}, ${T.q})`);
  ok(near(T.para, 2.3) && near(T.paraMs, 2.3 * 200), `paragraph end x2.3 and ms = 200*2.3 at 300 wpm (${T.para}, ${T.paraMs})`);
  ok(near(T.quote, 1) && near(T.num, 1.2) && T.hy > 1.2 && T.caps > 1.5, `quote-only x1, number +0.2 (${T.num}), hyphenated (${T.hy.toFixed(2)}), ALL CAPS long (${T.caps.toFixed(2)})`);
  // wpm respected, smart off => flat, ramp unchanged
  const W = await p.evaluate(() => { const w = __sr.tokenize('extraordinary, dog'); const out = {}; for (const wpm of [150, 300, 600]) { __sr.S.wpm = wpm; __sr.S.smart = true; __sr.R.rampN = 99; out['s' + wpm] = __sr.delayFor([w[0]]); __sr.S.smart = false; out['f' + wpm] = __sr.delayFor([w[0]]); } return out; });
  ok(near(W.f300, 200, 0.001) && near(W.f150, 400, 0.001) && near(W.f600, 100, 0.001), 'smart off: flat 60000/wpm');
  ok(near(W.s150 / W.s300, 2, 0.001) && near(W.s300 / W.s600, 2, 0.001) && W.s300 > W.f300, `smart on scales with wpm (${W.s150.toFixed(0)}/${W.s300.toFixed(0)}/${W.s600.toFixed(0)} ms)`);
  // real playback: advance timing of an actual tick sequence follows multipliers
  const real = await p.evaluate(async () => { __sr.S.smart = true; __sr.S.ramp = false; __sr.S.wpm = 1000; __sr.S.chunk = 1; const r = __sr.R; __sr.seek(0, false); const exp = r.words.map((w) => 60 * __sr.wordMult(w)); const seen = []; let t0 = performance.now(); __sr.play(); let last = 0;
    await new Promise((res) => { const iv = setInterval(() => { if (r.i !== last) { seen.push(performance.now() - t0); t0 = performance.now(); last = r.i; } if (!r.playing || seen.length >= 8) { clearInterval(iv); res(); } }, 4); }); __sr.pause(); return { exp, seen }; });
  const okReal = real.seen.length >= 6 && real.seen.slice(0, 6).every((d, k) => Math.abs(d - real.exp[k]) < 40);
  ok(okReal, `live playback delays ≈ expected (exp ${real.exp.slice(0, 6).map((x) => x.toFixed(0))} got ${real.seen.slice(0, 6).map((x) => x.toFixed(0))})`); await ctx.close(); }

// screenshots (phone viewport)
if (shotsDir) {
  const shots = [['portrait', { width: 390, height: 844 }, 'dark', 'a'], ['portrait', { width: 390, height: 844 }, 'dark', '“Hello,”'], ['portrait', { width: 390, height: 844 }, 'dark', 'understand,'], ['portrait', { width: 390, height: 844 }, 'light', 'Extraordinary.'], ['portrait', { width: 390, height: 844 }, 'dark', 'antidisestablishmentarianism'], ['landscape', { width: 844, height: 390 }, 'dark', '(Responsibilities…)'], ['portrait', { width: 390, height: 844 }, 'sepia', 'NEVERTHELESS']];
  let n = 0; for (const [o, vp, theme, w] of shots) { const { p, ctx } = await open(vp, { theme }); await setWord(p, w); await p.evaluate(() => { document.querySelector('#contextBox').style.display = 'none'; document.querySelector('#readerView').classList.add('reading'); }); await p.waitForTimeout(600); const f = path.join(shotsDir, `rsvp-v26-${++n}-${o}-${theme}.png`); await p.screenshot({ path: f }); console.log('shot', f); await ctx.close(); }
}
await b.close(); srv.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
