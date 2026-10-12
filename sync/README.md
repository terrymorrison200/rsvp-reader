# Swift Read → Google Sheet sync (setup, ~5 minutes, one time)

Swift Read queues reading events on the iPhone (IndexedDB "outbox") and POSTs them automatically
(on every open/pause/finish/highlight, when the app comes to the foreground, every 2 min, and when back online)
to a Google Apps Script web app that appends them to a **private** Google Sheet. The Reading Guide bot reads the
Sheet via the Google Drive connector.

## Steps (signed in as terrymorrison200@gmail.com)
1. Go to https://sheets.new — name the sheet **Swift Read Log**.
2. In the sheet: **Extensions → Apps Script**. Delete the sample code, paste all of `Code.gs`, click **Save**.
3. In the function dropdown pick **setup**, click **Run**, and approve the permission prompt
   (it only needs access to this spreadsheet). Open **Execution log** and copy the `SYNC_KEY = …` value.
   (It is stored in Project Settings → Script properties; you can change it there any time.)
4. **Deploy → New deployment → type: Web app**. Description "Swift Read sync".
   *Execute as:* **Me**. *Who has access:* **Anyone** (required so the phone can POST without a Google login;
   the SYNC_KEY is what protects it, and the script never returns sheet data). Click **Deploy**, copy the
   **Web app URL** (ends in `/exec`).
5. Pair the phone — either:
   * open this link on the iPhone (in Safari, then reopen the home-screen app once — or paste the fields in step b):
     `https://terrymorrison200.github.io/rsvp-reader/#sync=<WEB_APP_URL>&key=<SYNC_KEY>`
     *Note:* iOS home-screen apps have their own storage, separate from Safari, so the most reliable way is (b).
   * (b) In Swift Read: **Settings → Reading sync** → paste the Web app URL and the key → **Sync now**.
     The status line shows "Last synced …".
6. Tabs **Sessions**, **Books**, **Highlights** fill in automatically.

If you redeploy after editing the code, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

Event fields: type (open|session|finished|highlight), at, tz, docId, title, author, source (gutenberg |
general-conference | cfm-scripture | cfm | local), sourceId (Gutenberg id or talk id), words, seconds, wpm (actual),
setWpm, mode (rsvp|audio|narrate), pos, pct, total, finished, text (highlights).
