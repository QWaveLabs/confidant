# Slack

Read the person's own DMs and the channels they are already in, through the
Codex Slack app. Do not join a new channel.

Before reading, check the person's exclusions in `.confidant/config.json`
(`exclusions.people`, `.chats`, `.handles`, `.keywords`). Skip any DM with an
excluded person and any channel whose name is excluded, and never open it;
ingest also filters what it stores, but an excluded conversation should
never be read at all.

`confidant` below means `bin/confidant` during the install (run from the
repo) and the `command` path that `confidant apps --json` prints during a
scheduled run (inside the vault it is `.confidant/engine/bin/confidant`).

Write the raw messages, as the app returned them, to a JSONL file under
`.confidant/tmp/`, one message per line. Keep each message's channel
information attached. `confidant ingest` reads either shape: a wrapper like
`{"channel": {...}, "messages": [...]}` for a whole channel read, or plain
per-message objects that already carry their own `channel` field. Ingest
also moves `slack_live` forward to the newest message it stored.

## During the install

1. List the conversations the person is in: DMs and channels.
2. For each one, read its history newest first, then read any threads
   attached to messages in that history.
3. Store them:
   `confidant ingest --source slack --file <path> --cursor-key slack_<channel-id> --cursor-value <the oldest ts you just read>`
4. Move to the next conversation. Cap how many you do in one run; the
   3-hour Brain Update carries on from the saved cursors.

## Every 3 hours (Brain Update)

`confidant apps --json` lists Slack with its saved cursors.

1. **New messages first**: in every DM and channel the person is in, read
   the messages newer than `slack_live` (as a Slack timestamp, the
   `oldest` of a history read, or `after:` in a search), plus new replies
   in threads they started or joined. Use the last 3 days if there is no
   `slack_live` yet. Store them without `--cursor-key`.
2. **Then older history** for up to 3 conversations whose
   `slack_<channel-id>` cursor is not `done`: the messages before that
   cursor, stored with
   `--cursor-key slack_<channel-id> --cursor-value <the oldest ts you just read>`,
   or `done` when that conversation has nothing older.

If a call fails, say so plainly in this run's reply and move on; do not
retry more than once.

Read-only, always: only read. Never post, react, edit, or delete a message.
