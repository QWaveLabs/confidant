# Google Calendar

Prefer the Mac's Calendar app when this Google account is already added
there: the local calendar extractor reads it, including the next 60 days.
Skip this recipe for an account the Calendar app already has, and say so.

`confidant` below means `bin/confidant` during the install (run from the
repo) and the `command` path that `confidant apps --json` prints during a
scheduled run (inside the vault it is `.confidant/engine/bin/confidant`).

Skip events whose status is cancelled and events the person declined.

## During the install

1. **Upcoming first**: list events from yesterday through 14 days from
   today. Meeting Prep and the Morning Brief read these, so without them
   neither can see a Google-only meeting. Write the raw event objects,
   exactly as the app returned them, to a JSONL file under
   `.confidant/tmp/`, one event per line, and store them:
   `confidant ingest --source gcal --file <path> --cursor-key gcal_upcoming --cursor-value <today's date>`
2. **Then history, newest first**, in 30-day windows going backward from
   yesterday. For each window, list its events, write them the same way,
   and store them:
   `confidant ingest --source gcal --file <path> --cursor-key gcal_window --cursor-value <the window's start date>`
   Cap how many windows you do in one run; the 3-hour Brain Update carries
   on from the saved cursor.

## Every 3 hours (Brain Update)

`confidant apps --json` lists Google Calendar with its saved cursors.

1. **Always re-read yesterday through 14 days from today**, exactly as in
   step 1 above. This picks up new meetings, moved ones and new attendees
   before Meeting Prep and the Morning Brief run.
2. **Then one older window** of history, unless `gcal_window` is `done`:
   the 30 days before `gcal_window`, stored with
   `--cursor-key gcal_window --cursor-value <that window's start date>`.
   When a window and the one before it are both empty, store an empty file
   with `--cursor-key gcal_window --cursor-value done`.

If a call fails, say so plainly in this run's reply and move on; do not
retry more than once.

Read-only, always: never accept, decline, propose a new time for, or create
a meeting.
