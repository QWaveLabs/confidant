# QWA-145 — Gmail Read-Only Lifecycle Proof

## Evidence boundary

This is a controlled local contract proof. It uses `SimulatedGmailPlugin`; it did **not** authenticate to, list, read, send, label, archive, delete, or modify a real Gmail account. Therefore it does not represent Gmail as live.

## Customer-visible path exercised

| Customer step | Visible result | Safety evidence |
| --- | --- | --- |
| “I want to connect Gmail to my second brain.” | Gmail is described as a separate read-only source. | The simulated plugin reports zero metadata and approved-page reads before the customer proceeds. |
| Plugin unavailable or cancelled | One exact fallback action appears: “In Codex Desktop, open Apps, select Gmail, and choose Connect.” | No metadata or message-body fetch occurs. |
| “Please review Gmail for my second brain.” | The customer sees a metadata-only review and the previous-90-days communication window. | The grant remains absent; no approved page can be fetched. |
| “I approve the reviewed Gmail scope.” | A granular read-only permission is saved. | QWA-139 acknowledgements and the persisted grant are required before the next step. |
| “Process my approved Gmail references.” | Only normalized opaque references such as `gmail:mail-001` are returned. | Every page record must independently match the approved date, area, and email-category boundaries; no body, snippet, header, payload, or source title is returned; write capability remains false. |
| Large mailbox | The importer pauses only after the outer page checkpoint is durably saved. | A committed checkpoint resumes from the next opaque page token without duplicate references; a repeated checkpoint fails closed instead of looping. |
| Interrupted or uncommitted page / revoked authorization | The connection becomes `needs-attention` or `revoked` with an explicit recovery path. | Before every page call, an immutable pending generation binds the review, grant, page token, and operation revision. If the page may have been read but the outer checkpoint is not durable, status says `read-may-have-occurred`, a normal retry makes no additional page call, and recovery requires revoking the saved permission and starting a fresh metadata review. Exact resume is not claimed for that uncommitted page. |
| Spanish conversation | The same metadata, grant, and simulation truth are shown in Spanish. | Gmail remains non-live in the simulation. |

## Automated proof

Run locally:

```sh
npm run test:qwa-145
```

Result on this branch: **14 passing tests, 0 failures**. The black-box scenarios cover metadata-first ordering, 90-day scope, granular grant registration, empty sources, cancelled/unavailable plugin flow, metadata retry, normal oversized pagination checkpoints, pre-read save failure with zero page calls, post-fetch outer save failure, persistent save failure across restart, zero-reread recovery, out-of-scope page rejection, repeated-checkpoint rejection, permission cancellation, local/external revocation, body-boundary rejection, opaque reference normalization, English/Spanish customer wording, and the no-live-simulation rule.

## Remaining limitation

This slice only supplies an injected connector contract and a simulation. No injected plugin can be labeled `live-and-verified` in this candidate, regardless of caller-controlled `actualRead` or `simulated` fields. A future registered host-provider integration must establish any real read-only verification outside this public API. Clean-Mac/official-plugin verification remains a release-gate activity and has not been claimed here.
