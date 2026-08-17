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

Run `npm run proof:qwa-149` to emit a JSON proof using a temporary local setup state and synthetic ids only. The output includes `bodyReads: 0`, `writeCalls: 0`, the imported snapshot label, and the release-gate result.

## Release gate

`at-least-one-live-verified-connector` is deliberately **unsatisfied** in this slice. Neither a simulation nor an adapter-reported state can label a source as live. The gate can only be satisfied by separately supplied, structured evidence of an independently verified read-only live connector; QWA-149 itself produces no such evidence.

## Boundaries and limitations

- No Gmail, Google Drive, Calendar, Slack, iMessage, WhatsApp, or real export source is accessed.
- No source bodies, customer records, attachments, links, staging data, or secrets are stored in this proof.
- Unsupported sources receive a safe explanation instead of a made-up connection, link, or live status.
- This is a status and simulated-export vertical slice, not a live connector release.
