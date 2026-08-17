# QWA-146 — approved-record canonical compilation proof

## Verified scope

This proof covers a local, simulated contract only. No Gmail, Calendar, Drive,
iMessage, WhatsApp, customer vault, source account, source body, credential, or
generated customer vault was accessed.

The customer can say in ordinary English or Spanish that they want to compile
their approved notes. Slash commands are rejected. The compiler accepts only
short, normalized, `untrusted-inert-reference` records that still match an
active QWA-139 metadata review and granular grant. It never invokes a source
connector or upgrades a source to live status.

## Customer-visible result

For a non-sensitive fixture batch, the simulated result produces canonical
subject-note projections for:

- People
- Organizations
- Projects
- Decisions
- Priorities
- Areas
- Meetings
- Knowledge

Every generated claim has a stable claim ID, confidence, opaque source
reference, source timestamp, approved opaque participant references, a safe
reviewed source label (or a neutral label), an approved stable link when one
exists, processing timestamp, observed date, verified date (or explicitly
unverified state), and privacy restrictions. A missing assertion is displayed
as **Unknown** or **Desconocido**; it is never filled in.

Canonical notes separate the generated evidence block from a distinct
user-owned notes block. Source indexes contain only opaque source references,
claim IDs, and links to canonical notes; they do not repeat the claim text or
become a competing authority.

## Privacy and temporary staging evidence

- Staging is restricted to an absolute, dedicated
  `.qwave-second-brain-staging` directory outside every Git repository.
- Broad roots, repository paths, symbolic-link roots, symbolic-link batch
  files, oversized batches, raw-shaped fields, arbitrary paths, and any
  incomplete direct-staging record schema are rejected.
- The staging directory is restricted to owner access and each new batch is
  created owner-readable/writeable only.
- The protected batch is deleted after a successful compile. A 24-hour expiry
  cleanup also deletes interrupted batches and makes later resume fail closed.
  The fixed expiry is stored in the protected batch itself, is rechecked when a
  fresh staging adapter starts, and leaves a path-free expiry tombstone so a
  crashed process cannot revive the same opaque batch ID.
- Public results expose a deletion timestamp/status but never a staging path or
  source-batch contents.

## Failure and resume evidence

The focused black-box suite injects one temporary staging-read interruption.
The first request reports a retryable interruption while preserving the same
protected batch. A normal-language resume with the same opaque batch ID
compiles it once, removes the staged file, and returns the same result on an
idempotent later retry.

It separately injects a private state-save failure after the protected file is
durably written. A new staging adapter safely reconstructs the lifecycle from
the matching bounded batch without returning `STAGING_BATCH_EXISTS`; if the
QWA-139 grant was revoked before that recovery, the batch is deleted and marked
discarded instead.

It also proves that a revoked or broadened QWA-139 permission fails closed:
the compiler deletes an already-staged reference batch before it can produce a
claim.

The suite also advances the clock to the exact 24-hour boundary, verifies that
the batch is removed, starts a fresh adapter against an expired on-disk batch,
and verifies that a later resume is rejected until a new approved batch is
supplied. It rejects source timestamp, participant-reference, label, and stable
link mismatches before anything is staged.

## Verification command

```sh
npm run test:qwa-146
```

The focused test contains twelve black-box checks covering canonical
projections, Spanish unknown handling, raw/grant/provenance boundaries
(including a tampered persisted scope), direct staging-schema and
root/symlink/expiry guards, retry/resume, durable state-save reconciliation,
revocation during both ordinary and untracked recovery, and restart-safe
24-hour cleanup.

## Limitation

This ticket deliberately does not write a customer vault or connect to a live
source. It is a safe fixture-based contract for the later approved ingestion
and vault-writing work; it must not be presented as a live import.
