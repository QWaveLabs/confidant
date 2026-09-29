---
name: confidant-install
description: Install runbook for setting up a person's Confidant second brain. Follow this when a person arrives through CUSTOMER_PROMPT.md, or says anything like "set up my second brain" or "continue setting up my second brain".
---

# Installing Confidant

This is the whole install, in the order to run it. Do the technical work
yourself. Ask only one question at a time, and only for a choice, a
sign-in, or a permission. Keep every source read-only until it's connected.
Never call something connected, imported, or scheduled that isn't. If a
step fails, retry it a couple of times, then explain plainly what happened
and what the person can do, and keep going with the rest of the install.

Every command below is `bin/confidant <command>`, run from the repo root
(or, once the vault exists, from inside it). `--help` only lists every
command, not a command's own flags; for a flag not shown literally here,
read that command's own file under `engine/` or its section in
`CONTRACTS.md`.

## Before you start

Run `bin/confidant doctor --json`. It tells you:

- whether this Mac is ready (Node, disk space, Full Disk Access, Obsidian,
  the ChatGPT app, WhatsApp);
- any Confidant vault that can be resumed (`vaults.confidant`), and its
  `.confidant/state.json` phase; and
- the path a brand new vault would get (`planNewVaultPath`).

**If a resumable vault exists**, open its `.confidant/state.json` and pick
up at `phase`, using the section below with that name. Don't repeat
finished phases.

**If the person already has a second brain or any existing Obsidian
vault** at the default path, say so in one line and create a new vault
next to it (`doctor`'s `planNewVaultPath` already accounts for this).
Never open, edit, or write into a vault this install didn't create.

**If this is a fresh start**, tell the person, briefly, before asking
anything: it usually takes 15 to 30 minutes of their attention (some of it
runs in the background afterward), and they'll see something like 10
approval prompts along the way (cloning this repo, trusting it so
`bin/confidant` can run without asking every time, one prompt per
scheduled agent you create, and one for the wake schedule if they want
it). Then move to **Setup**.

## Setup (state: `start` → `setup`)

Ask **one** message that gathers all of this together:

- their role: founder, agency, consultant, investor, sales, executive, or
  recruiter;
- what time they want their morning brief (default 06:45);
- their language, en or es; and
- what it should never see: default to banking, health, and passwords, and
  ask them to name any family chats or specific people or clients (for
  example someone under an NDA) to leave out completely.

If the prompt they pasted included a "My blueprint:" line, prefill your
question with those values so they're just confirming or adjusting, not
starting from a blank page.

Turn their free-text answer into a real config: categories they mention
(banking, health, family, personal email, passwords) go in
`exclusions.categories`; specific names, chats, domains, or accounts they
name go in `exclusions.people`, `.chats`, `.domains`, or `.emailAccounts`.
Then run `bin/confidant init --role <role> --brief-time <HH:MM> --language en|es`,
repeating `--exclude-category <name>` and `--exclude-person <name>` once per
item for any categories or people they named. `init` does not yet take a
chat, domain, or email-account exclusion directly; note those down and add
them once the vault exists (see `.confidant/config.json`'s `exclusions`
shape in CONTRACTS.md). Save the "blueprint" line's values for later, since
they also shape the scheduled tasks.

## Connect (state: `setup` → `connect`)

Show **one** connect list, in this order, and only for sources the person
actually says they want:

1. **Full Disk Access for ChatGPT.** Tell them to open System Settings,
   then Privacy & Security, then Full Disk Access, and turn ChatGPT on.
   This requires relaunching ChatGPT, which ends this conversation. Tell
   them exactly that, and that they should come back afterward and say
   "continue setting up my second brain."
2. **Mail accounts.** If their email is already added to the Mac's Mail
   app, that's the fastest path: their whole history is already local.
   Otherwise ask if they'd like to add an account to Mail.
3. **Codex apps**, for whichever of these they use and Mail doesn't
   already cover: Gmail, Google Calendar, Google Drive, Slack.
4. **WhatsApp.** Ask if they use WhatsApp for Mac (make sure it's signed
   in), and whether they have older chats worth exporting; if so, tell
   them to export each one and drop the file into
   `.confidant/exports/whatsapp/` in the vault.
5. **API keys**, only for the notetakers they actually use: Deepgram (for
   transcribing phone call recordings and voice memos), Fathom, Fireflies,
   Granola, Read.ai, Grain, tl;dv. For each, run
   `bin/confidant keys set <name>`, which prompts for the key through a
   hidden macOS dialog and never shows it in chat. Skip anything they
   don't use. If they have a Plaud device, connect its Codex app instead.

For every source, after you know its real status, record it:
`bin/confidant config source --id <source> --status connected|partial|skipped|blocked|unused [--note "..."]`.
Use `partial` when something connects but not fully (for example, Full
Disk Access is still pending). Use `blocked` when the person needs to do
something else first. Never mark a source `connected` before it actually
is.

## Extract (state: `connect` → `extract`)

Run `bin/confidant extract` for the deterministic local and API sources
(iMessage, WhatsApp, Mail, Calendar, Contacts, calls, call recordings,
voice memos, notetaker APIs). It's incremental and safe to re-run.

Then, for each connected Codex app (Gmail, Google Calendar, Google Drive,
Slack, Plaud), follow the matching recipe file in `recipes/` next to this
one. Each recipe tells you what to read through that app and how to hand
the records to `bin/confidant ingest`.

## Sort (state: `extract` → `sort`)

Follow `.agents/skills/confidant-sort/SKILL.md` with `scope: install`. It
sorts the most recent 60 days: identity, then dossiers, then batches that
you or a subagent write contributions for, then merge, then mocs.

Tell the person the rest of their history keeps filling in automatically,
oldest first, roughly every 3 hours, once the scheduled tasks below are
running.

If you hit a usage or rate limit partway through sorting, stop cleanly,
note where you left off, and plan to create the temporary `finish_sorting`
task below (`tasks spec --include-finish`) so it picks up the rest later.

## Tasks (state: `sort` → `tasks`)

Run `bin/confidant tasks spec --json`. It returns one entry per scheduled
agent (`key`, `name`, `rrule`, `prompt`, `notify`, `cwd`, and sometimes
`fallbackRrules`), already scaled to the brief time and role you set up.
For each entry:

1. Create it with the `automation_update` tool: mode `create`, status
   `ACTIVE`, execution environment `local`, `cwd` set to the vault, no
   model pinned, and the entry's `prompt`.
2. If the rule is rejected, retry using `fallbackRrules` one at a time
   (this may mean creating more than one task for that key).
3. Record every automation you created:
   `bin/confidant tasks record --key <key> --id <automation id>`.

If sorting hit a usage limit above, also create `finish_sorting` (get its
spec with `bin/confidant tasks spec --include-finish --json`) the same
way.

## Config (state: `tasks` → `finish`)

1. `bin/confidant config sandbox` writes the vault's own sandbox rules
   (workspace-write, no browsing, no destructive app tools). Review what
   it printed.
2. `bin/confidant config trust` (no `--yes`) shows what it would add to
   your `~/.codex/config.toml`. Then run it again with `--yes` to apply.
   This is what lets `bin/confidant` and the scheduled tasks run without
   asking for approval on every routine step.
3. Ask, in one short message, whether they'd like two optional extras,
   since both ask for a permission: **wake the Mac automatically** 15
   minutes before their brief (`bin/confidant config wake --time HH:MM
   --yes`, which will prompt for their Mac password), and **open ChatGPT
   automatically at login** (`bin/confidant config login-item --yes`).
   Skip whichever they decline.

## Finish (state: `finish` → `done`)

1. Run `bin/confidant welcome --open`. It writes `Confidant Guide.html`
   (or `Guía de Confidant.html` in Spanish) inside the vault and opens it.
   Without `--open` it only writes the file.
2. Open the vault in Obsidian:
   `obsidian://open?path=<url-encoded vault path>`.
3. Send one final chat message covering, plainly:
   - what's connected, with real counts, and what's still backfilling;
   - the six scheduled agents and when they run;
   - anything skipped or blocked, and why;
   - next steps: open Obsidian, check the Scheduled view in the ChatGPT
     app tomorrow morning, and keep the Mac on and ChatGPT open so the
     agents can run; and
   - "Questions? Email support@meetconfidant.com."

Only ever report real, verified status. `bin/confidant status --json`
gives you the same numbers the guide shows, if you want to double check
before sending that message.

## Resuming

If the person says anything like "continue setting up my second brain,"
re-read `.confidant/state.json` in the vault (or run `bin/confidant doctor
--json` to find it) and pick up at its `phase`, using the matching section
above. Don't redo a finished phase, and don't recreate a vault that
already exists.
