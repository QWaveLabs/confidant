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
- Missing or malformed person access metadata defaults to Restricted. Unknown
  sensitivity labels and malformed uncertainty markers become
  `uncertain-sensitivity`, which remains excluded by default. Both the
  simulated connector and the compiler fail closed if persisted metadata is
  malformed or broader than the reviewed grant.
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
- Before a batch file is created, the adapter arms a detached local cleanup
  worker and waits for its acknowledgement. The worker receives only the
  private staging root, opaque batch ID, and fixed expiry; it never reads or
  logs staged records. A process-level test proves the worker deletes the batch
  after the creator process exits.
- A fresh adapter rechecks every durable expiry and re-arms independent cleanup
  for an unexpired batch. If it cannot restore retention coverage, it deletes
  the batch early and marks the lifecycle discarded rather than retaining it
  without the promised cleanup.
- Successful compilation deletes the protected batch. On a running host,
  interrupted staging has an independently scheduled fixed 24-hour deletion,
  and later resume fails closed. Expiry leaves a path-free tombstone so the
  same opaque batch ID cannot be revived.

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
- Permission lifecycle operations and compilation share one canonical,
  full-root, re-entrant in-process lock. An adversarial lexical-path-alias race
  proves compilation cannot overwrite a concurrent revocation with a stale
  root save in the same process.
- Exact-boundary expiry, restart cleanup, permission broadening, revocation
  before ordinary and untracked recovery, retention-service failure, and
  creator-process exit all have focused failure-path coverage.

## Verification

```sh
npm run test:qwa-146
npm run test:qwa-139
npm test
```

- QWA-146 focused suite: **19/19 passed**.
- Shared QWA-139 permission suite: **11/11 passed**.
- Full repository suite: **67/67 passed**.
- No detached retention worker remained after either focused or full
  verification.

## Honest limitations

This ticket deliberately does not write a customer vault or connect to a live
source. It is a safe fixture-based contract for later approved ingestion and
vault-writing work; it must not be presented as a live import.

The shared state lock is in-process only; it does not provide cross-process
atomicity. The detached retention worker survives the compiler creator process
exiting, but a host shutdown can interrupt that worker. On the next adapter
startup, durable staging is rechecked and either re-armed or deleted early if
coverage cannot be restored.
