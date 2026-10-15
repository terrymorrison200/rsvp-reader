// Deterministic fake "TTS voice" for narration-sync tests: produces a WAV whose words have KNOWN start times
// (variable speaking rate per sentence, punctuation / paragraph pauses, leading + trailing silence, odd mid-sentence hesitations).
// Also a tiny static server + fake relay (/gtts, /tts, /voices) so the real app runs unmodified against it.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const SR = 16000;
const rng = (seed) => () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) | 0) >>> 0) / 4294967296;
const hash = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export function synth(text, opt = {}) {
  const rate = opt.rate || 1; const r = rng(hash(text) + (opt.seed || 0));
  const toks = []; const re = /\S+/g; let m; while ((m = re.exec(text))) toks.push({ t: m[0], after: text.slice(m.index + m[0].length).match(/^\s*/)[0] });
  const segs = []; let t = 0; const starts = []; const lead = 0.4 + r() * 0.3; t += lead; let sentRate = 0.75 + r() * 0.7;
  toks.forEach((w, k) => {
    const L = w.t.replace(/[^\p{L}\p{N}]/gu, '').length; const d = (0.07 + 0.028 * L) * sentRate / rate; starts.push(t); segs.push([t, t + d, 150 + ((hash(w.t) % 90) * 3)]); t += d;
    const para = /\n\s*\n/.test(w.after), sent = /[.!?]["”’)]*$/.test(w.t), semi = /[;:—]["”’)]*$/.test(w.t), comma = /,["”’)]*$/.test(w.t);
    t += para ? 0.85 + r() * 0.25 : sent ? 0.38 + r() * 0.3 : semi ? 0.26 : comma ? 0.12 + r() * 0.2 : r() < 0.05 ? 0.15 : 0.035;
    if (sent || para) sentRate = 0.75 + r() * 0.7; // each sentence is spoken at its own speed
  });
  const total = t + 0.25 + r() * 0.1; const n = Math.ceil(total * SR); const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = ((i * 7919) % 13) - 6; // faint noise floor
  for (const [a, b, f] of segs) { const i0 = Math.floor(a * SR), i1 = Math.min(n, Math.floor(b * SR)); for (let i = i0; i < i1; i++) { const x = Math.min(1, (i - i0) / 160, (i1 - i) / 160); pcm[i] = Math.round(9000 * x * Math.sin((2 * Math.PI * f * i) / SR)); } }
  const wav = Buffer.alloc(44 + n * 2); wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40); Buffer.from(pcm.buffer).copy(wav, 44);
  return { wav, dur: n / SR, words: toks.map((w) => w.t), starts, speechEnd: segs[segs.length - 1][1] };
}
// the relay's own estimator for Chirp 3 HD (copied from relay/worker.js): letters + punctuation weights stretched over the whole file
function estStarts(words, dur) { const wt = words.map((w) => { const L = w.replace(/[^\p{L}\p{N}]/gu, '').length; return 1.5 + L + (/[.!?]["”’)]*$/.test(w) ? 7 : /[;:—]["”’)]*$/.test(w) ? 4.5 : /[,–]["”’)]*$/.test(w) ? 3 : 0); }); const tot = wt.reduce((a, b) => a + b, 0) || 1; let c = 0; return wt.map((x) => { const t = (c / tot) * dur; c += x; return t; }); }
function alignmentOf(words, st, dur) { const characters = [], s0 = [], e0 = []; words.forEach((w, i) => { const t = st[i], tn = i + 1 < words.length ? st[i + 1] : dur; if (i) { characters.push(' '); s0.push(t); e0.push(t); } for (const ch of w) { characters.push(ch); s0.push(t); e0.push(tn); } }); return { characters, character_start_times_seconds: s0, character_end_times_seconds: e0 }; }

export function startServer(root, { latency = 120 } = {}) {
  const truth = new Map(); const log = []; // key: words.join(' ') -> {starts,dur,speechEnd}
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-SR-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'X-SR-Budget-Remaining' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'POST' && (url.pathname === '/gtts' || url.pathname === '/tts')) {
      let b = ''; for await (const c of req) b += c; const j = JSON.parse(b || '{}'); const text = String(j.text || '');
      if (!text.trim()) { res.writeHead(400, cors); return res.end('{}'); }
      await new Promise((r) => setTimeout(r, latency));
      const chirp = /Chirp3/.test(j.voice || ''); const s = synth(text, { rate: 1 }); const key = s.words.join(' ');
      truth.set(key, { starts: s.starts, dur: s.dur, speechEnd: s.speechEnd, chirp }); log.push({ chars: text.length, chirp, words: s.words.length, dur: s.dur, key });
      const st = chirp ? estStarts(s.words, s.dur) : s.starts; // Chirp: estimated; Neural2 / ElevenLabs: exact
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'X-SR-Budget-Remaining': '99999' });
      return res.end(JSON.stringify({ audio_base64: s.wav.toString('base64'), alignment: alignmentOf(s.words, st, s.dur), estimated: chirp }));
    }
    if (url.pathname === '/truth') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify([...truth])); }
    if (url.pathname === '/voices') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ voices: [] })); }
    let p = path.join(root, decodeURIComponent(url.pathname)); if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { ...cors, 'Content-Type': mime[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(d); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port + '/', close: () => srv.close(), truth, log })));
}
