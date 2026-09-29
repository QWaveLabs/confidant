# Gmail

Prefer Mail.app when the person already has this Google account added to
the macOS Mail app: that reads the whole history locally, for free, and the
local mail extractor already covers it. Ask first. If the account is in
Mail.app, skip this recipe entirely and say so.

`confidant` below means `bin/confidant` during the install (run from the
repo) and the `command` path that `confidant apps --json` prints during a
scheduled run (inside the vault it is `.confidant/engine/bin/confidant`).

## Once per run: the privacy suffix

Work out the privacy search suffix once. Run this from the vault root
(once `.confidant/config.json` exists):
`sh .confidant/engine/bin/node -e "import('./.confidant/engine/engine/privacy.mjs').then(m => console.log(m.emailQuery(JSON.parse(require('fs').readFileSync('.confidant/config.json','utf8')))))"`
That loads `engine/privacy.mjs` and calls `emailQuery(config)` with the
vault's config. Append the result to every Gmail search below. It already
encodes the person's exclusions (banking, health, excluded senders, and so
on); do not build your own filters on top of it.

## During the install: history, newest first

1. Search in date windows (for example 30 days at a time), going backward
   from today: `after:2026-08-01 before:2026-09-01 <privacy suffix>`.
2. Read matching messages in batches of up to 100 with `batch_read_email`.
   Never paste message bodies into the chat; only write them to the temp
   file below.
3. Write the raw tool results (the array the Gmail app returned, or its
   messages) to a temporary JSONL file under `.confidant/tmp/`, one JSON
   object per line.
4. Store them:
   `confidant ingest --source gmail --account <the connected Gmail address> --file <path> --cursor-key gmail_window --cursor-value <the window's start date>`
   Ingest also moves `gmail_live` forward to the newest message it stored,
   so the scheduled runs know where new mail starts.
5. Move to the next older window and repeat. Cap how many windows you do in
   one run (a handful), then stop. The 3-hour Brain Update carries on from
   the saved cursors.

## Every 3 hours (Brain Update)

`confidant apps --json` lists Gmail with its saved cursors.

1. **New mail first.** Search `after:<the date of gmail_live, minus one day> <privacy suffix>`
   (Gmail's `after:` works by day; the day of overlap is harmless, because
   ingest skips messages it already has). Read, write and store them the
   same way as above, without `--cursor-key`: ingest moves `gmail_live`
   forward on its own. If there is no `gmail_live` yet, use the last 3 days.
2. **Then one older window** of history, unless `gmail_window` is `done`:
   the 30 days before `gmail_window`, stored with
   `--cursor-key gmail_window --cursor-value <that window's start date>`.
   If a search for `before:<gmail_window> <privacy suffix>` finds nothing at
   all, the history is complete: store an empty file with
   `--cursor-key gmail_window --cursor-value done`.

If a search or read call fails, say so plainly in this run's reply and move
on; do not retry more than once.

Reading Gmail through the Codex app passes message content through the
model, which uses the person's usage. Mail.app costs nothing and is
preferred whenever it is available.

Read-only, always: never send, reply, forward, label, archive or delete
anything.
