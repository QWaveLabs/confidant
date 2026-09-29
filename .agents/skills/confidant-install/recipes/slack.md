# Slack

Read the person's own DMs and the channels they are already in, through the
Codex Slack app. Do not join a new channel.

1. List the conversations the person is in: DMs and channels.
2. For each one, read its history newest first, then read any threads
   attached to messages in that history.
3. Write the raw messages, as the app returned them, to a JSONL file under
   `.confidant/tmp/`, one message per line. Keep each message's channel
   information attached. `confidant ingest` reads either shape: a wrapper
   like `{"channel": {...}, "messages": [...]}` for a whole channel read,
   or plain per-message objects that already carry their own `channel`
   field.
4. Store them:
   `confidant ingest --source slack --file <path> --cursor-key slack_<channel-id> --cursor-value <the oldest ts you just read>`
5. Move to the next conversation. Cap how many you do in one run; the
   scheduled Brain Update continues the rest every 3 hours.

Read-only, always: only read. Never post, react, edit, or delete a message.
