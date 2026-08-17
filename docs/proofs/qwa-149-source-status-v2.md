# QWA-149: Safe Source Status v2

## What this customer can see

Every source uses the same visible states:

| State | What it means | What has not happened |
| --- | --- | --- |
| `not-started` / `unfinished` | The optional source has not been started. | No connection or source read. |
| `awaiting-grant` / `unfinished` | A metadata-only preview is ready for a granular decision. | No source body, attachment, file, event, or message was read. |
| `ready-to-import` / `unfinished` | The customer approved exact simulated export item ids. | No real source was connected or verified. |
| `imported` | A labelled, one-time **simulated export snapshot** was imported. | No live connector was claimed; the one-time permission is closed. |
| `skipped` | The optional source is intentionally deferred and can be resumed. | No content permission was granted or restored. |
| `revoked` | The saved permission is revoked and an earlier approval cannot reactivate it. | No source write occurred. |
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
revoked state.

Run `npm run proof:qwa-149` to emit a JSON proof using a temporary local setup state and synthetic ids only. The output includes `bodyReads: 0`, `writeCalls: 0`, the imported snapshot label, and the release-gate result.

## Release gate

`at-least-one-live-verified-connector` is deliberately **unsatisfied** in this slice. Neither a simulation, an adapter-reported state, nor a caller-supplied evidence object can label a source as live. QWA-149 has no trusted persisted connector, grant, and independent-read verification record; a separately reviewed live-connector lifecycle must persist that evidence before the gate can change.

## Verified checks

- `npm run test:qwa-149` — **15/15** focused checks passed.
- `npm test` — **73/73** repository checks passed.
- `npm run proof:qwa-149` — generated a synthetic-only JSON proof with `bodyReads: 0`, `writeCalls: 0`, a labelled simulated snapshot, and an unsatisfied live-connector gate.

## Boundaries and limitations

- No Gmail, Google Drive, Calendar, Slack, iMessage, WhatsApp, or real export source is accessed.
- No source bodies, customer records, attachments, links, staging data, or secrets are stored in this proof.
- Unsupported sources receive a safe explanation instead of a made-up connection, link, or live status.
- Final handoff and the Gmail, Drive, and iMessage status lookups use saved local lifecycle state only. A provider denial or cancellation remains unfinished with its exact authorization outcome; it is never silently presented as a customer skip.
- This is a status and simulated-export vertical slice, not a live connector release.
