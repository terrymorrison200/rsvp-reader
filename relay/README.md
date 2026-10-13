# Swift Read relay (Cloudflare Worker)

Tiny relay so the Swift Read PWA can use ElevenLabs narration (and fetch Gutenberg books) without exposing any keys.

| Route | What it does |
|---|---|
| `POST /tts` `{text, voice_id}` | Needs `X-SR-Token` = `SR_TOKEN` and `Origin: https://terrymorrison200.github.io`. Max 10,000 chars/request, daily budget in KV (`DAILY_CHAR_BUDGET`, default 120,000). Forwards to ElevenLabs `/v1/text-to-speech/{voice_id}/with-timestamps` with `eleven_flash_v2_5` and streams the JSON (`audio_base64` + `alignment`) straight back. Header `X-SR-Budget-Remaining`. |
| `GET /voices` | Same token/origin checks; lists your ElevenLabs voices. |
| `GET /gutenberg?id=N&type=txt\|epub` | Fetches only `gutenberg.org` / `gutenberg.pglaf.org` `.txt`/`.epub`, adds CORS for the app origin, cached with the Cache API. |

## Deploy

You need: an ElevenLabs API key, a Cloudflare API token with **Workers Scripts: Edit** (plus **Workers KV Storage: Edit**), and your Cloudflare account id.

```bash
cd relay
export CLOUDFLARE_API_TOKEN=...      # never commit this
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler kv namespace create BUDGET      # paste the id into wrangler.toml
openssl rand -hex 24 | npx wrangler secret put SR_TOKEN   # (note the value: it goes into the app)
npx wrangler secret put ELEVENLABS_KEY       # paste the ElevenLabs key
npx wrangler deploy                          # prints https://swiftread-relay.<subdomain>.workers.dev
```

(`npx wrangler login` works too instead of the API token, interactively.)

Then in Swift Read → Settings → *ElevenLabs voices*: paste the workers.dev URL and the SR_TOKEN value. They are kept in that device's localStorage only. Pick an ElevenLabs voice in the voice list and turn on Narrate.

Change the budget: edit `DAILY_CHAR_BUDGET` in `wrangler.toml` and redeploy.

## Local testing

`node relay/mock.mjs` runs a fake relay on :8788 (synthetic silent MP3 + fake timestamps; no keys needed).

## Google Cloud TTS (`POST /gtts`)

`{text, voice}` → `{audio_base64, alignment, estimated}` (same shape as `/tts`). Uses `v1beta1 text:synthesize` with an SSML `<mark>` before every word and `enableTimePointing: ["SSML_MARK"]`, so word highlighting is exact. Allowed voices: `en-US-Neural2-*` (exact timings) and Chirp 3 HD Charon, Aoede, Puck, Kore, Fenrir, Leda (plain-text input, estimated timings weighted by letters + punctuation pauses; own caps 80,000/day and 1,600,000/month = at most $18/month), plus a hard monthly cap `GOOGLE_MONTHLY_CHAR_BUDGET` (default 950,000) so usage stays inside the 1M free tier. Same token/origin checks, 10-minute KV dedupe, own daily cap `GOOGLE_DAILY_CHAR_BUDGET` (default 30,000 chars). Without the secret it answers 503 `not_configured` and the app does not list Google voices.

```bash
npx wrangler secret put GOOGLE_TTS_KEY   # API key restricted to the Cloud Text-to-Speech API
npx wrangler deploy
node relay/test-gtts.mjs                 # mock test, no network
```
