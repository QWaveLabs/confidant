# Confidant

Confidant installs a private second brain, built from a person's own working
history, on their own Mac. They paste one message (`CUSTOMER_PROMPT.md`) into
Codex, inside the ChatGPT desktop app. Codex clones this repo at a pinned tag
and commit, reads `AGENTS.md`, and follows
`.agents/skills/confidant-install/SKILL.md` end to end: it asks a short setup
question, connects the sources the person wants, extracts and sorts their
history into an Obsidian vault, creates nine scheduled tasks (the six agents plus health, cleanup and check-in), locks down the
sandbox, and hands back a plain-English "Confidant Guide.html".

This repository is the installer: engine code, prompts, schemas and the
install skill. It never contains a customer's vault, notes, exports,
credentials, or state. All of that stays on the person's own Mac, under
`<vault>/.confidant/`.

For the full design (vault layout, the record and state shapes, every
command, and who owns what), see [CONTRACTS.md](CONTRACTS.md).

## For operators

Send the customer the message in [CUSTOMER_PROMPT.md](CUSTOMER_PROMPT.md).
`scripts/release.mjs` fills in its `{REPO_URL}`, `{TAG}` and `{SHA}`
placeholders for the current release; see **Cutting a release** below. Codex
does the rest, pausing only for a sign-in, a permission, or a choice about how
the person works. If they need to step away mid-install (most often to grant
Full Disk Access, which requires relaunching ChatGPT), they come back and say
"continue setting up my second brain," and Codex resumes exactly where it
left off, from `.confidant/state.json` in their vault.

## How the install works

1. **Setup.** One message: role, brief time, language, what to never touch.
2. **Connect.** `bin/confidant extract --probe` finds every source already
   on the Mac and connects it. Then one list covers Full Disk Access and the
   plugins for Gmail, Google Calendar, Google Drive, Slack and Plaud, done
   before a single ChatGPT restart, then API keys for whichever notetakers
   the person uses. Nothing is recorded as connected until it actually
   reads.
3. **Extract.** Local and API sources go through deterministic code
   (`bin/confidant extract`); connected Codex apps go through
   `bin/confidant ingest`, guided by the recipes in
   `.agents/skills/confidant-install/recipes/`. The 3-hour Brain Update
   refreshes those apps too (`bin/confidant apps` lists them with their
   saved cursors), so they never go stale after the install.
4. **Sort.** `.agents/skills/confidant-sort/SKILL.md` builds identity,
   dossiers, and notes for the most recent 60 days. The rest of the person's
   history keeps filling in afterward, newest first and all the way back, roughly every 3 hours.
5. **Tasks.** Nine standalone scheduled tasks are created with the ChatGPT
   app's own `automation_update` tool on the vault's own project, then
   checked with `bin/confidant tasks verify`. Every run is its own chat in
   Scheduled, and that chat shows the full brief, not just a note that it
   was saved to Obsidian.
6. **Config.** The vault gets its own sandboxed `.codex/config.toml`
   (workspace-write, no browsing, no destructive app tools), the project is
   marked trusted, and an optional wake schedule and login item are set up.
7. **Finish.** `bin/confidant welcome` writes `Confidant Guide.html`
   (`Guía de Confidant.html` in Spanish) into the vault, and Codex reports
   plainly what's connected, what's still backfilling, and what's skipped or
   blocked.

## Repository layout

```
bin/                launchers: bin/node finds a usable Node, bin/confidant runs the CLI
engine/cli.mjs       command table
engine/lib/*.mjs     shared helpers (paths, store, i18n, schema validation, ...)
engine/extract/      one file per source that reads local data or an API
schemas/*.schema.json contracts for records, config, state, tasks, batches, personas
personas/*.json      per-role subfolders, vocabulary and agent emphasis
prompts/             sorting and scheduled-task prompts
i18n/<ns>.<lang>.json per-namespace strings, English and Spanish
templates/vault/     files copied into a new vault
templates/welcome/   the welcome guide's HTML shell
.agents/skills/      confidant-install, confidant-sort, confidant-agents
```

See `CONTRACTS.md` for the full vault layout that `confidant init` creates on
the person's Mac, and the "Units and ownership" table for which files belong
to which part of the build.

## Testing

Zero npm dependencies; everything runs on the Node that ships inside the
ChatGPT app (or any Node 22.13+ / 23.4+ on your own machine).

```
npm test
```

runs every `test/**/*.test.mjs` file with Node's built-in test runner. Tests
build their own fixtures in temporary directories; they never read a real
person's `~/Library` data, and nothing in the suite calls `pmset`,
`osascript`, or writes to a real `~/.codex/config.toml`. System-level effects
(disk checks, the wake schedule, the login item, opening a browser) are all
behind an injectable function so tests can fake them.

```
sh bin/confidant doctor --json
```

is the fastest way to sanity-check a real Mac by hand: Node, disk space, Full
Disk Access, the apps Confidant depends on, and any vault it could resume.

## Cutting a release

```
sh bin/node scripts/release.mjs
```

reads the current git tag, commit, and remote (or takes `--repo`, `--tag` and
`--sha` to override), fills `CUSTOMER_PROMPT.md`, prints the result, and
writes it to `dist/customer-prompt.txt`. Tag a commit before running it so
Codex clones something pinned rather than a moving branch:

```
git tag v2.x.x
git push origin v2.x.x
sh bin/node scripts/release.mjs
```

## License

[MIT licensed](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for attribution. A customer's own vault and generated notes are theirs; this
license covers the installer code, not what it builds for them.
