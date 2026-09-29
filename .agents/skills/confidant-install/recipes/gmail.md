# Gmail

Prefer Mail.app when the person already has this Google account added to
the macOS Mail app: that reads the whole history locally, for free, and the
local mail extractor already covers it. Ask first. If the account is in
Mail.app, skip this recipe entirely and say so.

Otherwise, page the person's Gmail through the Codex Gmail app:

1. Work out the privacy search suffix once. Run this from the vault root
   (once `.confidant/config.json` exists):
   `sh .confidant/engine/bin/node -e "import('./.confidant/engine/engine/privacy.mjs').then(m => console.log(m.emailQuery(JSON.parse(require('fs').readFileSync('.confidant/config.json','utf8')))))"`
   That loads `engine/privacy.mjs` and calls `emailQuery(config)` with the
   vault's config. Append the result to every Gmail search you run below.
   It already encodes the person's exclusions (banking, health, excluded
   senders, and so on); do not build your own filters on top of it.
2. Search newest first, in date windows (for example 30 days at a time),
   going backward: `after:2026-08-01 before:2026-09-01 <privacy suffix>`.
3. Read matching messages in batches of up to 100 with `batch_read_email`.
   Never paste message bodies into the chat; only write them to the temp
   file below.
4. Write the raw tool results (the array the Gmail app returned, or its
   messages) to a temporary JSONL file under `.confidant/tmp/`, one JSON
   object per line.
5. Store them:
   `bin/confidant ingest --source gmail --account <the connected Gmail address> --file <path> --cursor-key gmail_window --cursor-value <the window's start date>`
6. Move to the next older window and repeat. Cap how many windows you do in
   one run (a handful), then stop. The scheduled Brain Update continues the
   backfill automatically every 3 hours, using the saved `gmail_window`
   cursor. There is no command that prints a cursor's value back to you;
   keep track of which window you last completed for this run yourself.
7. If a search or read call fails, say so plainly and move on; do not
   retry more than once.

Reading Gmail through the Codex app passes message content through the
model, which uses the person's usage. Mail.app costs nothing and is
preferred whenever it is available.

Read-only, always: never send, reply, forward, label, archive or delete
anything.
