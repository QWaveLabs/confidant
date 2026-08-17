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
reference, observed date, verified date (or explicitly unverified state), and
privacy restrictions. A missing assertion is displayed as **Unknown** or
**Desconocido**; it is never filled in.

Canonical notes separate the generated evidence block from a distinct
user-owned notes block. Source indexes contain only opaque source references,
claim IDs, and links to canonical notes; they do not repeat the claim text or
become a competing authority.

## Privacy and temporary staging evidence

- Staging is restricted to an absolute, dedicated
  `.qwave-second-brain-staging` directory outside every Git repository.
- Broad roots, repository paths, symbolic-link roots, symbolic-link batch
  files, oversized batches, raw-shaped fields, and arbitrary paths are
  rejected.
- The staging directory is restricted to owner access and each new batch is
  created owner-readable/writeable only.
- The protected batch is deleted after a successful compile. A 24-hour expiry
  cleanup also deletes interrupted batches and makes later resume fail closed.
- Public results expose a deletion timestamp/status but never a staging path or
  source-batch contents.

## Failure and resume evidence

The focused black-box suite injects one temporary staging-read interruption.
The first request reports a retryable interruption while preserving the same
protected batch. A normal-language resume with the same opaque batch ID
compiles it once, removes the staged file, and returns the same result on an
idempotent later retry.

It also proves that a revoked or broadened QWA-139 permission fails closed:
the compiler deletes an already-staged reference batch before it can produce a
claim.

The suite also advances the clock to the exact 24-hour boundary, verifies that
the batch is removed, and verifies that a later resume is rejected until a new
approved batch is supplied.

## Verification command

```sh
npm run test:qwa-146
```

The focused test contains eight black-box checks covering canonical projections,
Spanish unknown handling, raw/grant boundaries (including a tampered persisted
scope), staging-root/symlink/expiry guards, retry/resume, revocation during
resume, and the 24-hour cleanup path.

## Limitation

This ticket deliberately does not write a customer vault or connect to a live
source. It is a safe fixture-based contract for the later approved ingestion
and vault-writing work; it must not be presented as a live import.
