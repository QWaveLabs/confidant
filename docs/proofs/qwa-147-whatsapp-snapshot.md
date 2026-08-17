# QWA-147 — Safe WhatsApp snapshot proof

## What this proves

This release slice adds a simulated, personal-account WhatsApp snapshot path
to the private setup conversation. It does **not** connect to a real WhatsApp
account, open the WhatsApp app, export customer messages, read a customer
snapshot, or claim live personal-account access.

The customer journey is intentionally one action at a time:

1. The customer exports one selected chat from WhatsApp themselves and records
   its timestamp.
2. The customer explicitly approves import of that one-time snapshot.
3. Only metadata is reviewed through the existing QWA-139 boundary.
4. The customer narrows chats, people, and the reviewed date window, then
   explicitly chooses whether media references are included.
5. Only after a granular QWA-139 grant may the adapter return opaque source
   references. It never returns message or media bodies in this proof.

Every public state calls the personal path a **one-time snapshot**, shows both
the customer-provided capture time and the local metadata-review time, and
marks `live: false`.

## Customer-visible safety behavior

| Situation | Public behavior |
| --- | --- |
| Personal WhatsApp is requested | The conversation explains that it is a guided snapshot, not a live connection, and asks for one selected-chat export action. |
| Export has not been confirmed | No adapter, metadata review, message, or media access occurs. |
| Import is not explicitly approved | The flow stays on the single import action; metadata access does not start. |
| Snapshot metadata is ready | QWA-139 presents the reviewed chats, people, 90-day communication window, supported exclusions, read-only purpose, model-processing disclosure, and untrusted-source disclosure. |
| Media choice has not been made | Content approval is blocked. The default remains exclude media. |
| Media is selected | The adapter receives the policy before the bounded fetch. Even then this simulated proof returns only opaque references, never media bodies. |
| Metadata or bounded-fetch interruption | The customer receives a truthful failure state with a saved retry path. No message or media body is exposed. |
| Permission is revoked | The local grant is revoked; the snapshot cannot be processed until a new review. No WhatsApp mutation is attempted. |

Imported chat names, messages, and media are treated as untrusted reference
material. They cannot issue instructions, widen permissions, reveal secrets,
open links, run commands, send messages, or mutate WhatsApp.

## Official WhatsApp Business boundary

Official WhatsApp Business is a separate status check, not a fallback for a
personal account. This branch supplies no live connector and no fake verifier.
It reports `live: false` unless a production-owned shared verification contract
returns all of the following for the exact Business account:

- protocol `qwave.shared-connector-verification/v1`;
- source `whatsapp-official-business`;
- verified, live, read-only, and explicitly non-simulated status;
- a valid verification timestamp and opaque evidence identifier.

Simulated, missing, malformed, or stale persisted verification cannot be used
to claim a live connection. A successful runtime verification is intentionally
ephemeral and does not grant any content access; a separate connector and
QWA-139 granular review would still be required.

## Automated evidence

`npm run test:qwa-147` runs six black-box cases using only synthetic fixtures:

1. personal account remains guided, snapshot-only, and inert until each
   approval;
2. QWA-139 bounds chats, people, dates, and default-no-media processing;
3. media requires an explicit choice and stays opaque even when chosen;
4. metadata and processing failures fail closed and resume from persisted
   state;
5. Spanish copy preserves the snapshot truth, hostile source metadata cannot
   widen scope, and revocation remains read-only;
6. missing, simulated, and malformed official-Business verification never
   imply a live account.

The fixture adapter has no open/export/send/edit/delete operation. Its source
records contain only non-customer placeholders, its `writeCalls` counter stays
at zero, and it reports zero raw-message and raw-media-body reads throughout
the assertions.

## Release limitations

This is a simulation-only vertical slice. It does not prove a real personal
WhatsApp export/import parser, real WhatsApp authorization, a real official
Business verification contract, a live Business connector, live account
availability, or processing of customer data. Those capabilities remain
blocked until separately implemented and verified with real, user-authorized
evidence.
