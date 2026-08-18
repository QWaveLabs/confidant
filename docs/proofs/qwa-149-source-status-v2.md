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

If registration or import fails after the adapter may have seen a grant, the
local record becomes `needs-attention` with a durable revocation generation.
It cannot be skipped, restarted, or granted again until revocation is
confirmed. A concurrent revoke wins over a stale import response; the stale
response returns no snapshot references and cannot overwrite the persisted
revoked state. If the process exits after the durable `importing` checkpoint,
the next process can recover that checkpoint by revoking the possible grant
and narrowing the source back to a fresh metadata-only preview. Recovery does
not replay the import or expose snapshot references.

All full-root lifecycle writers in this candidate for Gmail, Google Drive, and
iMessage use the same canonical, per-state-root re-entrant lock as the generic
source-status flow. This prevents an awaited adapter response in one source
from saving a stale whole-root copy over an in-process revoke or lifecycle
update from another source. The lock is deliberately described as
**in-process only**; it is not a cross-process file lock or compare-and-swap.

Run `npm run proof:qwa-149` to emit a JSON proof using a temporary local setup state and synthetic ids only. The output includes `bodyReads: 0`, `writeCalls: 0`, the imported snapshot label, and the release-gate result.

## Release gate

The synthetic proof produced by `npm run proof:qwa-149` deliberately leaves
`at-least-one-live-verified-connector` **unsatisfied**. Neither a simulation,
an adapter-reported state, nor a caller-supplied evidence object can label a
source as live.

The gate can be satisfied only from linked persisted Gmail lifecycle evidence:
a non-simulated `live-and-verified` read-only connection, its matching active
granular QWA-139 permission, and a persisted non-simulated approved-page audit
showing an actual read with no body exposure. The focused test constructs this
combination with synthetic local state to prove the decision rule and then
shows that a simulated plugin record downgrades it. That test is **not** live
Gmail evidence, and it does not complete QWA-145's outstanding real Gmail
verification.

## Verified checks

- `npm run test:qwa-149` — **20/20** focused checks passed.
- `npm test` — **78/78** repository checks passed in this isolated candidate.
- `npm run proof:qwa-149` — generated a synthetic-only JSON proof with `bodyReads: 0`, `writeCalls: 0`, a labelled simulated snapshot, and an unsatisfied live-connector gate.

## Boundaries and limitations

- No Gmail, Google Drive, Calendar, Slack, iMessage, WhatsApp, or real export source is accessed.
- No source bodies, customer records, attachments, links, staging data, or secrets are stored in this proof.
- Unsupported sources receive a safe explanation instead of a made-up connection, link, or live status.
- Final handoff and the Gmail, Drive, and iMessage status lookups use saved local lifecycle state only. A provider denial or cancellation remains unfinished with its exact authorization outcome; it is never silently presented as a customer skip.
- Skipping Gmail first revokes both the connector/plugin grant and the linked generic permission. If the plugin needed to revoke the connector grant is unavailable, skip fails closed as `needs-attention` instead of hiding an active grant.
- Google Calendar status projection is covered against the current-primary persisted lifecycle shape, but this older candidate branch does not contain the newer primary Calendar adapter. Additive integration must wrap Calendar's four full-root writers with the shared lock, add the persisted status getter, preserve the primary adapter, and rerun the integrated suite.
- The canonical state lock coordinates aliases and nested calls only within one Node.js process. Separate processes can still race on the same JSON state root and require a later cross-process atomicity mechanism.
- This is a status and simulated-export vertical slice, not a live connector release.
