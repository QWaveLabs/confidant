# Confidant engine contracts

This is the build contract for Confidant v2. Five units build in parallel
against it. If you need something here to change, don't edit a file you
don't own: say so in your final report. Rob's product rules come first.

## What we are building

A person pastes one prompt into Codex (inside the ChatGPT desktop app on a Mac).
Codex clones this repo (pinned tag + SHA) and follows `AGENTS.md` and
`.agents/skills/confidant-install/SKILL.md`:

1. It asks one setup message: role, brief time, exclusions and language.
   A pasted "My blueprint:" line fills these in.
2. It shows one connect list: Full Disk Access, Mail accounts, Codex apps,
   and API keys.
3. It extracts everything: local and API sources go through deterministic
   code, and the Codex apps go through `confidant ingest`.
4. It sorts: `identity`, then `dossiers`, then `batch next`. Codex subagents
   write contributions, then `merge`, then `mocs`. The install sorts the most
   recent 60 days. The 3-hour Brain Update drains the rest of the history,
   newest first.
5. It creates the scheduled tasks (ACTIVE) and sets up the sandbox, trust,
   wake schedule and login item. It writes `Confidant Guide.html`, then
   summarizes in chat with next steps and support@meetconfidant.com.

**An install never writes into a second brain it did not create.** If the
default folder exists, `planNewVaultPath()` picks "Second Brain 2", "3", and
so on. An existing Confidant vault (with `.confidant/config.json`) is
resumed, never overwritten.

## Rules for every unit

- Zero npm dependencies. ESM `.mjs` only. Use Node 22.13+ built-ins
  (`node:sqlite`, `fetch`, `node:test`). Run everything through `sh bin/node`.
- Tests are `test/<unit>-*.test.mjs` using `node:test` and
  `node:assert/strict`. Build fixtures in code (for example, create SQLite
  fixtures with node:sqlite in a temp dir). **Never read Rob's real
  ~/Library data in tests. Never print real message content anywhere.**
- All user-facing text is EN and ES. Put your strings in
  `i18n/<your-namespace>.<lang>.json` and load them with
  `t(ns, lang)` from `engine/lib/i18n.mjs`. Spanish is neutral LatAm with "tú".
- **No em dashes and no double hyphens in any user-facing text**: notes,
  prompts, skills, HTML, i18n. Use commas, periods or restructure the
  sentence. Keep copy plain and calm, like a private banker's letter.
- The installed UI is called "Second Brain" ("Segundo cerebro"). The
  welcome guide is the only place the Confidant name and mark appear.
  OpenAI names appear in text only, never as a logo, and never imply
  partnership.
- Commands export `run(args, ctx)` and return an exit code. They print
  their result with `ctx.log.out(value, humanText)` (JSON when `--json`)
  and respect `ctx.dryRun`.
- Put new shared helpers in `engine/lib/<unit>-*.mjs`, where `<unit>` is
  your unit letter. Don't edit other units' files.

## Layout

```
bin/node, bin/confidant          launchers (find ChatGPT's bundled Node 24)
engine/cli.mjs                   command table (U0)
engine/lib/*.mjs                 shared helpers (U0), see below
engine/extract/index.mjs         extract runner (U0)
engine/extract/<source>.mjs      extractors (A local, C api)
schemas/*.schema.json            contracts (U0)
personas/<role>.json             (D)
prompts/                         sort prompts (B), task prompts prompts/tasks/ (D)
i18n/<ns>.<lang>.json            per unit
templates/vault/                 files copied into a new vault (D)
templates/welcome/               welcome guide template (E)
.agents/skills/confidant-install/  install skill + recipes/ (E; recipes by C)
.agents/skills/confidant-sort/     sorting skill (B)
.agents/skills/confidant-agents/   scheduled task skill (D)
AGENTS.md, CUSTOMER_PROMPT.md, README.md, scripts/release.mjs   (E)
```

## Vault layout (created by `init`, D)

```
~/Second Brain/
  AGENTS.md                      vault contract for Codex (D)
  Home.md                        generated (B mocs)
  People/ Companies/ Projects/ Decisions/ Commitments/ Ideas/ Meetings/ Opportunities/ Knowledge/
  Briefs/                        daily brief, radar, weekly review (D agents)
  Confidant Guide.html           (E)
  *.base                         Obsidian Bases views (B mocs, from persona.bases)
  .obsidian/app.json             (D)
  .codex/config.toml             sandbox + app tool limits (E config)
  .agents/skills/confidant-agents, confidant-sort   copied from repo (D init)
  .confidant/
    config.json state.json brain.db identity.json
    engine/                      copy of bin/ engine/ schemas/ prompts/ personas/ i18n/ templates/ .agents/ (D init)
    exports/<source>/            where the person drops exports (WhatsApp .zip etc.)
    dossiers/ batches/ contrib/ backups/ digests/ logs/ locks/ tmp/
```

Folder names come from `engine/lib/folders.mjs` in the vault's language
(for example, ES uses Personas, Empresas, Compromisos, Resúmenes). Scheduled
tasks call `.confidant/engine/bin/confidant ...` with cwd = the vault.

## Shared helpers (U0, engine/lib)

- `paths.mjs`
  - `statePaths(vault)`
  - `planNewVaultPath({language, home})`
  - `resolveVault()`
  - `isConfidantVault()`
  - `obsidianVaults()`
  - `findConfidantVaults()`
  - `REPO_ROOT`
- `context.mjs`: builds `ctx = { vault, paths, config, state, store (lazy), log, lang, tz, now, dryRun, json, saveConfig(), saveState(), tmpDir(), close() }`.
- `store.mjs`: SQLite at `.confidant/brain.db`.
  - `upsertRecords(records)` returns `{inserted, updated, unchanged}`
  - `records({source, sources, kind, thread, since, until, changedSince, fromHandle, limit, order})`
  - `record(id)`
  - `counts()`
  - `getCursor` / `setCursor`
  - `getMeta` / `setMeta`
  - `ensureTable(sql)` for your own tables
  - `openMemoryStore()` for tests
- `sqlite.mjs`
  - `canRead(path)` returns `{ok, code, needsFullDiskAccess}`
  - `openSourceCopy(src, tmpRoot)` returns `{db, close}` (copies db plus -wal and -shm)
  - `withSourceCopy(src, tmp, fn)`
  - `toBuffer(blob)`
- `handles.mjs`
  - `normalizePhone`, `normalizeEmail`
  - `phoneHandle`, `emailHandle`, `slackHandle`, `groupHandle`, `nameHandle`, `toHandle`
  - `parseHandle`, `last10`
  - `isShortCode`, `isAutomatedEmail`
- `time.mjs`
  - `fromAppleTime` (seconds, ms or ns since 2001)
  - `fromUnix`, `toIso`, `toMs`
  - `localDate(iso, tz)`, `systemTimeZone()`, `daysAgo()`
- `hash.mjs`: `sha1`, `shortHash`, `fingerprint(...parts)`
- `lock.mjs`: `acquireLock(paths, name)` returns `{release}` or `{held, holder}`
- `schema.mjs`: `check(name, value)` returns errors, and `assertValid(name, value)`
- `frontmatter.mjs`: `parseNote(text)` returns `{data, body}`, plus `stringifyFrontmatter(data)` and `composeNote(data, body)`
- `folders.mjs`: `FOLDERS`, `BRIEFS`, `FOLDER_KEYS`, `folderName(key, lang)`, `folderPath(key, lang, sub)`
- `sources.mjs`: `SOURCES` registry (id, method, module, needs, label), `getSource`, `enabledSources(config)`
- `i18n.mjs`: `t(ns, lang)(key, vars)`, `fill()`
- `files.mjs`: `ensureDir`, `readJson`, `writeJson` (atomic), `writeFileAtomic`, `readJsonl`, `appendJsonl`

## Record (schemas/record.schema.json)

```
{ id: "<source>:<stable id>", source, kind: message|email|event|meeting|call|recording|note|dictation|doc|contact,
  thread, ts (ISO UTC), from: {handle, name}|null, to: [{handle, name}], is_from_me, title, text, url, meta }
```

- **Handles**
  - `tel:+E164`
  - `mailto:lower`
  - `slack:T/U`
  - `group:<source>:<id>`
  - `name:<lower name>`, for speakers with no address
- **Threads**
  - `imessage:<chat guid>`
  - `whatsapp:<jid>`
  - `email:<thread id or normalized subject+participants>`
  - `meeting:<source>:<id>`
  - `calendar:<event id>`
  - `slack:<channel>`
- **Meeting transcripts.** Use one record per meeting (`kind: meeting`) with
  the full transcript in `text` as `Speaker: line` rows. Put attendees in
  `to`, and `meta.summary`, `meta.action_items`, `meta.duration_s` when the
  source has them.
- **Contacts.** `kind: contact`, `text: ''`, and
  `meta: {names[], phones[], emails[], company, title}`.

## Extractor interface (A and C)

```js
export const id = 'imessage';
export async function probe(ctx) { return { ok, reason?, count?, needsFullDiskAccess?, needsKey? } }
export async function extract(ctx, { cursor, limit }) { return { records, cursor, done } }
```

- The runner (`engine/extract/index.mjs`) calls `extract` page by page. It
  validates every record, applies `privacy.filterRecord`, upserts, and saves
  the cursor.
- The cursor is an opaque string you define (a ROWID, an ISO date, a page
  token).
- `cursor: null` means "from the beginning" (full history). Newest-first or
  oldest-first is your choice, but you must be resumable.
- Read Apple databases only through `openSourceCopy`.
- Throw errors with `err.needsFullDiskAccess = true` when access is the
  problem.

## Privacy (A owns engine/privacy.mjs)

```js
export function filterRecord(record, config) { return { keep: boolean, reason?: string } }
export function scrubText(text) { return { text, redactions } }  // cards (Luhn), IBAN, SSN, one-time codes, "password: x"
export function emailQuery(config) { return string }               // Gmail search suffix for the gmail app recipe (C uses it)
```

- `filterRecord` applies `config.exclusions`:
  - **categories**: banking, health, family, personal-email and passwords,
    matched by known domains, senders and keywords
  - **people, handles, domains, chats, keywords**
  - **emailAccounts**
- B calls `scrubText` on every string it writes into a note.

## Transcription (C owns engine/lib/c-transcribe.mjs)

```js
export async function transcribe(ctx, filePath, { mimetype }) { return { text, utterances: [{speaker, start, end, text}], provider } | null }
```

- It returns null when there is no Deepgram key. The caller then keeps the
  record with `meta.needs_transcript = true` and retries on a later run.
- Model: nova-3, with `diarize`, `smart_format`, `utterances` and `punctuate`.
- A's call-recordings, voice-memos and zoom-local extractors import it
  dynamically. If it's missing, they skip transcription.

## Keys (C owns engine/lib/c-keys.mjs and engine/keys.mjs)

```js
export function getKey(name) { return string | null }  // Keychain service "confidant-<name>"
export async function promptForKey(name, label) { return boolean }  // hidden macOS dialog -> Keychain; never prints the key
```

- Key names: `deepgram`, `fathom`, `fireflies`, `granola`, `readai`, `grain`, `tldv`.

## Identity (B), `.confidant/identity.json`

```
{ owner: { person_id, name, handles[] },
  people: [{ id, name, kind, company, handles[], sources[], first_seen, last_seen, messages, two_way, strength, tier, note_path? }],
  groups: [{ id, name, handles[], source }],
  generated_at }
```

- Exported functions: `buildIdentity(ctx)` and `loadIdentity(ctx)`, which
  returns the object plus `byHandle(h)`.
- Tiers are `inner`, `active`, `network` and `cold`, based on strength.

## Dossiers, batches, contributions (B)

- `buildDossiers(ctx, { since, changedSince })` writes `.confidant/dossiers/{people,threads,meetings}/<id>.json`.
- `planBatches(ctx, { scope: install|update|backlog, maxTokens = 40000, count })` returns `[{ id, path, kind, est_tokens }]`.
  - It writes `.confidant/batches/<id>.json` (schemas/batch.schema.json).
- **Codex's job.** Codex (or a subagent) reads a batch file, follows
  `prompts/sort.md` (named in `batch.instructions`), and writes
  `.confidant/contrib/<id>.json` (schemas/contribution.schema.json).
- `mergeBatch(ctx, batchId)` handles the rest:
  - validates the contribution and scrubs it
  - fingerprints items, then creates or updates notes
  - keeps a pre-image backup in `.confidant/backups/<run>/`
  - records the merge in the ledger
  - is idempotent: merging twice changes nothing
- `buildMocs(ctx)` writes Home.md, one index per folder and the `.base` files.
- CLI:
  - `confidant batch next [--scope] [--count] [--max-tokens]`
  - `confidant batch status`
  - `confidant merge --batch <id>`
  - `confidant mocs`
  - `confidant undo --run <id>`

## Note frontmatter (B writes, D and E read)

- **Every note** has:
  - `type`
  - `confidant_id`
  - `updated: YYYY-MM-DD`
  - `tags`
  - `sources`: a count, plus the latest source label
- **By type:**
  - person: `name, kind, company, relationship, tier, last_contact, phones[], emails[]`
  - company: `kind`
  - project: `status (active|waiting|stalled|done|idea), company, people[]`
  - meeting: `date, people[] (wikilinks), company, project, source`
  - decision: `date, project, company, decided_by[]`
  - commitment: `direction (i_owe|owed_to_me|delegated), counterpart ("[[Name]]"), company, project, due, status (open|done|dropped), date, fingerprint`
  - idea: `date, status`
  - opportunity: `opportunity_type, status (open|won|lost|stale), counterpart, company, value, date, next_step` (`type` is always the note kind, so the category is `opportunity_type`)
  - knowledge: `date`
- Dated bullets in bodies look like `- 2026-09-01, text. _(iMessage)_`. Newest
  bullets go first, under `## Timeline`.
- **Never touch the person's own prose.** Generated sections live between
  `<!-- confidant:start <section> -->` and `<!-- confidant:end <section> -->`.
  Everything outside those markers is theirs.

## Scheduled tasks (D)

- `confidant tasks spec --json` returns `schemas/task.schema.json` entries.
  The install skill creates each one with `automation_update`:
  - mode create
  - status ACTIVE
  - execution environment local
  - cwd = vault
  - no model pinned
- After each create it runs `confidant tasks record --key <k> --id <automation id>`.
- Task keys:
  - `brain_update`: "Commitment Tracker + Brain Update", every 3 hours at :10 (00:10, 03:10, 06:10 ... so it never collides with tasks on the hour)
  - `opportunity_scanner`: weekdays, brief time minus 15 minutes
  - `morning_brief`: "Morning Chief of Staff", weekdays at brief time
  - `meeting_prep`: weekdays at :30, scaled by meetingsPerWeek
  - `follow_up_radar`: weekdays at 16:00
  - `weekly_review`: "Weekly CEO Review", Fridays at 15:00
  - `finish_sorting`: temporary, only if the install hit usage limits
- Every task prompt ends with the heartbeat block:
  `<heartbeat><decision>NOTIFY|DONT_NOTIFY</decision><message>one line</message></heartbeat>`.
- `confidant digest <key>` prints the run's context in markdown, 5 to 10K tokens.
- `confidant update` is the brain update:
  1. lock
  2. extract every enabled local/api/derived source incrementally
  3. identity, then dossiers with changedSince, then batch next (scope update, plus one backlog batch)
  4. print the batches for Codex
- `confidant update --finish` then runs `mocs` and writes `state.lastUpdate`.

## State (.confidant/state.json)

```
{ phase: start|setup|connect|extract|sort|tasks|finish|done, history: [{phase, at}],
  tasks: [{ key, name, rrule, automation_id, created_at }],
  backlog: { remaining_batches, oldest_sorted, done },
  lastUpdate: { at, inserted, merged }, welcome: { path, at }, install: { started_at, finished_at } }
```

## Units and ownership

| Unit | Model | Owns |
|---|---|---|
| A | Opus | `engine/extract/{imessage,whatsapp,whatsapp-export,mail,calendar,contacts,calls,call-recordings,voice-memos,wispr,zoom-local}.mjs`, `engine/privacy.mjs`, `engine/lib/a-*.mjs` (MIME, protobuf, MP4 atoms), `test/a-*.test.mjs` |
| B | Opus | `engine/{identity,dossiers,batch,merge,notes,mocs,undo}.mjs`, `engine/lib/b-*.mjs`, `prompts/sort*.md`, `.agents/skills/confidant-sort/`, `i18n/notes.*.json`, `test/b-*.test.mjs` |
| C | Sonnet | `engine/extract/{fathom,fireflies,granola,readai,grain,tldv,recaps}.mjs`, `engine/ingest.mjs`, `engine/keys.mjs`, `engine/lib/c-*.mjs` (http, keys, transcribe), `.agents/skills/confidant-install/recipes/`, `test/c-*.test.mjs` |
| D | Sonnet | `personas/*.json`, `engine/{init,tasks,digest,update}.mjs`, `engine/lib/d-*.mjs`, `prompts/tasks/`, `templates/vault/`, `.agents/skills/confidant-agents/`, `i18n/{vault,agents}.*.json`, `test/d-*.test.mjs` |
| E | Sonnet | `AGENTS.md`, `CUSTOMER_PROMPT.md`, `README.md`, `scripts/release.mjs`, `.agents/skills/confidant-install/SKILL.md`, `engine/{doctor,config,status,welcome}.mjs`, `engine/lib/e-*.mjs`, `templates/welcome/`, `i18n/{welcome,install}.*.json`, `test/e-*.test.mjs` |

U0 (the orchestrator) owns `engine/cli.mjs`, `engine/lib/{paths,files,handles,time,hash,lock,store,sqlite,schema,frontmatter,folders,sources,i18n,context}.mjs`, `engine/extract/index.mjs`, `schemas/`, `bin/`, `package.json`, `CONTRACTS.md` and `test/lib.test.mjs`.
