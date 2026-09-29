# Google Drive and Meet notes

Google Meet's own notes live in Drive, in a folder called "Google Meet,"
with one subfolder per meeting. A legacy folder called "Meet Recordings"
was renamed "Legacy Meet Recordings" in September 2026; check for both
names so older notes are not missed.

1. List files in the "Google Meet" folder (and "Legacy Meet Recordings" if
   present), newest first.
2. For each file Confidant has not seen, open it and export its text
   content. `bin/confidant ingest` dedupes by file id, so re-sending a file
   already stored is harmless, just wasted work; prefer skipping files you
   already exported this run.
3. Write each file plus its exported text to a JSONL file under
   `.confidant/tmp/`, one object per line:
   `{id, name, mimeType, modifiedTime, webViewLink, text}`.
4. Store them:
   `bin/confidant ingest --source drive --file <path> --cursor-key drive_folder --cursor-value <the folder you just finished>`
5. Cap how many files you export in one run; the scheduled Brain Update
   continues the rest every 3 hours.

Read-only, always: only read and export. Never move, rename, share, comment
on, or delete a file.
