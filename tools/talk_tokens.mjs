// Dump the exact RSVP token list the app produces for every conference talk -> /tmp/talktok/<id>.json
import { chromium } from 'playwright'; import fs from 'fs';
const U = process.argv[2] || 'http://localhost:8765/'; fs.mkdirSync('/tmp/talktok', { recursive: true });
const gc = JSON.parse(fs.readFileSync('church/conference-latest.json', 'utf8'));
const b = await chromium.launch(); const p = await b.newPage(); await p.goto(U); await p.waitForTimeout(1500);
for (const t of gc.talks) {
  if (fs.existsSync(`/tmp/talktok/${t.id}.json`)) continue;
  try {
    const toks = await p.evaluate(async (uri) => { const j = await __sr.churchPage(uri); return __sr.tokenize(__sr.churchParas(j.content.body).join('\n\n')).map((w) => w.t); }, t.uri);
    fs.writeFileSync(`/tmp/talktok/${t.id}.json`, JSON.stringify({ ...t, tokens: toks })); console.log(t.id, toks.length);
  } catch (e) { console.log('fail', t.id, e.message); }
}
await b.close();
