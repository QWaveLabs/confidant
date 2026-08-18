# QWA-146 — approved-record canonical compilation proof

## Verified scope

This proof covers a local, simulated contract only. No Gmail, Calendar, Drive,
iMessage, WhatsApp, customer vault, source account, source body, credential, or
generated customer vault was accessed or modified.

The customer can ask in ordinary English or Spanish to compile approved notes;
slash commands are rejected. The compiler accepts only short, normalized,
`untrusted-inert-reference` records that still match an active QWA-139 metadata
review and granular grant. It never invokes a source connector or upgrades a
source to live status.

## Customer-visible result

For a non-sensitive fixture batch, the simulated result produces sourced
canonical subject-note projections for People, Organizations, Projects,
Decisions, Priorities, Areas, Meetings, and Knowledge.

Every generated claim has a stable claim ID, confidence, opaque source
reference, source timestamp, approved opaque participant references, a safe
reviewed source label (or a neutral label), an approved stable link when one
exists, processing timestamp, observed date, verified date (or explicitly
unverified state), and privacy restrictions. Missing evidence is displayed as
**Unknown** or **Desconocido**; it is never invented.

Canonical notes separate the generated evidence block from a distinct
user-owned notes block. Source indexes contain only opaque source references,
claim IDs, and links to canonical notes; they do not repeat claim text or
become a competing authority.

## Permission and privacy evidence

- Every participant on a record must be in the customer's selected Allowed
  list. A selected Allowed person cannot carry an omitted, Restricted, or
  unknown participant into compilation. A separately approved blocked-group
  exception remains limited to selected Allowed people plus the known Blocked
  people that justified that exception.
- Missing or malformed person access metadata defaults to Restricted during a
  fresh QWA-139 review. Unknown sensitivity labels and malformed uncertainty
  markers become `uncertain-sensitivity`, which remains excluded by default.
  The complete normalized metadata snapshot (including its derived unknown
  participants, blocked groups, sensitive groups, and item count) has a durable
  SHA-256 digest stored on both review and grant. Grant activation, bounded
  fetch, first compilation, and resume revalidate that digest and all derived
  structures. Missing/unknown access, sensitivity, or participant metadata and
  persisted Restricted-to-Allowed or Blocked-to-Allowed promotion attempts all
  fail closed before staging or resumed processing.
- Every effective recognized sensitive category must be explicitly present in
  the grant's included list and absent from its excluded list. A separately
  reviewed and explicitly included fixture category compiles; adding that same
  category to persisted metadata after staging invalidates resume.
- Source timestamp, participant references, label, stable link, reviewed scope,
  grant identity, and acknowledgement mismatches are rejected before staging
  or compilation.
- Public results never expose a staging path or staged record contents.

## Temporary staging and retention evidence

- Staging is restricted to an absolute, dedicated
  `.qwave-second-brain-staging` directory outside every Git repository. Broad
  roots, repository paths, symbolic links, oversized batches, raw-shaped
  fields, arbitrary paths, and incomplete direct-staging schemas are rejected.
- The staging directory is owner-only and each batch file is created
  owner-readable/writeable only.
- Before any staged record file can exist, the adapter durably creates and
  fsyncs a content-free generation marker and its parent directory, then arms a
  detached local cleanup worker and waits for its acknowledgement. Only after
  that coverage exists does it create, write, fsync, close, and parent-fsync the
  stage. Post-open write, fsync, and close failures unwind safely without an
  untracked record file.
- The worker receives only the private staging root, opaque batch ID, fixed
  expiry, opaque lease ID, worker ID, and one-time claim nonce; it never reads
  or logs staged records and does not inherit caller secrets or a caller
  sentinel. A process-level test proves it deletes the batch after the creator
  process exits.
- Record, marker, owner, tombstone, and receipt names are bound to a hash of the
  opaque lease. A worker for an older generation therefore cannot unlink a
  later stage that reuses the same batch ID. A claimed worker must durably bind
  its exact PID, process-start timestamp, random process nonce, claim nonce, and
  generation identity, acknowledge that protocol over IPC, and continue moving
  the owner-file heartbeat. A restarted adapter adopts coverage only after
  observing that exact identity advance; an unrelated live PID in a static
  owner is replaced. Early deletion removes ownership and all workers exit.
- A fresh adapter rechecks every durable expiry and re-arms independent cleanup
  for an unexpired batch. If it cannot restore retention coverage, it deletes
  the batch early and marks the lifecycle discarded rather than retaining it
  without the promised cleanup.
- Restart and detached-worker recovery never treat a pre-existing missing data
  path as proof that this generation unlinked it. An expired prepared marker
  whose data path is newly absent, and a generation whose data has another
  hard link, retain their exact lease and retry coverage with an unverified
  tombstone and no completion receipt. A stale worker that finds both old
  generation paths already absent exits ownership without fabricating evidence
  and cannot affect a later same-ID generation.
- Startup orphan and malformed-generation cleanup uses the same link-aware
  `lstat`/no-follow `open`/`fstat` identity checks and requires both verified
  zero-link data and path absence before reporting a removal. A hardlinked
  orphan or malformed generation remains in place, is returned as
  needs-attention, and cannot create recovered expired lifecycle truth; safe
  single-link artifacts are removed only after their absence is verified.
- Successful compilation deletes the protected batch. Deletion first persists
  a content-free generation-bound tombstone. The record path is checked with
  `lstat`, then opened without following links and checked with `fstat`; exact
  device/inode identity and `nlink === 1` are required before processing and
  again immediately before deletion. The still-open file is checked after
  unlink, and only a durable tombstone update recording `nlink === 0` allows
  marker deletion or a generation-bound receipt. A pre-existing hard link and
  a hard link introduced after open both retain coverage and produce no false
  receipt; an unverified post-unlink crash window stays needs-attention. File
  and parent-directory durability is requested for each mutation where the host
  supports it. Receipt rename/write or parent-fsync interruption remains
  cleanup-pending and resumes from the verified tombstone without losing a
  durable compiled result.
- Cleanup acknowledgement is an internal lifecycle capability. It rejects a
  public or premature call, and it disarms coverage only after an exact-version,
  exact-lease, canonical non-future receipt or verified tombstone is present and
  both the data and lease paths are confirmed absent.
- On a running host, interrupted staging has an independently scheduled fixed
  24-hour deletion attempt. Transient unlink failures are retried until absence
  is verified, and later lifecycle resume fails closed after deletion. Expiry
  leaves only content-free generation-bound cleanup evidence until its matching
  lifecycle update is durably saved.

## Failure, resume, and concurrency evidence

- A temporary staging-read interruption returns a retryable result while
  preserving the same protected batch. Normal-language resume compiles it once,
  deletes the stage, and returns the same result on an idempotent later retry.
- A state-save interruption after staging is reconciled from the matching
  bounded file by a fresh adapter. If permission was revoked first, recovery
  deletes and discards the stage instead of compiling it.
- The derived result is saved and read back with a fingerprint before staging
  deletion. If final result persistence fails, the stage remains available and
  resume completes without data loss. If only the later deletion-receipt save
  fails, the durable compiled result remains authoritative and resume finishes
  the bookkeeping without recompiling or losing output.
- Compiled and discarded batches whose generation deletion is still pending
  expose `retryable: true` with an English/Spanish cleanup-only message. A
  normal-language continue request retries that exact generation and changes
  public deletion truth only after durable lifecycle persistence. An additional
  filesystem link exposes `needsAttention: true`; removing a pre-existing link
  allows a safe retry, while an unverified post-unlink case requires local
  review and never reports deletion automatically.
- Startup accepts a worker receipt or tombstone only when its version, batch,
  current lifecycle lease, generation filename, canonical timestamp, and
  durable unlink-verification state all match and both exact generation paths
  are absent. Wrong-version, wrong-lease, non-canonical/future-time, stale,
  unverified, or forged artifacts cannot alter lifecycle truth.
- Compilation and the generic QWA-139 lifecycle share one canonical, full-root
  in-process lock. Ordinary calls serialize across canonical path aliases, and
  a descendant public writer invoked from a state-store/connector callback now
  fails closed instead of re-entering with a stale root snapshot. This proof
  does not claim that every specialized lifecycle writer is covered: QWA-149
  must wrap those writers before whole-lifecycle race protection can be
  claimed.
- Exact-boundary expiry, restart cleanup, permission broadening, revocation
  before ordinary and untracked recovery, retention-service failure, and
  creator-process exit all have focused failure-path coverage.

## Verification

```sh
npm run test:qwa-146
npm run test:qwa-139
npm test
rg --files src test test-support -g '*.mjs' | xargs -n 1 node --check
git diff --check
! ps -axo pid=,ppid=,command= | grep -E '[p]rivate-staging-retention-worker\.mjs|[q]wa146-env-observer-worker\.mjs'
```

- QWA-146 focused suite: **45/45 passed**.
- Shared QWA-139 permission suite: **11/11 passed**.
- Full repository suite: **93/93 passed**.
- All source, test, and test-support `.mjs` files passed `node --check`, and
  `git diff --check` reported no whitespace errors.
- No detached retention worker remained after either focused or full
  verification.

## Honest limitations

This ticket deliberately does not write a customer vault or connect to a live
source. It is a safe fixture-based contract for later approved ingestion and
vault-writing work; it must not be presented as a live import.

The shared state lock is in-process only; it does not provide cross-process
atomicity. Whole-root safety also remains dependent on QWA-149 integrating all
specialized source lifecycle writers with this same lock.

The metadata digest binds the exact normalized snapshot and catches stale or
inconsistent persisted state; it is not a keyed signature against an actor who
already has arbitrary write access to the private state file and can recompute
the digest. Local state-file access remains part of the trusted host boundary.

The detached retention worker survives the compiler creator process exiting,
but a host shutdown can interrupt it. On the next adapter startup, durable
staging is rechecked and either adopted/re-armed or deleted early if coverage
cannot be restored. The 24-hour timestamp is the deletion deadline and first
attempt, not a false guarantee that a persistently failing or offline host has
already removed bytes: transient host/filesystem failures remain explicit and
retry until absence is verified. A running worker records content-free,
generation-bound cleanup evidence and will not delete a newer generation that
reuses the same batch ID.

If staged bytes are moved away or retained through another filesystem hard
link outside the private staging entry, this adapter cannot prove or erase
that external residue. It keeps the generation in a truthful needs-attention
state, preserves retry coverage, and requires local operator review instead of
claiming the 24-hour cleanup completed.
