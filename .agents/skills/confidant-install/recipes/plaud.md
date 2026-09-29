# Plaud

Plaud has no public API. Check first whether the person has a Plaud MCP
server or CLI installed; ask them, or look for one among Codex's connected
apps.

`confidant` below means `bin/confidant` during the install (run from the
repo) and the `command` path that `confidant apps --json` prints during a
scheduled run (inside the vault it is `.confidant/engine/bin/confidant`).

## During the install, if a Plaud tool is available

1. List recordings, newest first.
2. Write each recording's metadata and transcript to a JSONL file under
   `.confidant/tmp/`, one recording per line:
   `{id, title, created_at, duration, transcript, summary, participants}`.
3. Store them:
   `confidant ingest --source plaud --file <path> --cursor-key plaud_window --cursor-value <the oldest recording's date>`
   Ingest also moves `plaud_live` forward to the newest recording it stored.
4. Cap how many recordings you do in one run; the 3-hour Brain Update
   carries on from the saved cursors.

## Every 3 hours (Brain Update)

Only when a Plaud tool is available. `confidant apps --json` lists Plaud
with its saved cursors.

1. **New recordings first**: every recording newer than `plaud_live` (the
   last 3 days if there is none yet), stored as above without
   `--cursor-key`.
2. **Then up to 10 older ones**, unless `plaud_window` is `done`, stored
   with `--cursor-key plaud_window --cursor-value <the oldest recording's date>`,
   or `done` when nothing older is left.

## If no Plaud tool is available

Tell the person Plaud needs a manual export: they open the Plaud app on
their phone or its web app, export their recordings (Plaud supports a bulk
export), and drop the export into `.confidant/exports/plaud/` inside their
vault. Say plainly that this step is on them; Confidant cannot reach Plaud
on its own. Confirm the folder exists so the export has somewhere to land,
then move on; picking up files placed there is not part of this recipe.
Record Plaud as `partial` with a note saying so, never `connected`.

Read-only, always: only read and export. Never delete a recording.
