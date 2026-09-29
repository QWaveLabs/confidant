# Google Calendar

Read events through the Codex Google Calendar app, newest first, in date
windows the same way as Gmail (see `gmail.md`).

For each window:

1. List events in that range.
2. Write the raw event objects, exactly as the app returned them, to a
   JSONL file under `.confidant/tmp/`, one event per line.
3. Store them:
   `confidant ingest --source gcal --file <path> --cursor-key gcal_window --cursor-value <the window's start date>`
4. Move to the next older window. Cap how many windows you do in one run;
   the scheduled Brain Update continues the rest every 3 hours.

If a call fails, say so plainly and move on; do not retry more than once.

Read-only, always: never accept, decline, propose a new time for, or create
a meeting.
