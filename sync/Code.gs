/**
 * Swift Read → Google Sheet sync (Apps Script web app, bound to a private Sheet).
 * The app POSTs {key, device, events:[...]} as text/plain. Rows are appended to tabs:
 *   Sessions   – every event (open / session / finished / highlight), one row each
 *   Books      – one row per book (upserted by docId): progress, words read, finished
 *   Highlights – saved sentences
 * Security: requests must carry the shared secret stored in Script Properties (SYNC_KEY).
 * The Sheet itself stays private to the owner; the web app only appends, never returns data.
 */
const TABS = {
  Sessions: ['received', 'at', 'type', 'docId', 'title', 'author', 'source', 'sourceId', 'words', 'seconds', 'wpm', 'setWpm', 'mode', 'pos', 'pct', 'total', 'finished', 'tz', 'device', 'raw'],
  Books: ['docId', 'title', 'author', 'source', 'sourceId', 'totalWords', 'wordsRead', 'pct', 'finished', 'sessions', 'firstSeen', 'lastActivity'],
  Highlights: ['at', 'docId', 'title', 'author', 'source', 'sourceId', 'text'],
};

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  const key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!key || !body || typeof body.key !== 'string' || !safeEq(body.key, key)) return out({ ok: false, error: 'bad key' });
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = {}; Object.keys(TABS).forEach((n) => (sh[n] = tab(ss, n)));
    const now = new Date().toISOString(); const dev = String(body.device || '').slice(0, 120);
    const rows = events.map((ev) => [now, s(ev.at), s(ev.type), s(ev.docId), s(ev.title), s(ev.author), s(ev.source), s(ev.sourceId), n(ev.words), n(ev.seconds), n(ev.wpm), n(ev.setWpm), s(ev.mode), n(ev.pos), n(ev.pct), n(ev.total), ev.finished === true || ev.type === 'finished', s(ev.tz), dev, JSON.stringify(ev).slice(0, 2000)]);
    if (rows.length) sh.Sessions.getRange(sh.Sessions.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    const hl = events.filter((ev) => ev.type === 'highlight').map((ev) => [s(ev.at), s(ev.docId), s(ev.title), s(ev.author), s(ev.source), s(ev.sourceId), s(ev.text).slice(0, 5000)]);
    if (hl.length) sh.Highlights.getRange(sh.Highlights.getLastRow() + 1, 1, hl.length, hl[0].length).setValues(hl);
    upsertBooks(sh.Books, events);
    return out({ ok: true, received: events.length });
  } finally { lock.releaseLock(); }
}

function doGet() { return ContentService.createTextOutput('Swift Read sync is running.'); }

function upsertBooks(sheet, events) {
  const data = sheet.getDataRange().getValues(); const idx = {};
  for (let r = 1; r < data.length; r++) idx[data[r][0]] = r;
  events.forEach((ev) => {
    if (!ev.docId) return;
    let r = idx[ev.docId];
    if (r === undefined) { r = data.length; idx[ev.docId] = r; data.push([ev.docId, '', '', '', '', 0, 0, 0, false, 0, s(ev.at), '']); }
    const row = data[r];
    row[1] = s(ev.title) || row[1]; row[2] = s(ev.author) || row[2]; row[3] = s(ev.source) || row[3]; row[4] = s(ev.sourceId) || row[4];
    if (ev.total) row[5] = ev.total;
    if (ev.type === 'session') { row[6] = Number(row[6] || 0) + n(ev.words); row[9] = Number(row[9] || 0) + 1; if (ev.pct !== undefined) row[7] = ev.pct; }
    if (ev.type === 'finished' || ev.finished === true) row[8] = true;
    row[11] = s(ev.at);
  });
  if (data.length > 1) sheet.getRange(2, 1, data.length - 1, TABS.Books.length).setValues(data.slice(1));
}

function tab(ss, name) {
  let t = ss.getSheetByName(name);
  if (!t) { t = ss.insertSheet(name); t.appendRow(TABS[name]); t.setFrozenRows(1); }
  return t;
}
const s = (v) => (v === undefined || v === null ? '' : String(v)).replace(/^[=+\-@]/, "'$&"); // block formula injection
const n = (v) => (typeof v === 'number' && isFinite(v) ? v : '');
function safeEq(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

/** Run once from the editor: creates the tabs and a random SYNC_KEY, and logs it. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); Object.keys(TABS).forEach((n) => tab(ss, n));
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SYNC_KEY')) p.setProperty('SYNC_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  Logger.log('SYNC_KEY = ' + p.getProperty('SYNC_KEY'));
}
