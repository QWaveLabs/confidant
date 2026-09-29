# Plaud

Plaud has no public API. Check first whether the person has a Plaud MCP
server or CLI installed; ask them, or look for one among Codex's connected
apps.

If a Plaud tool is available:

1. List recordings, newest first.
2. Write each recording's metadata and transcript to a JSONL file under
   `.confidant/tmp/`, one recording per line:
   `{id, title, created_at, duration, transcript, summary, participants}`.
3. Store them:
   `confidant ingest --source plaud --file <path> --cursor-key plaud --cursor-value <the newest recording's date>`
4. Cap how many recordings you do in one run; the scheduled Brain Update
   continues the rest every 3 hours.

If no Plaud tool is available, tell the person Plaud needs a manual export:
they open the Plaud app on their phone or its web app, export their
recordings (Plaud supports a bulk export), and drop the export into
`.confidant/exports/plaud/` inside their vault. Say plainly that this step
is on them; Confidant cannot reach Plaud on its own. Confirm the folder
exists so the export has somewhere to land, then move on; picking up files
placed there is not part of this recipe.

Read-only, always: only read and export. Never delete a recording.
