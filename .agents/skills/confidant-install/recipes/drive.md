# Google Drive and Meet notes

Google Meet's own notes live in Drive, in a folder called "Google Meet,"
with one subfolder per meeting. A legacy folder called "Meet Recordings"
was renamed "Legacy Meet Recordings" in September 2026; check for both
names so older notes are not missed.

`confidant` below means `bin/confidant` during the install (run from the
repo) and the `command` path that `confidant apps --json` prints during a
scheduled run (inside the vault it is `.confidant/engine/bin/confidant`).

## During the install

1. List files in the "Google Meet" folder (and "Legacy Meet Recordings" if
   present), newest first.
2. Open each file and export its text content.
3. Write each file plus its exported text to a JSONL file under
   `.confidant/tmp/`, one object per line:
   `{id, name, mimeType, modifiedTime, webViewLink, text}`.
4. Store them:
   `confidant ingest --source drive --file <path> --cursor-key drive_window --cursor-value <the modifiedTime of the oldest file you stored>`
   Ingest also moves `drive_live` forward to the newest file it stored.
5. Cap how many files you export in one run; the 3-hour Brain Update
   carries on from the saved cursors.

## Every 3 hours (Brain Update)

`confidant apps --json` lists Drive with its saved cursors.

1. **New notes first**: list files in those folders modified after
   `drive_live` (the last 3 days if there is none yet), export and store
   them as above, without `--cursor-key`; ingest moves `drive_live` on its
   own.
2. **Then a few older ones**, unless `drive_window` is `done`: up to 10
   files modified before `drive_window`, newest first, stored with
   `--cursor-key drive_window --cursor-value <the oldest modifiedTime you stored>`.
   When there are none left, store an empty file with
   `--cursor-key drive_window --cursor-value done`.

`confidant ingest` dedupes by file id, so re-sending a file already stored
is harmless, just wasted work.

Read-only, always: only read and export. Never move, rename, share, comment
on, or delete a file.
