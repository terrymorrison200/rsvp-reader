// Swift Read relay — Cloudflare Worker. Secrets (never in the repo): SR_TOKEN, ELEVENLABS_KEY. KV binding: BUDGET.
const ORIGIN = 'https://terrymorrison200.github.io';
const MAX_CHARS = 10000;
const cors = (h = {}) => ({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, X-SR-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'X-SR-Budget-Remaining', 'Vary': 'Origin', ...h });
const CODES = { 400: 'bad_request', 401: 'bad_token', 403: 'origin_not_allowed', 404: 'not_found', 413: 'too_long', 429: 'budget_reached', 502: 'upstream_error' };
const err = (status, message, code = CODES[status] || 'error', extra = {}) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: cors({ 'Content-Type': 'application/json', ...extra }) });
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const DEDUPE_SECONDS = 600; // identical text+voice within 10 min is served from cache (no credits)
const day = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors({ 'Access-Control-Max-Age': '86400' }) });
    if (req.headers.get('Origin') !== ORIGIN) return err(403, 'origin not allowed');

    if (url.pathname === '/gutenberg' && req.method === 'GET') return gutenberg(url, ctx);

    // everything else needs the shared token
    if (!env.SR_TOKEN || req.headers.get('X-SR-Token') !== env.SR_TOKEN) return err(401, 'bad token');

    if (url.pathname === '/voices' && req.method === 'GET') {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': env.ELEVENLABS_KEY } });
      return new Response(r.body, { status: r.status, headers: cors({ 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' }) });
    }

    if (url.pathname === '/tts' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return err(400, 'bad json'); }
      const text = String(body.text || ''); const voice = String(body.voice_id || '21m00Tcm4TlvDq8ikWAM');
      if (!text) return err(400, 'no text');
      if (text.length > MAX_CHARS) return err(413, `max ${MAX_CHARS} characters per request`);
      if (!/^[A-Za-z0-9]{10,40}$/.test(voice)) return err(400, 'bad voice id');
      // Cache API is a no-op on *.workers.dev, so dedupe via KV (TTL 10 min)
      const dk = 'tts:' + (await sha(voice + '|' + text));
      const hit = await env.BUDGET.get(dk, 'stream');
      if (hit) return new Response(hit, { headers: cors({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }) });
      const limit = +(env.DAILY_CHAR_BUDGET || 120000); const key = 'chars:' + day();
      const used = +((await env.BUDGET.get(key)) || 0);
      if (used + text.length > limit) return err(429, 'daily character budget reached', 'budget_reached', { 'X-SR-Budget-Remaining': String(Math.max(0, limit - used)) });
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
        method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      });
      if (!r.ok) {
        const raw = await r.text(); let d = {}; try { d = JSON.parse(raw).detail || {}; } catch {}
        const code = String(d.status || d.code || 'upstream_error'); const quota = /quota|credit/i.test(code + ' ' + (d.message || ''));
        return err(quota ? 429 : r.status === 401 ? 502 : r.status, quota ? 'ElevenLabs credits used up' : String(d.message || raw).slice(0, 200), quota ? 'quota_exceeded' : code);
      }
      ctx.waitUntil(env.BUDGET.put(key, String(used + text.length), { expirationTtl: 3 * 86400 }));
      const [a, b] = r.body.tee();
      ctx.waitUntil(new Response(b).text().then((t) => env.BUDGET.put(dk, t, { expirationTtl: DEDUPE_SECONDS })));
      return new Response(a, { headers: cors({ 'Content-Type': 'application/json', 'X-Cache': 'MISS', 'X-SR-Budget-Remaining': String(Math.max(0, limit - used - text.length)) }) });
    }
    if (url.pathname === '/gtts' && req.method === 'POST') return gtts(req, env, ctx);
    return err(404, 'not found');
  },
};

async function gutenberg(url, ctx) {
  const id = url.searchParams.get('id'); const type = url.searchParams.get('type') === 'epub' ? 'epub' : 'txt';
  if (!/^\d{1,6}$/.test(id || '')) return err(400, 'bad id');
  const cacheKey = new Request(`https://relay.cache/gutenberg/${id}.${type}`);
  const cache = caches.default;
  let hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: cors({ 'Content-Type': hit.headers.get('Content-Type'), 'X-Cache': 'HIT' }) });
  // only gutenberg.org .txt / .epub URLs are ever fetched
  const srcs = [`https://www.gutenberg.org/cache/epub/${id}/pg${id}.${type}`, `https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}.${type}`];
  for (const src of srcs) {
    const r = await fetch(src, { redirect: 'follow' });
    if (!r.ok || !/^https:\/\/([a-z]+\.)?(gutenberg|pglaf)\.org\//.test(r.url || src)) continue;
    const ct = type === 'epub' ? 'application/epub+zip' : 'text/plain; charset=utf-8';
    const [a, b] = r.body.tee();
    ctx.waitUntil(cache.put(cacheKey, new Response(b, { headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=2592000' } })));
    return new Response(a, { headers: cors({ 'Content-Type': ct, 'X-Cache': 'MISS' }) });
  }
  return err(502, 'gutenberg fetch failed');
}

// ---------- Google Cloud TTS (v1beta1, SSML <mark> per word -> word timings) ----------
// Allowed voices: en-US Neural2 only. Caps keep usage inside Google's free tier: 30k chars/day and a hard 950k chars/month.
const GVOICE = /^en-US-Neural2-[A-J]$/; // Neural2 only (free tier: 1M chars/month)
const xmlEsc = (t) => t.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
async function gtts(req, env, ctx) {
  if (!env.SR_TOKEN || req.headers.get('X-SR-Token') !== env.SR_TOKEN) return err(401, 'bad token');
  if (!env.GOOGLE_TTS_KEY) return err(503, 'Google voices are not set up yet', 'not_configured');
  let body; try { body = await req.json(); } catch { return err(400, 'bad json'); }
  const text = String(body.text || '').trim(); const voice = String(body.voice || 'en-US-Neural2-J');
  if (!text) return err(400, 'no text');
  if (text.length > 2000) return err(413, 'max 2000 characters per request');
  if (!GVOICE.test(voice)) return err(400, 'voice not allowed');
  const words = text.split(/\s+/);
  const dk = 'g:' + (await sha(voice + '|' + text));
  const hit = await env.BUDGET.get(dk, 'stream');
  if (hit) return new Response(hit, { headers: cors({ 'Content-Type': 'application/json', 'X-Cache': 'HIT' }) });
  const limit = +(env.GOOGLE_DAILY_CHAR_BUDGET || 30000); const key = 'gchars:' + day();
  const mlimit = +(env.GOOGLE_MONTHLY_CHAR_BUDGET || 950000); const mkey = 'gmonth:' + day().slice(0, 7);
  const [used, mused] = (await Promise.all([env.BUDGET.get(key), env.BUDGET.get(mkey)])).map((v) => +(v || 0));
  if (mused + text.length > mlimit) return err(429, 'monthly Google voice limit reached (stays inside the free tier)', 'budget_reached', { 'X-SR-Budget-Remaining': '0' });
  if (used + text.length > limit) return err(429, 'daily Google voice budget reached', 'budget_reached', { 'X-SR-Budget-Remaining': String(Math.max(0, limit - used)) });
  const chirp = /Chirp3/.test(voice);
  const ssml = '<speak>' + words.map((w, i) => (chirp ? '' : `<mark name="${i}"/>`) + xmlEsc(w)).join(' ') + '</speak>';
  const r = await fetch('https://texttospeech.googleapis.com/v1beta1/text:synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_TTS_KEY },
    body: JSON.stringify({ input: { ssml }, voice: { languageCode: 'en-US', name: voice }, audioConfig: { audioEncoding: 'MP3' }, ...(chirp ? {} : { enableTimePointing: ['SSML_MARK'] }) }),
  });
  if (!r.ok) {
    const raw = await r.text(); let e = {}; try { e = JSON.parse(raw).error || {}; } catch {}
    const quota = r.status === 429 || /RESOURCE_EXHAUSTED|quota|billing/i.test((e.status || '') + ' ' + (e.message || ''));
    return err(quota ? 429 : 502, quota ? 'Google voice quota or billing limit reached' : String(e.message || raw).slice(0, 200), quota ? 'quota_exceeded' : String(e.status || 'upstream_error'));
  }
  const j = await r.json(); const audio = j.audioContent || '';
  // word start times: from marks, or (Chirp3) estimated by character share of the MP3 duration (32 kbps CBR)
  let st = new Array(words.length).fill(null), est = false;
  for (const tp of j.timepoints || []) { const i = +tp.markName; if (i >= 0 && i < words.length) st[i] = +tp.timeSeconds || 0; }
  const dur = (audio.length * 0.75 * 8) / 32000;
  if (st.some((x) => x == null)) { est = true; const tot = text.length; let c = 0; st = words.map((w) => { const t = (c / tot) * dur; c += w.length + 1; return t; }); }
  // shape like ElevenLabs alignment: one entry per character, every char of a word starts at the word's time
  const characters = [], s0 = [], e0 = [];
  words.forEach((w, i) => { const t = st[i], tn = i + 1 < words.length ? st[i + 1] : dur; if (i) { characters.push(' '); s0.push(t); e0.push(t); } for (const ch of w) { characters.push(ch); s0.push(t); e0.push(tn); } });
  const out = JSON.stringify({ audio_base64: audio, alignment: { characters, character_start_times_seconds: s0, character_end_times_seconds: e0 }, estimated: est });
  ctx.waitUntil(env.BUDGET.put(key, String(used + text.length), { expirationTtl: 3 * 86400 }));
  ctx.waitUntil(env.BUDGET.put(mkey, String(mused + text.length), { expirationTtl: 40 * 86400 }));
  ctx.waitUntil(env.BUDGET.put(dk, out, { expirationTtl: DEDUPE_SECONDS }));
  return new Response(out, { headers: cors({ 'Content-Type': 'application/json', 'X-Cache': 'MISS', 'X-SR-Budget-Remaining': String(Math.max(0, limit - used - text.length)) }) });
}
