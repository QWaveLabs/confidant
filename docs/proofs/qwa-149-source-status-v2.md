# QWA-149: Safe Source Status v2

## What this customer can see

Every source uses the same visible states:

| State | What it means | What has not happened |
| --- | --- | --- |
| `not-started` / `unfinished` | The optional source has not been started. | No connection or source read. |
| `awaiting-grant` / `unfinished` | A metadata-only preview is ready for a granular decision. | No source body, attachment, file, event, or message was read. |
| `ready-to-import` / `unfinished` | The customer approved exact simulated export item ids. | No real source was connected or verified. |
| `importing` / `unfinished` | A durable import checkpoint exists and must be recovered before another import starts. | A process restart cannot silently present the import as complete. |
| `imported` | A labelled, one-time **simulated export snapshot** was imported. | No live connector was claimed; the one-time permission is closed. |
| `skipped` | The optional source is intentionally deferred and can be resumed. | No content permission was granted or restored. |
| `revoked` | The saved permission is revoked and an earlier approval cannot reactivate it. | No source write occurred. |
| `needs-attention` / `unfinished` | A fail-closed cleanup or recovery action must complete before setup continues. | An uncertain grant is never hidden behind a completed or skipped state. |
| `unsupported` | The safe setup cannot support the requested source. | No connection or fictitious connection link was attempted. |

English example: “The preview was metadata-only. No source body was read. Choose exactly which simulated export items you approve before importing a labelled snapshot.”

Ejemplo en español: “La vista previa fue solo de metadatos. No se leyó ningún cuerpo de fuente. Elige exactamente qué elementos de exportación simulada autorizas antes de importar una instantánea.”

## Safe vertical slice proof

The included `SimulatedGenericExportAdapter` has no source SDK, no body-read operation, and no source-write operation. Its safe flow is:

1. Metadata-only preview with generic labels and opaque ids.
2. Explicit granular permission for selected item ids, with three acknowledgements.
3. One-time, snapshot-labelled import that returns only opaque references.
4. Immediate close/revocation of the simulated one-time permission.

The returned snapshot must contain each normalized approved `sourceRecordId`
exactly once and must be set-equal to the granular selection. Matching only the
record count is insufficient: an `A + A` adapter result for an approved `A + B`
selection fails closed, exposes zero references, and closes the adapter grant
before another review can start.

If registration or import fails after the adapter may have seen a grant, the
local record becomes `needs-attention` with a durable revocation generation.
It cannot be skipped, restarted, or granted again until revocation is
confirmed. A concurrent revoke wins over a stale import response; the stale
response returns no snapshot references and cannot overwrite the persisted
revoked state. When revoke overtakes an in-flight grant registration, the
customer-visible result stays `needs-attention` until that registration has
actually settled and a second adapter cleanup has been confirmed. If that
post-registration cleanup fails, the durable result is
`revocation-unconfirmed`, even while the simulated adapter still holds the
grant; an explicit retry closes it before `revoked` can be shown. If the
process exits after the durable `importing` checkpoint, the next process can
recover that checkpoint by revoking the possible grant and narrowing the
source back to a fresh metadata-only preview. Recovery does not replay the
import or expose snapshot references.

Gmail now saves the exact plugin grant identifier before activation. If the
plugin accepts that identifier and a later generic/full-root save fails, the
identifier remains a durable cleanup obligation. Gmail stays
`needs-attention`; skip or revoke retries the plugin identifier, reconciles the
linked generic grant, and only then presents `skipped` or `revoked`. A
non-throwing plugin call is not proof of revocation: the adapter must return an
exact-grant revocation result or an exact-grant readback. Missing, mismatched,
or ambiguous evidence remains `revocation-unconfirmed` and cannot be presented
as skipped or confirmed. Legacy
generic grants are checkpointed without registering a duplicate, and a
mismatched interrupted generation closes both possible plugin identifiers
before local permission state is cleared. The same fail-closed rule applies
when a provider reports external revocation but local/plugin cleanup cannot be
confirmed.

Gmail adapter account identifiers and internal review, grant, and page-read
generation identifiers remain private state. Customer-visible connection,
permission, reference, status, and final-handoff views use persisted local
aliases; one serialized regression sweeps all of those surfaces for the raw
adapter account, review, grant, page-generation, and page-token strings.
Google Drive and iMessage apply the same persisted-alias boundary to adapter
account, review, grant, reference, audit, and any generation identifiers.
Their direct status, permission review, approved references, final handoff,
and restart views are swept as serialized strings for raw test identifiers.
Guided lifecycle writers translate a current local alias back to the private
adapter identifier only after entering the shared state lock; an unknown or
stale alias fails closed.
Valid Drive and iMessage lifecycle entries created before aliases existed are
upgraded under that same root write lock before status projection or guided
resume. The migration prepares account, review, grant, reference, and
generation mappings transactionally, saves them in the canonical root, and
then projects from that same loaded root. A two-account restart regression for
each connector proves the records retain distinct stable ids and do not
collapse into a shared fallback. Calendar handoff/status projection uses the
same persisted local-account alias format; this candidate exports the pure
loaded-root migration helper needed for additive integration with the newer
primary Calendar connector.

Before any final handoff, specialized Drive/iMessage status, or guided reverse
mapping is projected, the complete persisted alias map for every lifecycle
participant is validated from one loaded root. Duplicate account aliases,
duplicate private account/source ids, cross raw-account/public-alias claims,
colliding review/reference/generation aliases, and partially malformed maps
invalidate every affected participant, including an otherwise valid entry that
collides with a malformed one. No
first-match or last-write-wins resolution is permitted. Valid, non-colliding
participants remain visible. The same lifecycle-wide validation covers the
additive Calendar namespace helper; it does not replace or claim to contain the
newer primary Calendar connector.

Drive and iMessage adapter exceptions are classified into fixed internal
failure reasons before any audit save or public projection. Arbitrary adapter
`error.code` strings are neither stored nor returned. A handoff-first
process-restart regression seeds recognized valid legacy Drive metadata,
approved-fetch, and revoked-fetch events plus iMessage entry and root-audit
events with recognizable hostile values. While holding the shared root write
lock, handoff prepares the stable aliases and fixed failure reasons on the
same loaded root, performs one save, and only then projects status. The
regression sweeps the entire persisted root and the public handoff and
specialized status views to prove every hostile value is absent; the proof
export repeats that restart path and publishes only the allowlisted internal
enums. Failure-code sanitation is independent of alias validity, so recognized
Drive/iMessage entry failures and the root iMessage audit are rewritten to
fixed enums on the same loaded root even when an alias map or account field is
malformed. Malformed legacy entries are not guessed into validity and remain
omitted from public projection.
Metadata preflight recursively normalizes field names and rejects body-shaped
keys before a grant, including singular `Attachment` and nested/case-variant
message/email body fields.

Before each approved Gmail page call, the outer lifecycle now durably saves an
immutable pending read generation bound to the current review id, grant id,
opaque page checkpoint, and monotonically increasing operation revision. The
generic approved-fetch audit carries that marker in the same root. Only a
successful outer page-checkpoint save clears it. If the adapter page may have
run but the outer save does not commit, Gmail says `read-may-have-occurred`,
returns no uncommitted references, and a normal retry makes zero additional
page calls. The explicit recovery is to revoke that saved permission and start
a fresh metadata review; this proof does not claim exact resume through an
uncommitted post-read checkpoint. A failed pre-read marker save invokes no page
call and remains safely retryable.

All full-root lifecycle writers in this candidate for Gmail, Google Drive, and
iMessage use the same canonical per-state-root lock as the generic source-status
flow. Public writers are deliberately non-re-entrant and fail with typed
`STATE_LOCK_REENTRANT_OPERATION_BLOCKED`; trusted outer connector lifecycles use
explicit lock-held permission primitives. Ordinary non-migrating status reads
use the same queue in read mode. Drive/iMessage specialized status and final
handoff use write mode because they may durably add missing private aliases
before projecting the same loaded root. Hooked state-store and connector
regressions prove a rejected callback cannot be followed by the outer
stale-root save. The lock is deliberately described as **in-process only**; it
is not a cross-process file lock or compare-and-swap.
Each Gmail, Drive, and iMessage specialized status view loads one root exactly
once, then derives the connector view, shared permission review, and persisted
source-status projection from that same in-memory snapshot. Hooked Drive and
iMessage regressions would attempt a nested revoke on a second load and prove
one load, zero nested revokes, and a consistent public result.

The generic-export boundary normalizes case and removes separators before
classifying every nested key. Preview and import both reject singular/plural
message body, email body, attachment, payload, and header variants before an
untrusted value can be displayed or persisted; the regression matrix records
zero source-body consumption and exposes zero rejected records.

Run `npm run proof:qwa-149` to emit a JSON proof using a temporary local setup state and synthetic ids only. The output includes `bodyReads: 0`, `writeCalls: 0`, the imported snapshot label, the release-gate result, and `legacyFailureMigration` evidence showing a process restart before handoff with one load and exactly one save. Its `aliasIntegrity` evidence covers complete lifecycle-map validation, malformed-collision peer omission, cross raw-account/public-alias collision omission, duplicate source-id omission, contradictory-status prevention, fail-closed guided reverse mapping, valid-entry retention, the additive Calendar namespace, and a second restart with one load and zero saves. The proof also records normalized root iMessage audit, malformed-account entry sanitation, fixed Drive/iMessage reasons, `rawAdapterFailureCodesPersisted: false`, and `rawAdapterFailureCodesProjected: false`.

## Release gate

The synthetic proof produced by `npm run proof:qwa-149` deliberately leaves
`at-least-one-live-verified-connector` **unsatisfied**. Neither a simulation,
an adapter-reported state, nor a caller-supplied evidence object can label a
source as live.

This candidate cannot satisfy the gate. Every injectable, synthetic, host-shaped,
or caller-supplied plugin remains simulation-only, even when it reports
`simulated: false` and `actualRead: true`. Persisted lifecycle shapes are also
not accepted as live evidence. A future actual registered host-provider
integration must supply separately reviewed trusted evidence outside this public
API; it is intentionally absent here. The focused tests exercise missing-marker,
lookalike, synthetic, and fabricated-persisted-shape negatives without network
or Gmail access. Those tests are **not** live Gmail evidence and do not complete
QWA-145's outstanding real Gmail verification.

## Verified checks

- `npm run test:qwa-149` — **30/30** focused checks passed.
- `npm run test:qwa-145` — **17/17** Gmail compatibility checks passed.
- `npm run test:qwa-139` — **12/12** shared permission checks passed.
- `npm run test:qwa-142` — **9/9** Google Drive compatibility checks passed.
- `npm run test:qwa-150` — **7/7** iMessage compatibility checks passed.
- `npm test` — **98/98** repository checks passed in this isolated candidate.
- `npm run proof:qwa-149` — generated a synthetic-only JSON proof with `bodyReads: 0`, `writeCalls: 0`, a labelled simulated snapshot, an unsatisfied live-connector gate, one-load/one-save first migration, full lifecycle alias-integrity evidence, a one-load/zero-save second restart, and no raw adapter failure code persisted or projected.

## Boundaries and limitations

- No Gmail, Google Drive, Calendar, Slack, iMessage, WhatsApp, or real export source is accessed.
- No source bodies, customer records, attachments, links, staging data, or secrets are stored in this proof.
- Unsupported sources receive a safe explanation instead of a made-up connection, link, or live status.
- Final handoff and the Gmail, Drive, and iMessage status lookups use saved local lifecycle state only. A provider denial or cancellation remains unfinished with its exact authorization outcome; it is never silently presented as a customer skip.
- Skipping Gmail first revokes every durably tracked connector/plugin generation and the linked generic permission. If plugin cleanup is unavailable or interrupted, skip fails closed as `needs-attention` instead of hiding an active grant.
- Google Calendar status projection is covered against the current-primary persisted lifecycle shape, but this older candidate branch does not contain the newer primary Calendar adapter. Additive integration must retain the primary Calendar lifecycle, its existing canonical write-lock wrappers, and all index exports. Before the first public Calendar status projection, call the exported `migratePersistedAdapterAliasesInState(...)` while holding that canonical root write lock, save the same root if it changed, and pass the resulting account alias (or raw private account id resolved from that same root) to `getPersistedAdapterSourceStatus(...)`; alias-stable later reads can remain read-locked. Then rerun the integrated Calendar and full suites.
- Primary integration must preserve QWA-148's stronger shared permission module and Slack-specialized exports; never replace it with this candidate file. QWA-148 already contains the typed non-reentrant lock, read lock, and explicit `begin/grant/deny/revoke/fetch*WithinStateLock` primitives. Apply QWA-149's Gmail, Drive, and iMessage callers to those existing primitives. For status composition, retain QWA-148's stronger `getSourcePermissionStatusFromState(...)` pattern using the exact root snapshot already loaded under the connector lock (or add an equivalent read-held helper); do not reintroduce a second public status read. Add QWA-149's read-lock wrappers for generic source status/handoff, while preserving every Slack boundary and primary index export.
- The canonical state lock coordinates aliases and nested calls only within one Node.js process. Separate processes can still race on the same JSON state root and require a later cross-process atomicity mechanism.
- This is a status and simulated-export vertical slice, not a live connector release.
