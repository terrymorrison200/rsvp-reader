// Swift Read — local-first RSVP reader
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- IndexedDB ---------------- */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('swiftread', 4);
  r.onupgradeneeded = () => {
    const d = r.result; const has = (n) => d.objectStoreNames.contains(n);
    if (!has('docs')) d.createObjectStore('docs', { keyPath: 'id' });
    if (!has('meta')) d.createObjectStore('meta', { keyPath: 'id' });
    if (!has('highlights')) { const h = d.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true }); h.createIndex('doc', 'docId'); }
    if (!has('journals')) d.createObjectStore('journals', { keyPath: 'id' });
    if (!has('jentries')) d.createObjectStore('jentries', { keyPath: 'id' });
    if (!has('outbox')) d.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true });
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
const DEF = { syncUrl: '', syncKey: '', theme: 'dark', font: 'inter', size: 56, chunk: 1, color: '#ff4d4d', guides: true, ramp: true, smart: true, wpm: 300, voice: '', rate: 1 };
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
async function sniffKind(file) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7)) return 'zip';
  const asc = new TextDecoder('latin1').decode(head);
  if (asc.includes('%PDF-')) return 'pdf';
  if (!head.length) return 'empty';
  let bad = 0; for (const b of head) if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) bad++;
  if (bad > head.length * 0.02) return 'binary';
  const t = asc.replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart().slice(0, 600).toLowerCase();
  if (/^(<!doctype html|<html|<\?xml[^>]*>\s*(<!doctype html|<html))/.test(t) || /<(head|body|meta|div|p)[\s>]/.test(t)) return 'html';
  return 'text';
}
async function importFile(file) {
  const name = file.name.replace(/\.[^.]+$/, ''); const ext = (file.name.split('.').pop() || '').toLowerCase();
  showLoading('Importing ' + file.name + '…');
  try {
    let doc; const kind = await sniffKind(file);
    if (kind === 'zip') {
      try { doc = await parseEpub(file); } catch (e) { console.warn(e); throw new UserErr('That file is a zip archive but not a readable EPUB.'); }
      doc.type = 'epub';
    } else if (kind === 'pdf') { try { doc = await parsePdf(file); } catch (e) { console.warn(e); throw new UserErr('That PDF could not be read (it may be scanned images or password-protected).'); } doc.type = 'pdf'; }
    else if (kind === 'html') {
      const raw = await file.text(); const { paras, heading } = htmlToParas(raw);
      const text = paras.join('\n\n');
      if (ext === 'epub' && /gutenberg/i.test(raw) && text.split(/\s+/).length < 400) throw new UserErr('This “EPUB” is actually a web page Safari saved, not the book. Try “Browse Gutenberg” in Swift Read instead.');
      doc = { title: heading || name, text, chapters: [], type: 'html' };
    } else if (kind === 'text') {
      const raw = (await file.text()).replace(/\r/g, '');
      if (ext === 'md' || ext === 'markdown') { const { text, chapters } = mdToText(raw); const paras = text.split(/\n\s*\n+/).filter((p) => p.trim());
        doc = { title: name, text, type: 'md', chapters: chapters.map((c) => ({ title: c.title, paraIdx: paras.findIndex((p) => p.trim() === c.title) })).filter((c) => c.paraIdx >= 0) }; }
      else if (/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG/i.test(raw)) doc = Object.assign(gutenbergText(raw), { type: 'txt' });
      else doc = { title: name, text: raw, chapters: [], type: 'txt' };
    } else throw new UserErr(kind === 'empty' ? 'That file is empty.' : 'Swift Read can’t read this kind of file. Try TXT, EPUB, PDF, HTML or Markdown.');
    if (!doc.title) doc.title = name;
    const id = await addDoc(doc);
    hideLoading(); openDoc(id);
  } catch (e) { console.error(e); hideLoading(); toast(e instanceof UserErr ? e.message : 'Couldn’t import that file — it may be damaged or in an unsupported format.'); }
}
class UserErr extends Error {}
/* Gutenberg plain text: strip boilerplate, find chapter headings */
function gutenbergText(raw) {
  raw = raw.replace(/\r/g, '').replace(/^\uFEFF/, '');
  const titleM = raw.match(/^Title:\s*(.+)$/m);
  const s = raw.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*/i);
  let body = s >= 0 ? raw.slice(raw.indexOf('\n', s) + 1) : raw;
  const e = body.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i); if (e >= 0) body = body.slice(0, e);
  body = body.replace(/^\s*\[Illustration[^\]]*\]\s*$/gm, '');
  const paras = body.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const rx = /^(BOOK|CHAPTER|VOLUME|PART|STAVE|CANTO|ACT)\b[\s.]*(?:[IVXLCDM]+|\d+|THE\b|[A-Z]+)/i;
  const isH = paras.map((p) => p.split('\n').length <= 3 && p.length < 160 && rx.test(p) && !/[a-z]{3,}.*[.,;]$/.test(p) && !/[a-z]{4,}/.test(p.split('\n')[0].replace(rx, '')) );
  const hTitle = (p) => p.split('\n').map((l) => l.trim()).reduce((a, l) => (!a ? l : /^(\S+\s+)?([IVXLCDM]+|\d+)\.?$/i.test(a) ? a + ' — ' + l : a + ' ' + l), '');
  const chapters = [];
  for (let i = 0; i < paras.length; i++) {
    if (!isH[i]) continue;
    let a = i, b = i; while (a > 0 && isH[a - 1]) a--; while (b < paras.length - 1 && isH[b + 1]) b++;
    if (b - a >= 4) continue; // table of contents run
    chapters.push({ title: hTitle(paras[i]), paraIdx: i });
  }
  // a contents list repeats headings that appear again later: keep only the last occurrence
  const key = (t) => t.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const last = {}; chapters.forEach((c, k) => (last[key(c.title)] = k));
  const kept = chapters.filter((c, k) => last[key(c.title)] === k || c.paraIdx > paras.length * 0.1);
  chapters.length = 0; chapters.push(...kept);
  return { title: titleM ? titleM[1].trim() : '', text: paras.join('\n\n'), chapters };
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
  await idb.put('meta', { id, title: doc.title, author: doc.author || '', source: doc.source || 'local', sourceId: doc.sourceId || '', audio: doc.audio || '', type: doc.type, count: words.length, pos: 0, added: Date.now(), opened: Date.now() });
  return id;
}


/* ---------------- Project Gutenberg browser ---------------- */
const GX = 'https://gutendex.com/books/';
// gutenberg.org files have no CORS headers -> go through public CORS proxies, trying mirrors & proxies in turn
const PROXIES = [
  (u) => 'https://cors.eu.org/' + u,
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://corsproxy.org/?' + encodeURIComponent(u),
  (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u),
];
// bundled genre snapshots (Gutendex topic queries can take 80s+ or 503) — shown instantly, live data used for "more"
let GENRES = {}; const genreP = fetch('genres.json').then((r) => r.json()).then((j) => { GENRES = j.topics || {}; }).catch(() => {});
const FEATURED = [
  { id: 135, title: 'Les Misérables', author: 'Victor Hugo', note: 'Hapgood translation · unabridged' },
  { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
  { id: 2701, title: 'Moby Dick', author: 'Herman Melville' },
  { id: 1184, title: 'The Count of Monte Cristo', author: 'Alexandre Dumas' },
  { id: 84, title: 'Frankenstein', author: 'Mary Shelley' },
  { id: 98, title: 'A Tale of Two Cities', author: 'Charles Dickens' },
];
const TOPICS = ['Popular', 'Fiction', 'Adventure', 'Romance', 'Mystery', 'Science Fiction', 'Philosophy', 'History', 'Poetry', 'Children', 'Short Stories', 'Gothic'];
let STORYW = {}, STORYJ = null; const storyP = fetch('stories.json').then((r) => r.json()).then((j) => { STORYJ = j; STORYW = j.words || {}; }).catch(() => {});
const G = { mode: 'books', q: '', topic: 'Popular', next: null, loading: false, gen: 0, cache: {} };
const cover = (id) => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
window.coverErr = (img) => { if (!img.dataset.f && /gutenberg\.org\/cache/.test(img.src)) { img.dataset.f = 1; img.src = img.src.replace('www.gutenberg.org', 'gutenberg.pglaf.org'); } else img.style.visibility = 'hidden'; };
const fold = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const authorName = (b) => (b.authors?.[0]?.name || 'Unknown').replace(/^([^,]+),\s*(.+)$/, '$2 $1');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function openGutenberg() {
  showView('gutView'); history.pushState({ v: 'gut' }, '');
  if (!$('#gutFeatured').children.length) renderFeatured();
  if (!$('#gutTopics').children.length) {
    $('#gutTopics').innerHTML = TOPICS.map((t) => `<button class="chip${t === G.topic ? ' on' : ''}" data-t="${t}">${t}</button>`).join('');
    $$('#gutTopics .chip').forEach((b) => (b.onclick = () => { G.topic = b.dataset.t; G.q = ''; $('#gutSearch').value = ''; $$('#gutTopics .chip').forEach((x) => x.classList.toggle('on', x === b)); gutLoad(true); }));
  }
  if (!$('#gutList').children.length) Promise.allSettled([storyP, genreP]).then(() => gutLoad(true));
}
function renderFeatured() {
  $('#gutFeatured').innerHTML = FEATURED.map((f) => `<button class="feat" data-id="${f.id}"><img loading="lazy" alt="" src="${cover(f.id)}" onerror="coverErr(this)"><span class="ft">${esc(f.title)}</span><span class="fa">${esc(f.author)}</span>${f.note ? `<span class="fn">${esc(f.note)}</span>` : ''}</button>`).join('');
  $$('#gutFeatured .feat').forEach((b) => (b.onclick = () => showBook(+b.dataset.id)));
}
async function gutJSON(url) {
  const tryOne = async (u, ms) => { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(u, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (!j || typeof j !== 'object') throw new Error('bad json'); return j; } finally { clearTimeout(t); } };
  for (let a = 0; a < 2; a++) {
    try { return await tryOne(url, a ? 45000 : 30000); } catch (e) { console.warn('gutendex', e.message || e); }
    await new Promise((r) => setTimeout(r, 800 * (a + 1)));
  }
  for (const px of PROXIES) { try { return await tryOne(px(url), 20000); } catch (e) { console.warn('gutendex proxy', e.message || e); } }
  throw new UserErr('The Gutenberg catalogue isn’t responding. Check your connection and try again.');
}
async function gutLoad(reset) {
  if (!reset && (G.loading || !G.next)) return;
  const gen = ++G.gen; G.loading = true;
  let url;
  if (reset) {
    $('#gutList').innerHTML = ''; G.next = null;
    const p = new URLSearchParams({ languages: 'en' });
    if (G.mode === 'stories') p.set('topic', 'short stories'); if (G.q) p.set('search', G.q); else if (G.mode !== 'stories' && G.topic !== 'Popular') p.set('topic', G.topic.toLowerCase());
    url = GX + '?' + p;
    $('#gutHeading').textContent = G.mode === 'stories' && !G.q ? 'Short stories' : G.q ? `Results for “${G.q}”` : G.topic === 'Popular' ? 'Most popular' : G.topic;
  } else url = G.next;
  if (!url) { G.loading = false; return; }
  if (reset && G.mode === 'stories' && !G.q && STORYJ?.books?.length) url = 'bundled:';
  if (reset && G.mode !== 'stories' && !G.q && G.topic === 'Popular' && STORYJ?.popular?.length) url = 'bundled-pop:';
  if (reset && G.mode !== 'stories' && !G.q && G.topic !== 'Popular' && GENRES[G.topic]?.results?.length) url = 'bundled-genre:';
  $('#gutStatus').textContent = reset && /search=|topic=/.test(url) ? 'Searching the catalogue — first searches can take up to a minute…' : 'Loading…'; $('#gutStatus').className = 'gut-status loading';
  try {
    let d = url === 'bundled:' ? { results: STORYJ.books, next: STORYJ.next } : url === 'bundled-pop:' ? { results: STORYJ.popular, next: STORYJ.popularNext } : url === 'bundled-genre:' ? { ...GENRES[G.topic] } : await gutJSON(url); if (gen !== G.gen) return;
    if (reset && G.q) {
      // Gutendex search is accent-sensitive ("Miserables" ≠ "Misérables"): pin local featured matches, and retry with a shorter prefix
      const fq = fold(G.q); const pins = FEATURED.filter((f) => fold(f.title + ' ' + f.author).includes(fq) || fq.split(' ').every((w) => fold(f.title + ' ' + f.author).includes(w)));
      let extra = [];
      if (pins.length) { try { extra = (await gutJSON(GX + '?ids=' + pins.map((f) => f.id).join(','))).results; } catch {} }
      if (!d.results.length && /[a-z]/i.test(G.q)) {
        const m = G.q.slice(4).search(/[aeiouycn]/i); const pre = m >= 0 ? G.q.slice(0, 4 + m) : '';
        if (pre && pre.length < G.q.length) { $('#gutStatus').textContent = 'Looking for accented spellings…';
          try { const d2 = await gutJSON(GX + '?' + new URLSearchParams({ languages: 'en', search: pre })); d = { ...d2, results: d2.results.filter((b) => fq.split(' ').every((w) => fold(b.title + ' ' + (b.authors || []).map((a) => a.name).join(' ')).includes(w))), next: null }; } catch {} }
      }
      if (gen !== G.gen) return;
      d.results = [...extra, ...d.results.filter((b) => !extra.some((x) => x.id === b.id))];
    }
    G.next = d.next;
    d.results.forEach((b, i) => {
      G.cache[b.id] = b;
      const li = document.createElement('li'); li.className = 'gbook'; li.style.animationDelay = (i % 32) * 20 + 'ms';
      li.innerHTML = `<img loading="lazy" alt="" src="${esc(b.formats['image/jpeg'] || cover(b.id))}" onerror="coverErr(this)"><div class="gi"><div class="gt">${esc(b.title)}</div><div class="ga">${esc(authorName(b))}</div><div class="gd">${STORYW[b.id] ? '~' + fmtMin(STORYW[b.id]) + ' at ' + S.wpm + ' wpm · ' : ''}${b.download_count.toLocaleString()} downloads</div></div>`;
      li.onclick = () => showBook(b.id);
      $('#gutList').appendChild(li);
    });
    if (d.results.length || $('#gutList').children.length) { $('#gutStatus').textContent = G.next ? '' : 'That’s everything.'; $('#gutStatus').className = 'gut-status'; }
    else gutFail(G.q ? 'No books found.' : 'Couldn’t load this list.', reset);
  } catch (e) { if (gen === G.gen) gutFail($('#gutList').children.length ? 'Couldn’t load more.' : 'Couldn’t load this list.', reset, url); }
  finally { if (gen === G.gen) G.loading = false; }
}
function gutFail(msg, reset, url) {
  const st = $('#gutStatus'); st.className = 'gut-status';
  st.innerHTML = `${esc(msg)} <button class="chip" id="gutRetry">Retry</button>`;
  $('#gutRetry').onclick = () => { if (reset || !url) gutLoad(true); else { G.next = url; gutLoad(false); } };
}
async function findGutenbergDoc(id, title, author) {
  const all = await idb.all('meta'); const gid = String(id);
  const hit = all.find((m) => m.source === 'gutenberg' && m.sourceId === gid);
  if (hit || !title) return hit;
  const ft = fold(title), fa = fold(author || '');
  return all.find((m) => fold(m.title || '') === ft && (!fa || !m.author || fold(m.author) === fa));
}
async function showBook(id) {
  let b = G.cache[id];
  { const f = FEATURED.find((x) => x.id === id); const ex = await findGutenbergDoc(id, b ? b.title : f?.title, b ? authorName(b) : f?.author).catch(() => null);
    if (ex) { closeSheets(); return openDoc(ex.id); } }
  $('#bookBody').innerHTML = '<div class="spinner small"></div>'; openSheet('bookSheet');
  try { if (!b) b = G.cache[id] = await gutJSON(GX + id + '/'); } catch (e) { $('#bookBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const tr = (b.translators || []).map((t) => t.name.replace(/^([^,]+),\s*(.+)$/, '$2 $1'));
  const subj = [...new Set([...(b.subjects || []).map((s) => s.split(' -- ')[0]), ...(b.bookshelves || []).map((s) => s.replace(/^Category:\s*/, ''))])].slice(0, 8);
  $('#bookBody').innerHTML = `<div class="bk-top"><img alt="" src="${esc(b.formats['image/jpeg'] || cover(b.id))}" onerror="coverErr(this)"><div><h3 class="bk-title">${esc(b.title)}</h3><div class="bk-author">${esc(authorName(b))}</div>${tr.length ? `<div class="bk-sub">Translated by ${esc(tr.join(', '))}</div>` : ''}<div class="bk-sub">${b.download_count.toLocaleString()} downloads · Gutenberg #${b.id}</div></div></div>
    <div class="bk-tags">${subj.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
    <div class="bk-prog" id="bkProg"><i></i><span></span></div>`;
  $('#bookAdd').onclick = () => addGutenberg(b);
  $('#bookAdd').disabled = false; $('#bookAdd').textContent = 'Add to library';
}
async function fetchWithProgress(url, onProg, timeoutMs = 60000) {
  const ctl = new AbortController(); let t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    if (!r.body || !r.body.getReader) { const buf = new Uint8Array(await r.arrayBuffer()); onProg(buf.length, total); return buf; }
    const rd = r.body.getReader(); const parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; onProg(n, total);
      clearTimeout(t); t = setTimeout(() => ctl.abort(), 20000); }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  } finally { clearTimeout(t); }
}
async function addGutenberg(b) {
  { const ex = await findGutenbergDoc(b.id, b.title, authorName(b)).catch(() => null); if (ex) { closeSheets(); return openDoc(ex.id); } }
  const btn = $('#bookAdd'); btn.disabled = true; btn.textContent = 'Downloading…';
  const prog = $('#bkProg'); prog.classList.add('show');
  const setP = (txt, frac) => { prog.querySelector('span').textContent = txt; prog.querySelector('i').style.width = frac == null ? '' : Math.round(frac * 100) + '%'; prog.classList.toggle('indet', frac == null); };
  const id = b.id;
  const txtSrc = [`https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}.txt`, `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`];
  const epubSrc = [`https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}.epub`, `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub`];
  const attempts = [['txt', `books/${id}.txt`]];
  const ft = b.formats?.['text/plain; charset=utf-8'] || b.formats?.['text/plain; charset=us-ascii'] || b.formats?.['text/plain'];
  const fe = b.formats?.['application/epub+zip'];
  if (ft && !txtSrc.includes(ft)) txtSrc.push(ft); if (fe && !epubSrc.includes(fe)) epubSrc.push(fe);
  for (const px of PROXIES) for (const u of txtSrc) attempts.push(['txt', px(u)]);
  for (const px of PROXIES) for (const u of epubSrc) attempts.push(['epub', px(u)]);
  const approx = 0; let doc = null, k = 0;
  for (const [kind, url] of attempts) {
    k++;
    try {
      setP(`Connecting… (route ${k})`, null);
      const buf = await fetchWithProgress(url, (n, tot) => setP(`Downloading ${(n / 1048576).toFixed(1)} MB${tot ? ' of ' + (tot / 1048576).toFixed(1) + ' MB' : ''}…`, tot ? n / tot : null), k === 1 ? 20000 : 8000);
      if (kind === 'txt') {
        const raw = new TextDecoder('utf-8').decode(buf);
        if (buf.length < 2000 || !/\*\*\* ?START OF/i.test(raw)) throw new Error('not a gutenberg text');
        doc = gutenbergText(raw); doc.type = 'txt';
      } else {
        if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('not a zip');
        setP('Unpacking EPUB…', null);
        doc = await parseEpub(new File([buf], `pg${id}.epub`)); doc.type = 'epub';
      }
      break;
    } catch (e) { console.warn('gutenberg route failed', url, e.message || e); }
  }
  if (!doc) { setP('', 0); prog.classList.remove('show'); btn.disabled = false; btn.textContent = 'Try again'; toast('Couldn’t download this book right now — the free download relays are busy. Please try again in a minute.'); return; }
  setP('Saving to your library…', 1);
  doc.title = b.title; doc.author = authorName(b); doc.source = 'gutenberg'; doc.sourceId = String(b.id);
  try {
    const did = await addDoc(doc);
    closeSheets(); toast('Added “' + b.title + '”'); openDoc(did, true);
  } catch (e) { console.error(e); btn.disabled = false; btn.textContent = 'Try again'; toast('Couldn’t save the book on this device.'); }
}


/* ---------------- Reading history + automatic sync ---------------- */
const HIST = JSON.parse(localStorage.getItem('sr.history') || '{}');
const saveH = () => localStorage.setItem('sr.history', JSON.stringify(HIST));
const docInfo = (m) => m.source === 'journal' ? { docId: m.id, title: '', author: '', source: 'journal', sourceId: '', total: m.count } : ({ docId: m.id, title: m.title, author: m.author || '', source: m.source || 'local', sourceId: m.sourceId || '', total: m.count });
function histOpen(m) {
  const h = (HIST[m.id] ||= { ...docInfo(m), wordsRead: 0, finished: false, firstOpened: new Date().toISOString(), sessions: [] });
  Object.assign(h, docInfo(m)); h.lastOpened = new Date().toISOString(); saveH();
  logEvent('open', { pos: m.pos });
}
function histSession(ms) {
  if (!R.meta || !(R.sessionWords > 0)) return;
  const h = HIST[R.id]; if (!h) return;
  const wpm = ms > 3000 ? Math.round(R.sessionWords / (ms / 60000)) : S.wpm;
  const ses = { start: R.sessionAt, end: new Date().toISOString(), words: R.sessionWords, seconds: Math.round(ms / 1000), wpm, setWpm: S.wpm, mode: R.audio ? 'audio' : R.narr ? 'narrate' : 'rsvp' };
  h.sessions.push(ses); if (h.sessions.length > 200) h.sessions.shift();
  h.wordsRead += R.sessionWords; h.pos = R.i; h.pct = Math.round((R.i / Math.max(1, R.words.length - 1)) * 100);
  if (h.pct >= 97) h.finished = true; saveH();
  logEvent('session', { ...ses, pos: R.i, pct: h.pct, finished: h.finished });
  R.sessionWords = 0;
}
function histFinished() { const h = HIST[R.id]; if (h && !h.finishedLogged) { h.finished = true; h.finishedLogged = true; h.finishedAt = new Date().toISOString(); saveH(); logEvent('finished', {}); } }
const isRead = (sourceId) => Object.values(HIST).some((h) => h.sourceId === sourceId && (h.finished || h.pct >= 90));
async function logEvent(type, data) {
  if (R.meta?.source === 'journal' && type === 'highlight') data = {}; // never send journal text
  const ev = { type, at: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(R.meta ? docInfo(R.meta) : {}), ...data };
  try { await idb.put('outbox', ev); } catch {}
  flushSync();
}
let flushing = false;
async function flushSync() {
  if (flushing || !S.syncUrl || !S.syncKey || !navigator.onLine) return syncStatus();
  flushing = true;
  try {
    const evs = (await idb.all('outbox')).slice(0, 200); if (!evs.length) return;
    // text/plain = "simple" request: no CORS preflight, which Apps Script can't answer
    const r = await fetch(S.syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: S.syncKey, device: navigator.userAgent.slice(0, 120), events: evs }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'rejected');
    for (const e of evs) await idb.del('outbox', e.n);
    localStorage.setItem('sr.lastSync', new Date().toISOString());
    if (evs.length === 200) setTimeout(flushSync, 500);
  } catch (e) { console.warn('sync failed', e); localStorage.setItem('sr.syncErr', String(e.message || e)); }
  finally { flushing = false; syncStatus(); }
}
async function syncStatus() {
  const el = $('#syncStatus'); if (!el) return;
  const q = (await idb.all('outbox').catch(() => [])).length; const last = localStorage.getItem('sr.lastSync');
  el.textContent = !S.syncUrl || !S.syncKey ? `Not paired · ${q} event${q === 1 ? '' : 's'} waiting` : `${last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet'} · ${q} waiting${localStorage.getItem('sr.syncErr') && q ? ' · last error: ' + localStorage.getItem('sr.syncErr') : ''}`;
}
addEventListener('online', flushSync); setInterval(flushSync, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushSync(); });
(function pair() { // pairing link: …/rsvp-reader/#sync=<script url>&key=<secret>  (query string also accepted)
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  if (p.get('key')) { S.syncKey = p.get('key'); if (p.get('sync')) S.syncUrl = p.get('sync'); saveS(); history.replaceState(null, '', location.pathname); setTimeout(() => { toast('Reading sync paired ✓'); flushSync(); }, 800); }
})();
async function exportLog() {
  const data = { app: 'Swift Read', exported: new Date().toISOString(), history: Object.values(HIST), days: ST.days, library: (await idb.all('meta')).map(({ id, title, author, source, sourceId, count, pos, added, opened }) => ({ id, title, author, source, sourceId, count, pos, added, opened })) };
  const file = new File([JSON.stringify(data, null, 1)], `swift-read-log-${today()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Swift Read reading log' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- Proxied fetch helpers ---------------- */
async function viaProxies(url, { as = 'text', check = () => true, onProg } = {}) {
  let lastErr;
  for (const px of PROXIES) {
    try {
      const buf = await fetchWithProgress(px(url), onProg || (() => {}), 45000);
      const out = as === 'json' ? JSON.parse(new TextDecoder().decode(buf)) : as === 'text' ? new TextDecoder().decode(buf) : buf;
      if (!check(out)) throw new Error('bad payload'); return out;
    } catch (e) { lastErr = e; console.warn('proxy failed', e.message); }
  }
  throw lastErr || new Error('all proxies failed');
}
const CH_API = 'https://www.churchofjesuschrist.org/study/api/v3/language-pages/type/content?lang=eng&uri=';
const churchPage = (uri) => viaProxies(CH_API + uri, { as: 'json', check: (j) => j && j.content && j.content.body });
function churchParas(body) {
  const d = new DOMParser().parseFromString(body, 'text/html');
  d.querySelectorAll('footer.notes,video,figure,img,.marker,sup,.study-note-ref,.title-number,.kicker,nav,aside').forEach((e) => e.remove());
  d.querySelectorAll('.verse-number').forEach((e) => e.remove());
  return htmlToParas(d.body.innerHTML).paras;
}
async function findDocBySource(sourceId) { return (await idb.all('meta')).find((m) => m.sourceId === sourceId); }

/* ---------------- Church: Come, Follow Me + General Conference ---------------- */
const CH = { cfm: null, gc: null };
const fmtMin = (w) => { const m = Math.max(1, Math.round(w / S.wpm)); return m + ' min'; };
async function loadChurch() {
  const y = new Date().getFullYear();
  try { CH.cfm = await (await fetch(`church/come-follow-me-${y}.json`)).json(); } catch { CH.cfm = null; }
  try { CH.gc = await (await fetch('church/conference-latest.json')).json(); } catch { CH.gc = null; }
  renderChurchCard();
}
function cfmWeek(offset = 0) {
  if (!CH.cfm) return null; const d = new Date(); d.setDate(d.getDate() + offset * 7);
  const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return CH.cfm.weeks.find((w) => w.start <= k && k <= w.end);
}
function renderChurchCard() {
  const box = $('#churchCard'); if (!box) return;
  const w = cfmWeek(), nx = cfmWeek(1);
  let h = '';
  if (w) h += `<div class="cfm"><div class="cfm-k">Come, Follow Me · ${esc(w.dates)}</div><div class="cfm-t">“${esc(w.title)}”</div><div class="cfm-r">${esc(w.reading)}${w.chapters.length ? ' · ' + w.chapters.length + ' chapters' : ''}</div>
    <div class="cfm-b">${w.chapters.length ? `<button class="btn primary sm" id="cfmRead">Read this week</button>` : ''}<button class="btn sm" id="cfmLesson">Lesson</button></div>
    ${nx && nx !== w ? `<div class="cfm-next">Next: ${esc(nx.dates)} · ${esc(nx.reading)}</div>` : ''}</div>`;
  if (CH.gc) h += `<button class="gc-row" id="gcOpen"><div><div class="cfm-k">General Conference</div><div class="gc-t">${esc(CH.gc.conference.replace(/general conference/i, 'General Conference'))}</div><div class="cfm-r">${CH.gc.talks.length} talks · ${CH.gc.talks.filter((t) => isRead(t.id)).length} read</div></div><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>`;
  box.innerHTML = h; $('#secWeek').style.display = h ? '' : 'none';
  $('#cfmRead') && ($('#cfmRead').onclick = () => loadScripture(w));
  $('#cfmLesson') && ($('#cfmLesson').onclick = () => loadChurchDoc({ uri: w.lessonUri, sourceId: 'cfm-lesson-' + CH.cfm.year + '-' + w.week, title: `Come, Follow Me: ${w.title}`, author: w.dates, source: 'cfm' }));
  $('#gcOpen') && ($('#gcOpen').onclick = openConference);
}
function histSessionFlush() {}
function openConferenceRefresh() { const y = $('#gcList').parentElement.scrollTop; openConferenceList(); $('#gcList').parentElement.scrollTop = y; }
function openConference() { showView('gcView'); history.pushState({ v: 'gc' }, ''); openConferenceList(); }
function openConferenceList() {
  $('#gcTitle').textContent = CH.gc.conference.replace(/general conference/i, 'General Conference');
  $('#gcSrc').href = CH.gc.source;
  let html = '', sess = '';
  CH.gc.talks.forEach((t, i) => {
    if (t.session !== sess) { sess = t.session; html += `<h2 class="section-title">${esc(sess)}</h2>`; }
    const read = isRead(t.id);
    html += `<button class="talk${read ? ' read' : ''}" data-i="${i}"><div class="gi"><div class="gt">${esc(t.title)}</div><div class="ga">${esc(t.speaker)}</div><div class="gd">${fmtMin(t.words)} at ${S.wpm} wpm${t.audio ? ' · 🎧 audio' : ''}</div></div>${read ? '<span class="check">✓</span>' : ''}</button>`;
  });
  $('#gcList').innerHTML = html;
  $$('#gcList .talk').forEach((b) => (b.onclick = () => { const t = CH.gc.talks[+b.dataset.i]; loadChurchDoc({ uri: t.uri, sourceId: t.id, title: t.title, author: t.speaker, source: 'general-conference', audio: t.audio }); }));
}
async function loadChurchDoc({ uri, sourceId, title, author, source, audio }) {
  const ex = await findDocBySource(sourceId); if (ex) return openDoc(ex.id);
  showLoading('Loading “' + title + '”…');
  try {
    const j = await churchPage(uri); const paras = churchParas(j.content.body);
    const id = await addDoc({ title, author, source, sourceId, audio, type: 'talk', text: paras.join('\n\n'), chapters: [] });
    hideLoading(); openDoc(id);
  } catch (e) { console.error(e); hideLoading(); toast('Couldn’t load that from churchofjesuschrist.org right now. Please try again shortly.'); }
}
async function loadScripture(w) {
  const sid = 'cfm-' + CH.cfm.year + '-' + w.week; const ex = await findDocBySource(sid); if (ex) return openDoc(ex.id);
  showLoading('Loading ' + w.reading + '…'); const paras = [], chapters = [];
  try {
    for (const [k, c] of w.chapters.entries()) {
      $('#loadingText').textContent = `Loading ${c.book} ${c.chapter} (${k + 1} of ${w.chapters.length})…`;
      let verses;
      if (c.vol === 'ot') {
        // public-domain KJV from bible-api.com (sends CORS headers); church site via proxy as fallback
        try {
          const r = await fetch(`https://bible-api.com/${encodeURIComponent(c.book + ' ' + c.chapter)}?translation=kjv`); if (!r.ok) throw new Error(r.status);
          verses = (await r.json()).verses.map((v) => v.text.replace(/\s+/g, ' ').trim());
        } catch { verses = churchParas((await churchPage(`/scriptures/${c.vol}/${c.abbr}/${c.chapter}`)).content.body); }
        if (w.chapters.length > 12) await new Promise((r) => setTimeout(r, 1500)); // bible-api.com allows ~15 requests / 30s
      } else verses = churchParas((await churchPage(`/scriptures/${c.vol}/${c.abbr}/${c.chapter}`)).content.body);
      chapters.push({ title: `${c.book} ${c.chapter}`, paraIdx: paras.length });
      paras.push(`${c.book} ${c.chapter}`, ...verses);
    }
    const id = await addDoc({ title: `${w.reading} (${w.dates})`, author: 'Come, Follow Me', source: 'cfm-scripture', sourceId: sid, type: 'kjv', text: paras.join('\n\n'), chapters });
    hideLoading(); openDoc(id); toast('KJV text · public domain');
  } catch (e) { console.error(e); hideLoading(); toast('Couldn’t load the scripture text right now. Please try again shortly.'); }
}

/* ---------------- For you (suggestions.json, maintained by the Reading Guide bot) ---------------- */
async function loadSuggestions() {
  try {
    const r = await fetch('suggestions.json?t=' + Math.floor(Date.now() / 3600e3), { cache: 'no-store' }); const list = await r.json();
    if (!Array.isArray(list) || !list.length) return;
    $('#forYou').innerHTML = list.slice(0, 12).map((s, i) => `<button class="feat sug" data-i="${i}">${s.source === 'gutenberg' ? `<img loading="lazy" alt="" src="${cover(s.id)}" onerror="coverErr(this)">` : '<div class="sug-ph">✦</div>'}<span class="ft">${esc(s.title)}</span><span class="fa">${esc(s.author || '')}${s.minutes ? ' · ' + s.minutes + ' min' : ''}</span>${s.why ? `<span class="fn">${esc(s.why)}</span>` : ''}</button>`).join('');
    $('#secForYou').style.display = '';
    $$('#forYou .sug').forEach((b) => (b.onclick = () => { const s = list[+b.dataset.i];
      if (s.source === 'gutenberg' && s.id) { openGutenberg(); showBook(+s.id); }
      else if (s.source === 'general-conference' && CH.gc) { const t = CH.gc.talks.find((t) => t.id === s.id); if (t) loadChurchDoc({ uri: t.uri, sourceId: t.id, title: t.title, author: t.speaker, source: 'general-conference', audio: t.audio }); }
      else if (s.url) window.open(s.url, '_blank'); }));
  } catch (e) { console.warn('suggestions', e); }
}

/* ---------------- My Journals (private: IndexedDB only, never synced) ---------------- */
const JN = { data: null };
async function loadJournals() { JN.data = (await idb.get('journals', 'current'))?.data || null; renderJournalEntry(); }
function renderJournalEntry() { const d = JN.data; $('#jnConnect').style.display = d ? 'none' : ''; $('#jnReady').style.display = d ? '' : 'none'; if (d) $('#jnBtnSub').textContent = `${d.entries.length} entries · ${d.packets.length} packets`; }
async function importJournals(file) {
  showLoading('Importing journals…');
  try {
    let j; try { j = JSON.parse(await file.text()); } catch { throw new UserErr('That file isn’t valid JSON.'); }
    if (!j || j.version !== 1 || !Array.isArray(j.entries)) throw new UserErr('That isn’t a Swift Read journals file (version 1).');
    // one transaction: clear + store each entry with its text; keep a light index (no text) for the browser
    const idx = []; const seen = new Set();
    await new Promise((res, rej) => {
      const t = db.transaction(['jentries', 'journals'], 'readwrite'); const st = t.objectStore('jentries'); st.clear();
      for (const en of j.entries) {
        if (!en || !en.id || typeof en.text !== 'string' || seen.has(en.id)) continue; seen.add(en.id);
        const date = /^\d{4}-\d{2}/.test(en.date || '') ? en.date : '';
        st.put({ id: String(en.id), date, title: en.title || '', topics: en.topics || [], words: en.words || en.text.split(/\s+/).length, text: en.text });
        idx.push({ id: String(en.id), date, title: en.title || '', words: en.words || 0 });
      }
      idx.sort((x, y) => (x.date || '9999').localeCompare(y.date || '9999'));
      t.objectStore('journals').put({ id: 'current', data: { version: 1, generated: j.generated || '', packets: Array.isArray(j.packets) ? j.packets : [], entries: idx }, imported: Date.now() });
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    hideLoading();
    const first = !JN.data; await loadJournals(); renderJournals(); toast(`${first ? 'Connected' : 'Updated'} · ${idx.length.toLocaleString()} entries`);
    if (first && !$('#jnView').classList.contains('active')) openJournals();
  } catch (e) { console.error(e); hideLoading(); toast(e instanceof UserErr ? e.message : 'Couldn’t read that journals file.'); }
}
async function removeJournals() {
  if (!confirm('Remove all journals from this device? (Your original file is not affected.)')) return;
  await idb.del('journals', 'current'); await tx('jentries', 'readwrite', (s) => s.clear());
  for (const m of await idb.all('meta')) if (m.source === 'journal') { await idb.del('docs', m.id); await idb.del('meta', m.id); delete HIST[m.id]; }
  saveH(); JN.data = null; renderJournalEntry(); renderJournals(); toast('Journals removed from this device');
}
function openJournals() { showView('jnView'); history.pushState({ v: 'jn' }, ''); renderJournals(); }
function renderJournals() {
  const box = $('#jnBody'); if (!box) return; const d = JN.data;
  if (!d) { box.innerHTML = '<p class="empty">No journals on this device. Use “Connect journals” on the home screen.</p>'; return; }
  const byId = Object.fromEntries(d.entries.map((e) => [e.id, e]));
  let h = d.packets.length ? '<h2 class="section-title">Packets</h2>' + d.packets.map((p, i) => `<button class="talk jn-p" data-p="${i}"><div class="gi"><div class="gt">${esc(p.title)}</div><div class="ga">${esc(p.teaser || '')}</div><div class="gd">${p.kind === 'story' ? 'Story' : 'Theme'} · ${(p.entryIds || []).filter((x) => byId[x]).length} entries · ${fmtMin((p.entryIds || []).reduce((a, x) => a + (byId[x]?.words || 0), 0))}</div></div></button>`).join('') : '';
  const tree = {}, undated = []; d.entries.forEach((e, i) => { if (!e.date) return undated.push(i); const [y, m] = e.date.split('-'); ((tree[y] ||= {})[m] ||= []).push(i); });
  const rows = (list) => list.map((i) => { const e = d.entries[i]; return `<button class="jn-e" data-e="${i}"><span class="jd">${esc(e.date || '—')}</span><span class="jt">${esc(e.title || 'Untitled')}</span><span class="jw">${fmtMin(e.words)}</span></button>`; }).join('');
  h += '<h2 class="section-title">By date</h2>';
  for (const y of Object.keys(tree).sort().reverse()) {
    h += `<details class="jn-y"><summary>${esc(y)} <span>${Object.values(tree[y]).reduce((a, l) => a + l.length, 0)}</span></summary>`;
    for (const m of Object.keys(tree[y]).sort().reverse()) h += `<details class="jn-m" data-y="${y}" data-m="${m}"><summary>${esc(new Date(+y, +m - 1, 1).toLocaleString(undefined, { month: 'long' }))} <span>${tree[y][m].length}</span></summary></details>`;
    h += '</details>';
  }
  if (undated.length) h += `<details class="jn-y"><summary>Undated <span>${undated.length}</span></summary><details class="jn-m" data-undated="1" open><summary>All undated <span>${undated.length}</span></summary></details></details>`;
  box.innerHTML = h;
  const fill = (dm) => { if (dm.dataset.done) return; dm.dataset.done = 1; dm.insertAdjacentHTML('beforeend', rows(dm.dataset.undated ? undated : tree[dm.dataset.y][dm.dataset.m])); dm.querySelectorAll('.jn-e').forEach((b) => (b.onclick = () => openEntry(+b.dataset.e))); };
  $$('#jnBody .jn-m').forEach((dm) => { dm.addEventListener('toggle', () => dm.open && fill(dm)); if (dm.open) fill(dm); });
  const openEntry = async (i) => { const ix = d.entries[i]; const en = await idb.get('jentries', ix.id); if (en) openJournalDoc('je:' + en.id, en.title || en.date || 'Journal entry', [en]); };
  $$('#jnBody .jn-p').forEach((b) => (b.onclick = () => { const p = d.packets[+b.dataset.p]; Promise.all((p.entryIds || []).map((x) => idb.get('jentries', String(x)))).then((es) => openJournalDoc('jp:' + p.id, p.title, es.filter(Boolean))); }));
}
async function openJournalDoc(sid, title, entries) {
  const ex = (await idb.all('meta')).find((m) => m.source === 'journal' && m.sourceId === sid);
  const paras = [], chapters = [];
  entries.forEach((e) => { chapters.push({ title: `${e.date || ''} · ${e.title || ''}`, paraIdx: paras.length }); paras.push(`${e.title || ''} — ${e.date || ''}`, ...String(e.text).replace(/\r/g, '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)); });
  const text = paras.join('\n\n');
  if (ex) { const doc = await idb.get('docs', ex.id); if (doc && doc.text === text) return openDoc(ex.id); await idb.del('docs', ex.id); await idb.del('meta', ex.id); }
  const id = await addDoc({ title, author: 'Journal', source: 'journal', sourceId: sid, type: 'jrnl', text, chapters: entries.length > 1 ? chapters : [] });
  openDoc(id);
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
  const cur = $('.view.active')?.id; if (cur && cur !== 'readerView') R.from = cur;
  R.id = id; R.meta = meta; R.words = tokenize(doc.text); R.chapters = doc.chapters || [];
  R.sentStart = []; R.words.forEach((w, i) => { if (!i || w.s !== R.words[i - 1].s) R.sentStart[w.s] = i; });
  R.i = Math.min(meta.pos || 0, R.words.length - 1);
  if (R.i >= R.words.length - 1) R.i = 0;
  meta.opened = Date.now(); idb.put('meta', meta); histOpen(meta);
  $('#docTitle').textContent = meta.title;
  $('#chaptersBtn').style.display = R.chapters.length > 1 ? '' : 'none';
  showView('readerView');
  history.pushState({ v: 'reader' }, '');
  render(); showContext(); prepareAudio(meta);
  $('#tapHint').textContent = R.i > 0 ? 'Tap to resume' : 'Tap to play';
}
function showView(id) { $$('.view').forEach((v) => v.classList.toggle('active', v.id === id)); }
async function closeReader() {
  pause(); histSessionFlush(); await savePos(true); const to = R.from || 'libraryView'; showView(to); renderLibrary(); if (to === 'gcView') openConferenceRefresh(); if (to === 'jnView') renderJournals(); renderChurchCard();
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
    if (R.i + chunk.length >= R.words.length) { R.i = R.words.length - 1; render(); pause(); histFinished(); toast('Finished ✨'); return; }
    R.i += chunk.length; render(); savePos(); tick();
  }, delayFor(chunk));
}
function play() {
  if (R.playing || !R.words.length) return;
  if (R.i >= R.words.length - 1) R.i = 0;
  R.playing = true; R.rampN = 0; R.sessionStart = performance.now(); R.sessionWords = 0; R.sessionAt = new Date().toISOString();
  document.body.classList.add('playing'); $('#readerView').classList.add('reading'); hideContext();
  if (R.audio) audioPlay(); else if (R.narr) speakFrom(R.i); else tick();
  wakeLock(true);
}
function pause() {
  if (!R.playing) return;
  R.playing = false; clearTimeout(R.timer);
  if (R.narr) { R.utterGen++; speechSynthesis.cancel(); }
  if (R.audio) { AU.pause(); cancelAnimationFrame(auRaf); }
  document.body.classList.remove('playing'); $('#readerView').classList.remove('reading');
  addTime(performance.now() - R.sessionStart); histSession(performance.now() - R.sessionStart);
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
  if (R.audio) { AU.playbackRate = audioRate(); if (persist && S.wpm / R.baseWpm > MAX_RATE) $('#wpmLabel').textContent = Math.round(R.baseWpm * MAX_RATE) + '*'; }
}

/* ---------------- Speaker audio synced to RSVP (General Conference talks) ---------------- */
const AU = new Audio(); AU.preload = 'none'; AU.preservesPitch = true; AU.webkitPreservesPitch = true; AU.mozPreservesPitch = true;
const MAX_RATE = 2.0; // above ~2x iOS time-stretching gets choppy; cap there
R.align = null; R.audio = false; R.baseWpm = 150;
async function prepareAudio(meta) {
  R.align = null; R.audio = false; $('#audioBtn').style.display = 'none'; AU.pause();
  if (!meta.audio || !meta.sourceId) return;
  try {
    const j = await (await fetch(`talks/${meta.sourceId}.json`)).json();
    if (j.count !== R.words.length) { console.warn('alignment token mismatch', j.count, R.words.length); return; }
    R.align = j.t; R.alignEnd = j.end || (j.t[j.t.length - 1] + 400); R.baseWpm = j.wpm || 150;
    if (AU.src !== meta.audio) AU.src = meta.audio;
    $('#audioBtn').style.display = '';
  } catch {}
}
function audioRate() { return Math.max(0.5, Math.min(MAX_RATE, S.wpm / R.baseWpm)); }
function idxAt(ms) { const t = R.align; let lo = 0, hi = t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= ms) lo = m; else hi = m - 1; } return lo; }
let auRaf = 0;
function audioLoop() {
  if (!R.playing || !R.audio) return;
  const k = idxAt(AU.currentTime * 1000);
  if (k !== R.i) { if (k > R.i) countWords(k - R.i); R.i = k; render(); savePos(); }
  auRaf = requestAnimationFrame(audioLoop);
}
function audioPlay() {
  AU.playbackRate = audioRate(); AU.defaultPlaybackRate = AU.playbackRate;
  const target = (R.align[R.i] || 0) / 1000; if (Math.abs(AU.currentTime - target) > 0.35) AU.currentTime = target;
  AU.play().then(() => { cancelAnimationFrame(auRaf); audioLoop(); }).catch((e) => { console.warn(e); toast('Couldn’t start the audio — check your connection.'); pause(); });
}
AU.onended = () => { if (R.audio && R.playing) { R.i = R.words.length - 1; render(); pause(); histFinished(); toast('Finished ✨'); } };
AU.onwaiting = () => R.audio && R.playing && ($('#tapHint').textContent = 'Buffering…');
function setAudioMode(on) {
  const was = R.playing; if (was) pause();
  R.audio = on && !!R.align; if (R.audio && R.narr) setNarr(false);
  $('#audioBtn').setAttribute('aria-pressed', R.audio);
  toast(R.audio ? `Speaker audio on · ${audioRate().toFixed(2)}× (speed slider adjusts it)` : 'Speaker audio off');
  if (was) play();
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
  if (on && R.audio) setAudioMode(false); R.narr = on; $('#narrateBtn').setAttribute('aria-pressed', on);
  toast(on ? 'Narration on — the voice sets the pace' : 'Narration off');
  if (was) play();
}

/* ---------------- Stats & highlights ---------------- */
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const ST = JSON.parse(localStorage.getItem('sr.stats') || '{"days":{}}');
const saveST = () => localStorage.setItem('sr.stats', JSON.stringify(ST));
function day() { return (ST.days[today()] ||= { w: 0, ms: 0 }); }
function countWords(n) { if (n > 0) { day().w += n; R.sessionWords = (R.sessionWords || 0) + n; saveST(); } }
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
  await idb.put('highlights', { docId: R.id, word: a, text, at: Date.now() }); logEvent('highlight', { text });
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

$('#gutBtn').onclick = openGutenberg;
$('#gutBack').onclick = () => history.back(); $('#gcBack').onclick = () => history.back();
$('#exportBtn').onclick = exportLog;
$('#jnBtn').onclick = openJournals; $('#jnBack').onclick = () => history.back();
$$('.jnFileIn').forEach((inp) => (inp.onchange = (e) => { const f = e.target.files[0]; if (f) importJournals(f); e.target.value = ''; }));
$('#jnRemove').onclick = removeJournals;
$('#syncUrlIn').onchange = (e) => { S.syncUrl = e.target.value.trim(); saveS(); flushSync(); };
$('#syncKeyIn').onchange = (e) => { S.syncKey = e.target.value.trim(); saveS(); flushSync(); };
$('#syncNow').onclick = () => { localStorage.removeItem('sr.syncErr'); flushSync(); toast('Syncing…'); };
$$('#gutTabs button').forEach((b) => (b.onclick = () => { G.mode = b.dataset.m; $$('#gutTabs button').forEach((x) => x.classList.toggle('on', x === b)); $('#gutTopics').style.display = G.mode === 'stories' ? 'none' : ''; $('#gutFeatWrap').style.display = G.mode === 'stories' ? 'none' : ''; G.q = ''; $('#gutSearch').value = ''; gutLoad(true); }));
let gsT; $('#gutSearch').oninput = (e) => { clearTimeout(gsT); gsT = setTimeout(() => { G.q = e.target.value.trim(); if (!G.q) G.topic = 'Popular'; $$('#gutTopics .chip').forEach((x) => x.classList.toggle('on', !G.q && x.dataset.t === G.topic)); gutLoad(true); }, 450); };
$('#gutSearchForm').onsubmit = (e) => { e.preventDefault(); clearTimeout(gsT); G.q = $('#gutSearch').value.trim(); $('#gutSearch').blur(); gutLoad(true); };
$('#gutMain').addEventListener('scroll', (e) => { const m = e.target; if (m.scrollTop + m.clientHeight > m.scrollHeight - 900) gutLoad(false); }, { passive: true });
new IntersectionObserver((es) => { if (es[0].isIntersecting && G.next && $('#gutView').classList.contains('active')) gutLoad(false); }, { root: $('#gutMain'), rootMargin: '600px' }).observe($('#gutSentinel'));
$('#settingsBtn').onclick = $('#settingsBtn2').onclick = () => { loadVoices(); $('#syncUrlIn').value = S.syncUrl; $('#syncKeyIn').value = S.syncKey; syncStatus(); openSheet('settingsSheet'); };
$('#statsBtn').onclick = () => { renderStats(); openSheet('statsSheet'); };
$('#scrim').onclick = closeSheets;
$$('[data-close]').forEach((b) => (b.onclick = closeSheets));
$('#backBtn').onclick = () => history.back();
addEventListener('popstate', () => { if ($('#readerView').classList.contains('active')) closeReader(); else if ($('#gutView').classList.contains('active') || $('#gcView').classList.contains('active') || $('#jnView').classList.contains('active')) { closeSheets(); showView('libraryView'); renderLibrary(); } });
$('#chaptersBtn').onclick = showChapters;
$('#hlListBtn').onclick = showHighlights;
$('#highlightBtn').onclick = saveHighlight;
$('#narrateBtn').onclick = () => setNarr(!R.narr); $('#audioBtn').onclick = () => setAudioMode(!R.audio);
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
$$('details.sec').forEach((d, i) => { const k = 'sr.sec.' + (d.id || i); if (localStorage.getItem(k) === '0') d.open = false; d.addEventListener('toggle', () => localStorage.setItem(k, d.open ? '1' : '0')); });
applySettings();
await document.fonts.ready.catch(() => {});
renderLibrary(); loadChurch(); loadSuggestions(); loadJournals(); flushSync();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__sr = { R, S, idb, tx, HIST, AU, tokenize, churchPage, churchParas, importFile, gutenbergText }; // test hook
