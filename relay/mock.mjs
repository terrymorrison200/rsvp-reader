// Mock Swift Read relay for local testing: node relay/mock.mjs [port]
// Same contract as worker.js, but returns a silent WAV + synthetic character timestamps (0.06 s/char). No keys needed.
import http from 'node:http';
const PORT = +(process.argv[2] || 8788); const TOKEN = process.env.SR_TOKEN || 'test-token';
export const stats = { tts: 0, chars: 0 };
function wav(sec) { const sr = 8000, n = Math.ceil(sec * sr), b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; }
const hdr = (o) => ({ 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Headers': 'Content-Type, X-SR-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'X-SR-Budget-Remaining' });
http.createServer(async (req, res) => {
  const h = hdr(req.headers.origin); const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  if (url.pathname === '/stats') { res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(stats)); }
  if (req.headers['x-sr-token'] !== TOKEN) { res.writeHead(401, h); return res.end('bad token'); }
  if (url.pathname === '/voices') { res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ voices: [{ voice_id: 'mockvoice0001', name: 'Mock Voice' }] })); }
  if (url.pathname === '/tts' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c; const { text } = JSON.parse(body);
    if (text.length > 10000) { res.writeHead(413, h); return res.end('too long'); }
    stats.tts++; stats.chars += text.length;
    const per = 0.06, chars = [...text];
    const alignment = { characters: chars, character_start_times_seconds: chars.map((_, i) => +(i * per).toFixed(3)), character_end_times_seconds: chars.map((_, i) => +((i + 1) * per).toFixed(3)) };
    res.writeHead(200, { ...h, 'Content-Type': 'application/json', 'X-SR-Budget-Remaining': String(120000 - stats.chars) });
    return res.end(JSON.stringify({ audio_base64: wav(chars.length * per + 0.2).toString('base64'), alignment, normalized_alignment: alignment }));
  }
  res.writeHead(404, h); res.end('not found');
}).listen(PORT, () => console.log('mock relay on http://localhost:' + PORT));
