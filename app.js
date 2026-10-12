// Swift Read — local-first RSVP reader
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- IndexedDB ---------------- */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('swiftread', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('docs', { keyPath: 'id' });
    d.createObjectStore('meta', { keyPath: 'id' });
    const h = d.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true });
    h.createIndex('doc', 'docId');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const s = t.objectStore(store);
  const out = fn(s); t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error);
});
const idb = {
  get: (st, k) => tx(st, 'readonly', (s) => s.get(k)),
  all: (st) => tx(st, 'readonly', (s) => s.getAll()),
  put: (st, v) => tx(st, 'readwrite', (s) => s.put(v)),
  del: (st, k) => tx(st, 'readwrite', (s) => s.delete(k)),
  byDoc: (docId) => tx('highlights', 'readonly', (s) => s.index('doc').getAll(docId)),
};

/* ---------------- Settings ---------------- */
const DEF = { theme: 'dark', font: 'inter', size: 56, chunk: 1, color: '#ff4d4d', guides: true, ramp: true, smart: true, wpm: 300, voice: '', rate: 1 };
const S = Object.assign({}, DEF, JSON.parse(localStorage.getItem('sr.settings') || '{}'));
const saveS = () => localStorage.setItem('sr.settings', JSON.stringify(S));
const FONTS = { inter: 'Inter,system-ui,sans-serif', literata: 'Literata,Georgia,serif', mono: 'JBMono,ui-monospace,monospace', dyslexic: 'OpenDyslexic,Inter,sans-serif' };
function applySettings() {
  document.body.dataset.theme = S.theme;
  const r = document.documentElement.style;
  r.setProperty('--focus', S.color);
  r.setProperty('--word-size', Math.min(S.size, Math.floor(innerWidth / 7.5)) + 'px');
  r.setProperty('--word-font', FONTS[S.font]);
  document.querySelector('meta[name=theme-color]').content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#0f1115';
  $('#rsvp').classList.toggle('show-guides', S.guides);
  const segOn = (id, v) => $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v == v));
  segOn('themeSeg', S.theme); segOn('fontSeg', S.font); segOn('chunkSeg', S.chunk);
  $$('#colorRow button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.color));
  $('#colorIn').value = S.color; $('#sizeIn').value = S.size; $('#sizeVal').textContent = S.size + 'px';
  $('#guidesIn').checked = S.guides; $('#rampIn').checked = S.ramp; $('#smartIn').checked = S.smart;
  $('#rateIn').value = S.rate; $('#rateVal').textContent = S.rate.toFixed(1) + '×';
  setWpm(S.wpm, false);
  if (R.words.length) render();
}

/* ---------------- Text processing ---------------- */
function tokenize(text) {
  // returns words [{t, s (sentence idx), p (para idx), end: 0|1 comma|2 sentence|3 para}]
  const words = []; const paras = text.split(/\n\s*\n+/);
  let s = 0, p = 0;
  for (const para of paras) {
    const toks = para.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!toks.length) continue;
    toks.forEach((t, i) => {
      let end = 0;
      if (/[.!?…]["'”’)\]]*$/.test(t) && !/^(Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e)\.$/i.test(t)) end = 2;
      else if (/[,;:—–-]["'”’)]*$/.test(t)) end = 1;
      if (i === toks.length - 1) end = 3;
      words.push({ t, s, p, end });
      if (end >= 2) s++;
    });
    p++;
  }
  return words;
}
function orpIndex(w) {
  const core = w.replace(/^[^\p{L}\p{N}]+/u, ''); const lead = w.length - core.length;
  const L = core.replace(/[^\p{L}\p{N}]+$/u, '').length;
  const i = L <= 1 ? 0 : L <= 5 ? 1 : L <= 9 ? 2 : L <= 13 ? 3 : 4;
  return Math.min(lead + i, w.length - 1);
}
function mdToText(md) {
  const chapters = []; const lines = md.replace(/\r/g, '').split('\n'); const out = [];
  for (let l of lines) {
    const h = l.match(/^#{1,3}\s+(.*)/);
    if (h) { chapters.push({ title: h[1].trim(), para: out.length }); out.push('', h[1].trim(), ''); continue; }
    l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~]{1,3}/g, '').replace(/^\s*[-*+>]\s+/, '').replace(/^\s*\d+\.\s+/, '');
    out.push(l);
  }
  return { text: out.join('\n'), chapters };
}
function htmlToParas(html) {
  const doc = new DOMParser().parseFromString(html, html.trim().startsWith('<?xml') ? 'application/xhtml+xml' : 'text/html');
  const body = doc.body || doc.documentElement;
  body.querySelectorAll('script,style,nav,noscript,svg').forEach((e) => e.remove());
  const paras = []; let heading = null;
  const blocks = body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td');
  if (!blocks.length) return { paras: [body.textContent.trim()], heading };
  blocks.forEach((b) => {
    if (b.querySelector('p,div,li,blockquote,h1,h2,h3,h4,h5,h6,td')) return; // leaf blocks only
    const t = b.textContent.replace(/\s+/g, ' ').trim(); if (!t) return;
    if (!heading && /^H[1-3]$/.test(b.tagName)) heading = t;
    paras.push(t);
  });
  return { paras, heading };
}
function chaptersToWordIdx(text, chapters) {
  // chapters carry para index -> convert to word index via tokenize
  const words = tokenize(text); const res = [];
  for (const c of chapters) { const i = words.findIndex((w) => w.p >= c.paraIdx); if (i >= 0) res.push({ title: c.title, word: i }); }
  return res;
}

/* ---------------- Importers ---------------- */
async function importFile(file) {
  const name = file.name.replace(/\.[^.]+$/, ''); const ext = (file.name.split('.').pop() || '').toLowerCase();
  showLoading('Importing ' + file.name + '…');
  try {
    let doc;
    if (ext === 'epub') doc = await parseEpub(file);
    else if (ext === 'pdf' || file.type === 'application/pdf') doc = await parsePdf(file);
    else {
      const raw = await file.text();
      if (ext === 'html' || ext === 'htm') { const { paras, heading } = htmlToParas(raw); doc = { title: heading || name, text: paras.join('\n\n'), chapters: [] }; }
      else if (ext === 'md' || ext === 'markdown') { const { text, chapters } = mdToText(raw); doc = { title: name, text, chapters: [] };
        // convert md chapters (line-based) by locating headings in paragraph list
        const paras = text.split(/\n\s*\n+/).filter((p) => p.trim()); doc.chapters = chapters.map((c) => ({ title: c.title, paraIdx: paras.findIndex((p) => p.trim() === c.title) })).filter((c) => c.paraIdx >= 0); }
      else doc = { title: name, text: raw.replace(/\r/g, ''), chapters: [] };
      doc.title = doc.title || name;
    }
    doc.type = ext || 'txt';
    if (!doc.title) doc.title = name;
    const id = await addDoc(doc);
    hideLoading(); openDoc(id);
  } catch (e) { console.error(e); hideLoading(); toast('Could not import: ' + (e.message || e)); }
}
async function parsePdf(file) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const paras = []; const pageStarts = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    $('#loadingText').textContent = `Reading page ${n} of ${pdf.numPages}…`;
    const page = await pdf.getPage(n); const tc = await page.getTextContent();
    pageStarts.push(paras.length);
    let cur = '', lastY = null, lastH = 12;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5]; const h = it.height || lastH;
      if (lastY !== null && Math.abs(lastY - y) > h * 1.8 && cur.trim()) { paras.push(cur.trim()); cur = ''; }
      cur += it.str + (it.hasEOL ? ' ' : '');
      if (it.str.trim()) { lastY = y; lastH = h; }
    }
    if (cur.trim()) paras.push(cur.trim());
  }
  const text = paras.map((p) => p.replace(/(\w)- (\w)/g, '$1$2')).join('\n\n');
  let chapters = [];
  try {
    const outline = await pdf.getOutline();
    if (outline) for (const o of outline.slice(0, 200)) {
      let dest = o.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!dest) continue; const pi = await pdf.getPageIndex(dest[0]);
      chapters.push({ title: o.title, paraIdx: pageStarts[pi] ?? 0 });
    }
  } catch {}
  if (!chapters.length && pdf.numPages > 1) chapters = pageStarts.map((p, i) => ({ title: 'Page ' + (i + 1), paraIdx: p }));
  const meta = await pdf.getMetadata().catch(() => null);
  return { title: meta?.info?.Title?.trim() || file.name.replace(/\.pdf$/i, ''), text, chapters };
}
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const base = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
  const opf = xml(await zip.file(opfPath).async('string'));
  const title = opf.getElementsByTagName('dc:title')[0]?.textContent || opf.querySelector('title')?.textContent;
  const manifest = {}; opf.querySelectorAll('manifest > item').forEach((i) => (manifest[i.getAttribute('id')] = { href: i.getAttribute('href'), type: i.getAttribute('media-type'), props: i.getAttribute('properties') || '' }));
  const resolve = (b, h) => { const parts = (b + decodeURIComponent(h.split('#')[0])).split('/'); const out = []; for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); } return out.join('/'); };
  // toc titles
  const tocTitles = {};
  try {
    const navItem = Object.values(manifest).find((m) => m.props.includes('nav'));
    const ncxItem = Object.values(manifest).find((m) => m.type === 'application/x-dtbncx+xml');
    if (navItem) {
      const p = resolve(base, navItem.href); const nb = p.replace(/[^/]+$/, '');
      const nd = new DOMParser().parseFromString(await zip.file(p).async('string'), 'text/html');
      nd.querySelectorAll('nav a[href]').forEach((a) => { const k = resolve(nb, a.getAttribute('href')); if (!tocTitles[k]) tocTitles[k] = a.textContent.trim(); });
    } else if (ncxItem) {
      const p = resolve(base, ncxItem.href); const nb = p.replace(/[^/]+$/, '');
      const nd = xml(await zip.file(p).async('string'));
      nd.querySelectorAll('navPoint').forEach((np) => { const k = resolve(nb, np.querySelector('content').getAttribute('src')); if (!tocTitles[k]) tocTitles[k] = np.querySelector('navLabel text')?.textContent.trim(); });
    }
  } catch (e) { console.warn('toc', e); }
  const paras = []; const chapters = []; const spine = [...opf.querySelectorAll('spine > itemref')];
  for (let i = 0; i < spine.length; i++) {
    const m = manifest[spine[i].getAttribute('idref')]; if (!m) continue;
    const path = resolve(base, m.href); const f = zip.file(path); if (!f) continue;
    $('#loadingText').textContent = `Reading section ${i + 1} of ${spine.length}…`;
    const { paras: ps, heading } = htmlToParas(await f.async('string'));
    if (!ps.length) continue;
    const t = tocTitles[path] || heading;
    if (t || ps.join(' ').split(' ').length > 40) chapters.push({ title: t || `Section ${chapters.length + 1}`, paraIdx: paras.length });
    paras.push(...ps);
  }
  return { title: title?.trim() || file.name, text: paras.join('\n\n'), chapters };
}
async function addDoc(doc) {
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const words = tokenize(doc.text);
  if (!words.length) throw new Error('no readable text found');
  const chapters = (doc.chapters || []).map((c) => ({ title: c.title, word: Math.max(0, words.findIndex((w) => w.p >= c.paraIdx)) }));
  await idb.put('docs', { id, text: doc.text, chapters });
  await idb.put('meta', { id, title: doc.title, type: doc.type, count: words.length, pos: 0, added: Date.now(), opened: Date.now() });
  return id;
}

/* ---------------- Library ---------------- */
async function renderLibrary() {
  const metas = (await idb.all('meta')).sort((a, b) => b.opened - a.opened);
  $('#libEmpty').style.display = metas.length ? 'none' : '';
  $('#libList').innerHTML = '';
  metas.forEach((m, i) => {
    const li = document.createElement('li'); li.className = 'lib-item'; li.style.animationDelay = i * 30 + 'ms';
    const pct = m.count ? Math.round((m.pos / Math.max(1, m.count - 1)) * 100) : 0;
    const mins = Math.max(1, Math.round((m.count - m.pos) / S.wpm));
    li.innerHTML = `<div class="lib-badge">${(m.type || 'TXT').toUpperCase().slice(0, 4)}</div>
      <div class="lib-info"><div class="lib-title"></div><div class="lib-meta">${m.count.toLocaleString()} words · ${pct >= 100 ? 'Finished' : pct + '% · ' + mins + ' min left'}</div><div class="lib-bar"><i style="width:${pct}%"></i></div></div>
      <button class="icon-btn lib-del" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>`;
    li.querySelector('.lib-title').textContent = m.title;
    li.onclick = (e) => { if (e.target.closest('.lib-del')) return; openDoc(m.id); };
    li.querySelector('.lib-del').onclick = async () => {
      if (!confirm(`Remove “${m.title}” from your library?`)) return;
      await idb.del('docs', m.id); await idb.del('meta', m.id);
      for (const h of await idb.byDoc(m.id)) await idb.del('highlights', h.id);
      renderLibrary();
    };
    $('#libList').appendChild(li);
  });
}

/* ---------------- Reader state ---------------- */
const R = { id: null, meta: null, words: [], chapters: [], sentStart: [], i: 0, playing: false, timer: null, rampN: 0, narr: false, lastSave: 0, sessionStart: 0, sessionWords: 0 };

async function openDoc(id) {
  const [doc, meta] = await Promise.all([idb.get('docs', id), idb.get('meta', id)]);
  if (!doc) return;
  R.id = id; R.meta = meta; R.words = tokenize(doc.text); R.chapters = doc.chapters || [];
  R.sentStart = []; R.words.forEach((w, i) => { if (!i || w.s !== R.words[i - 1].s) R.sentStart[w.s] = i; });
  R.i = Math.min(meta.pos || 0, R.words.length - 1);
  if (R.i >= R.words.length - 1) R.i = 0;
  meta.opened = Date.now(); idb.put('meta', meta);
  $('#docTitle').textContent = meta.title;
  $('#chaptersBtn').style.display = R.chapters.length > 1 ? '' : 'none';
  showView('readerView');
  history.pushState({ v: 'reader' }, '');
  render(); showContext();
  $('#tapHint').textContent = R.i > 0 ? 'Tap to resume' : 'Tap to play';
}
function showView(id) { $$('.view').forEach((v) => v.classList.toggle('active', v.id === id)); }
async function closeReader() {
  pause(); await savePos(true); showView('libraryView'); renderLibrary();
}

function chunkAt(i) { const n = S.chunk; const out = [R.words[i]]; for (let k = 1; k < n && i + k < R.words.length; k++) { if (R.words[i + k - 1].end >= 2) break; out.push(R.words[i + k]); } return out; }
function render() {
  const w = R.words[R.i]; if (!w) return;
  const chunk = chunkAt(R.i);
  let text, oi;
  if (chunk.length === 1) { text = w.t; oi = orpIndex(text); }
  else { const mid = Math.floor((chunk.length - 1) / 2); const before = chunk.slice(0, mid).map((x) => x.t).join(' '); text = chunk.map((x) => x.t).join(' '); oi = (before ? before.length + 1 : 0) + orpIndex(chunk[mid].t); }
  $('#wPre').textContent = text.slice(0, oi); $('#wOrp').textContent = text[oi] || ''; $('#wPost').textContent = text.slice(oi + 1);
  const half = $('#wOrp').getBoundingClientRect().width / 2;
  $('#word').style.setProperty('--orp-half', half + 'px');
  updateProgress();
}
function updateProgress() {
  const n = R.words.length; const pct = n > 1 ? R.i / (n - 1) : 0;
  const pr = $('#progress'); if (!pr.matches(':active')) pr.value = Math.round(pct * 1000);
  pr.style.setProperty('--fill', pct * 100 + '%');
  $('#posLabel').textContent = Math.round(pct * 100) + '%';
  const secs = Math.round(((n - R.i) / S.wpm) * 60 * (S.smart ? 1.12 : 1));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  $('#remainLabel').textContent = (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function delayFor(chunk) {
  let ms = (60000 / S.wpm) * chunk.length;
  if (S.smart) {
    const last = chunk[chunk.length - 1]; const len = Math.max(...chunk.map((c) => c.t.length));
    if (last.end === 3) ms *= 2.6; else if (last.end === 2) ms *= 2.0; else if (last.end === 1) ms *= 1.4;
    if (len > 8) ms *= 1 + Math.min(0.6, (len - 8) * 0.07);
    if (/\d/.test(last.t)) ms *= 1.2;
  }
  if (S.ramp && R.rampN < 12) { ms *= 1 + (12 - R.rampN) * 0.06; R.rampN++; }
  return ms;
}
function tick() {
  const chunk = chunkAt(R.i);
  R.timer = setTimeout(() => {
    countWords(chunk.length);
    if (R.i + chunk.length >= R.words.length) { R.i = R.words.length - 1; render(); pause(); toast('Finished ✨'); return; }
    R.i += chunk.length; render(); savePos(); tick();
  }, delayFor(chunk));
}
function play() {
  if (R.playing || !R.words.length) return;
  if (R.i >= R.words.length - 1) R.i = 0;
  R.playing = true; R.rampN = 0; R.sessionStart = performance.now();
  document.body.classList.add('playing'); $('#readerView').classList.add('reading'); hideContext();
  if (R.narr) speakFrom(R.i); else tick();
  wakeLock(true);
}
function pause() {
  if (!R.playing) return;
  R.playing = false; clearTimeout(R.timer);
  if (R.narr) { R.utterGen++; speechSynthesis.cancel(); }
  document.body.classList.remove('playing'); $('#readerView').classList.remove('reading');
  addTime(performance.now() - R.sessionStart);
  savePos(true); showContext(); wakeLock(false);
  $('#tapHint').textContent = 'Tap to resume';
}
const toggle = () => (R.playing ? pause() : play());
function seek(i, keepPlaying = true) {
  const was = R.playing; if (was) pause();
  R.i = Math.max(0, Math.min(R.words.length - 1, i)); render(); savePos(true);
  if (was && keepPlaying) play(); else showContext();
}
const curSentStart = () => R.sentStart[R.words[R.i].s];
function prevSentence() { const st = curSentStart(); const s = R.words[R.i].s; seek(R.i - st > 2 || s === 0 ? st : R.sentStart[s - 1]); }
function nextSentence() { const s = R.words[R.i].s; const n = R.sentStart[s + 1]; if (n !== undefined) seek(n); }
async function savePos(force) {
  if (!R.meta) return; const now = Date.now(); if (!force && now - R.lastSave < 1500) return;
  R.lastSave = now; R.meta.pos = R.i; await idb.put('meta', R.meta);
}
function setWpm(v, persist = true) {
  S.wpm = Math.max(100, Math.min(1000, Math.round(v / 5) * 5));
  $('#wpm').value = S.wpm; $('#wpmLabel').textContent = S.wpm; $('#wpm').style.setProperty('--fill', ((S.wpm - 100) / 9) + '%');
  if (persist) saveS(); if (R.words.length) updateProgress();
}

/* ---------------- Context on pause ---------------- */
function showContext() {
  const w = R.words[R.i]; if (!w) return;
  // paragraph containing word, clipped to ~3 sentences around
  const s0 = Math.max(0, w.s - 1), s1 = w.s + 1;
  const from = R.sentStart[s0] ?? 0; let to = (R.sentStart[s1 + 1] ?? R.words.length) - 1;
  const box = $('#contextBox'); box.innerHTML = '';
  let lastP = R.words[from].p;
  for (let k = from; k <= to; k++) {
    const x = R.words[k];
    if (x.p !== lastP) { box.appendChild(document.createElement('br')); box.appendChild(document.createElement('br')); lastP = x.p; }
    const sp = document.createElement('span'); sp.className = 'w' + (x.s === w.s ? ' cur-sent' : '') + (k === R.i ? ' cur-word' : '');
    sp.textContent = x.t; sp.dataset.i = k; box.appendChild(sp); box.appendChild(document.createTextNode(' '));
  }
  box.classList.add('show');
  const cw = box.querySelector('.cur-word'); if (cw) box.scrollTop = cw.offsetTop - box.clientHeight / 2;
}
const hideContext = () => $('#contextBox').classList.remove('show');

/* ---------------- Narration ---------------- */
R.utterGen = 0;
function loadVoices() {
  const vs = speechSynthesis.getVoices(); const sel = $('#voiceSel');
  if (!vs.length) { sel.innerHTML = '<option>System default</option>'; return; }
  const sorted = [...vs].sort((a, b) => (b.lang.startsWith(navigator.language.slice(0, 2)) - a.lang.startsWith(navigator.language.slice(0, 2))) || a.name.localeCompare(b.name));
  sel.innerHTML = sorted.map((v) => `<option value="${v.voiceURI}">${v.name} (${v.lang})${v.localService ? '' : ' ☁'}</option>`).join('');
  if (S.voice && vs.some((v) => v.voiceURI === S.voice)) sel.value = S.voice;
}
function speakFrom(i) {
  const gen = ++R.utterGen; const w = R.words[i];
  const end = (R.sentStart[w.s + 1] ?? R.words.length);
  const offsets = []; let text = '';
  for (let k = i; k < end; k++) { offsets.push([text.length, k]); text += R.words[k].t + ' '; }
  const u = new SpeechSynthesisUtterance(text);
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === S.voice); if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = S.rate;
  let gotBoundary = false; const t0 = performance.now();
  u.onboundary = (e) => {
    if (gen !== R.utterGen || (e.name && e.name !== 'word')) return; gotBoundary = true;
    let k = i; for (const [o, idx] of offsets) { if (o <= e.charIndex) k = idx; else break; }
    if (k !== R.i) { countWords(k - R.i); R.i = k; render(); savePos(); }
  };
  // fallback estimator if the voice doesn't emit boundary events
  const est = setInterval(() => {
    if (gen !== R.utterGen) return clearInterval(est);
    if (gotBoundary) return clearInterval(est);
    const k = Math.min(end - 1, i + Math.floor(((performance.now() - t0) / 1000) * 2.6 * S.rate));
    if (k > R.i) { countWords(k - R.i); R.i = k; render(); }
  }, 120);
  u.onend = () => {
    clearInterval(est); if (gen !== R.utterGen || !R.playing) return;
    countWords(end - R.i); if (end >= R.words.length) { R.i = R.words.length - 1; render(); pause(); toast('Finished ✨'); return; }
    R.i = end; render(); savePos(); speakFrom(end);
  };
  u.onerror = (e) => { clearInterval(est); if (gen === R.utterGen && e.error !== 'interrupted' && e.error !== 'canceled') { toast('Narration error: ' + e.error); } };
  speechSynthesis.speak(u);
}
function setNarr(on) {
  if (on && !('speechSynthesis' in window)) return toast('Narration is not supported in this browser');
  const was = R.playing; if (was) pause();
  R.narr = on; $('#narrateBtn').setAttribute('aria-pressed', on);
  toast(on ? 'Narration on — the voice sets the pace' : 'Narration off');
  if (was) play();
}

/* ---------------- Stats & highlights ---------------- */
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const ST = JSON.parse(localStorage.getItem('sr.stats') || '{"days":{}}');
const saveST = () => localStorage.setItem('sr.stats', JSON.stringify(ST));
function day() { return (ST.days[today()] ||= { w: 0, ms: 0 }); }
function countWords(n) { if (n > 0) { day().w += n; saveST(); } }
function addTime(ms) { if (ms > 0 && ms < 6 * 3600e3) { day().ms += ms; saveST(); } }
function streak() {
  let n = 0; const d = new Date(); const key = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  if (!(ST.days[key(d)]?.w > 0)) d.setDate(d.getDate() - 1);
  while (ST.days[key(d)]?.w > 0) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function renderStats() {
  const days = Object.values(ST.days); const words = days.reduce((a, b) => a + b.w, 0); const ms = days.reduce((a, b) => a + b.ms, 0);
  const avg = ms > 5000 ? Math.round(words / (ms / 60000)) : 0; const t = ST.days[today()] || { w: 0 };
  $('#statsGrid').innerHTML = [[words.toLocaleString(), 'Words read'], [avg || '—', 'Avg WPM'], [streak() + (streak() === 1 ? ' day' : ' days'), 'Streak 🔥'], [t.w.toLocaleString(), 'Today']].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  const arr = []; for (let k = 6; k >= 0; k--) { const d = new Date(); d.setDate(d.getDate() - k); const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); arr.push([d.toLocaleDateString(undefined, { weekday: 'narrow' }), ST.days[key]?.w || 0]); }
  const max = Math.max(1, ...arr.map((a) => a[1]));
  $('#weekChart').innerHTML = arr.map(([l, v]) => `<div title="${v} words"><i style="height:${(v / max) * 80}%"></i>${l}</div>`).join('');
}
async function saveHighlight() {
  if (!R.words.length) return; const s = R.words[R.i].s; const a = R.sentStart[s]; const b = (R.sentStart[s + 1] ?? R.words.length);
  const text = R.words.slice(a, b).map((w) => w.t).join(' ');
  const ex = await idb.byDoc(R.id); if (ex.some((h) => h.word === a)) return toast('Already saved');
  await idb.put('highlights', { docId: R.id, word: a, text, at: Date.now() });
  toast('Sentence saved ★');
}
async function showHighlights() {
  const hs = (await idb.byDoc(R.id)).sort((x, y) => x.word - y.word);
  $('#listTitle').textContent = 'Highlights';
  const ul = $('#listBody'); ul.innerHTML = hs.length ? '' : '<p class="empty">No highlights yet. Tap “Save sentence” (or press S) while reading.</p>';
  hs.forEach((h) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="grow"><blockquote></blockquote><div class="sub">${Math.round((h.word / R.words.length) * 100)}% · ${new Date(h.at).toLocaleDateString()}</div></div><button class="icon-btn" aria-label="Copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button><button class="icon-btn" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
    li.querySelector('blockquote').textContent = h.text;
    const [cp, del] = li.querySelectorAll('button');
    li.onclick = (e) => { if (e.target.closest('button')) return; closeSheets(); seek(h.word, false); };
    cp.onclick = () => navigator.clipboard?.writeText(h.text).then(() => toast('Copied'));
    del.onclick = async () => { await idb.del('highlights', h.id); li.remove(); };
    ul.appendChild(li);
  });
  openSheet('listSheet');
}
function showChapters() {
  $('#listTitle').textContent = 'Chapters'; const ul = $('#listBody'); ul.innerHTML = '';
  let cur = 0; R.chapters.forEach((c, k) => { if (c.word <= R.i) cur = k; });
  R.chapters.forEach((c, k) => {
    const li = document.createElement('li'); if (k === cur) li.className = 'cur';
    const next = R.chapters[k + 1]?.word ?? R.words.length;
    li.innerHTML = `<div class="grow"><div class="t"></div><div class="sub">${Math.max(1, Math.round((next - c.word) / S.wpm))} min</div></div>`;
    li.querySelector('.t').textContent = c.title;
    li.onclick = () => { closeSheets(); seek(c.word, false); };
    ul.appendChild(li);
  });
  openSheet('listSheet'); ul.querySelector('.cur')?.scrollIntoView({ block: 'center' });
}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }
const showLoading = (m) => { $('#loadingText').textContent = m; $('#loading').classList.add('show'); };
const hideLoading = () => $('#loading').classList.remove('show');
function openSheet(id) { pause(); closeSheets(); $('#' + id).classList.add('show'); $('#scrim').classList.add('show'); }
function closeSheets() { $$('.sheet.show').forEach((s) => s.classList.remove('show')); $('#scrim').classList.remove('show'); }
let wl = null;
async function wakeLock(on) { try { if (on && 'wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); else if (wl) { await wl.release(); wl = null; } } catch {} }

/* ---------------- Events ---------------- */
$('#pasteBtn').onclick = () => { openSheet('pasteSheet'); setTimeout(() => $('#pasteText').focus(), 350); };
$('#pasteSave').onclick = async () => {
  const text = $('#pasteText').value.trim(); if (!text) return toast('Paste some text first');
  const title = $('#pasteTitle').value.trim() || text.split(/\s+/).slice(0, 6).join(' ') + '…';
  try { const id = await addDoc({ title, text, type: 'text', chapters: [] }); $('#pasteText').value = ''; $('#pasteTitle').value = ''; closeSheets(); openDoc(id); } catch (e) { toast(e.message); }
};
$('#fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
let dragN = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragN++; $('#dropOverlay').classList.add('show'); });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#dropOverlay').classList.remove('show'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#dropOverlay').classList.remove('show'); const f = e.dataTransfer.files[0]; if (f) importFile(f); });

$('#settingsBtn').onclick = $('#settingsBtn2').onclick = () => { loadVoices(); openSheet('settingsSheet'); };
$('#statsBtn').onclick = () => { renderStats(); openSheet('statsSheet'); };
$('#scrim').onclick = closeSheets;
$$('[data-close]').forEach((b) => (b.onclick = closeSheets));
$('#backBtn').onclick = () => history.back();
addEventListener('popstate', () => { if ($('#readerView').classList.contains('active')) closeReader(); });
$('#chaptersBtn').onclick = showChapters;
$('#hlListBtn').onclick = showHighlights;
$('#highlightBtn').onclick = saveHighlight;
$('#narrateBtn').onclick = () => setNarr(!R.narr);
$('#playBtn').onclick = toggle;
$('#prevSentBtn').onclick = prevSentence; $('#nextSentBtn').onclick = nextSentence;
$('#prevWordBtn').onclick = () => seek(R.i - 1, false); $('#nextWordBtn').onclick = () => seek(R.i + 1, false);
$('#slowerBtn').onclick = () => setWpm(S.wpm - 25); $('#fasterBtn').onclick = () => setWpm(S.wpm + 25);
$('#wpm').oninput = (e) => setWpm(+e.target.value);
$('#progress').oninput = (e) => { const was = R.playing; if (was) pause(); R.i = Math.round((e.target.value / 1000) * (R.words.length - 1)); render(); showContext(); };
$('#progress').onchange = () => savePos(true);
$('#stage').addEventListener('click', (e) => {
  const w = e.target.closest('#contextBox .w'); if (w) { seek(+w.dataset.i, false); return; }
  toggle();
});
// show controls briefly on mouse move while reading (desktop)
let mvT; $('#readerView').addEventListener('mousemove', (e) => { if (!R.playing || e.movementX === 0 && e.movementY === 0) return; $('#readerView').classList.remove('reading'); clearTimeout(mvT); mvT = setTimeout(() => R.playing && $('#readerView').classList.add('reading'), 1600); });

const segBind = (id, key, conv = (x) => x) => $$(`#${id} button`).forEach((b) => (b.onclick = () => { S[key] = conv(b.dataset.v); saveS(); applySettings(); }));
segBind('themeSeg', 'theme'); segBind('fontSeg', 'font'); segBind('chunkSeg', 'chunk', Number);
$$('#colorRow button').forEach((b) => (b.onclick = () => { S.color = b.dataset.v; saveS(); applySettings(); }));
$('#colorIn').oninput = (e) => { S.color = e.target.value; saveS(); applySettings(); };
$('#sizeIn').oninput = (e) => { S.size = +e.target.value; saveS(); applySettings(); };
$('#guidesIn').onchange = (e) => { S.guides = e.target.checked; saveS(); applySettings(); };
$('#rampIn').onchange = (e) => { S.ramp = e.target.checked; saveS(); };
$('#smartIn').onchange = (e) => { S.smart = e.target.checked; saveS(); applySettings(); };
$('#voiceSel').onchange = (e) => { S.voice = e.target.value; saveS(); };
$('#rateIn').oninput = (e) => { S.rate = +e.target.value; saveS(); $('#rateVal').textContent = S.rate.toFixed(1) + '×'; };
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = loadVoices; loadVoices(); }

addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text],textarea,select')) return;
  if (e.key === 'Escape') { if ($('.sheet.show')) closeSheets(); else if ($('#readerView').classList.contains('active')) history.back(); return; }
  if (!$('#readerView').classList.contains('active') || $('.sheet.show')) return;
  const k = e.key;
  if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); prevSentence(); }
  else if (k === 'ArrowRight') { e.preventDefault(); nextSentence(); }
  else if (k === 'ArrowUp') { e.preventDefault(); setWpm(S.wpm + 25); toast(S.wpm + ' wpm'); }
  else if (k === 'ArrowDown') { e.preventDefault(); setWpm(S.wpm - 25); toast(S.wpm + ' wpm'); }
  else if (k === ',') seek(R.i - 1, false);
  else if (k === '.') seek(R.i + 1, false);
  else if (k === 's' || k === 'S') saveHighlight();
  else if (k === 'n' || k === 'N') setNarr(!R.narr);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); savePos(true); } });
addEventListener('resize', () => { applySettings(); });

/* ---------------- Boot ---------------- */
applySettings();
await document.fonts.ready.catch(() => {});
renderLibrary();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__sr = { R, S, idb, importFile }; // test hook
