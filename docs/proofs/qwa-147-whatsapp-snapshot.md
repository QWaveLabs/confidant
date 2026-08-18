# QWA-147 — Private WhatsApp snapshot boundary proof

## Delivered boundary

QWA-147 now provides a real, bounded local-file reader for a documented
personal WhatsApp snapshot format. It is not a live WhatsApp connection and it
does not parse WhatsApp's native ZIP export. The only accepted format is an
uncompressed **QWave WhatsApp Snapshot Bundle v1** inside an explicitly chosen
private local root:

- one `*.qwave-wa.json` metadata manifest;
- one or more per-chat `.jsonl` message segments; and
- optional opaque `.bin` media files.

The connector constructor and all getters perform zero filesystem operations.
After the customer confirms the export and explicitly approves local import,
preflight opens only the manifest. Selected JSONL/media bodies remain unopened
until a granular, immutable QWA-139 grant exists.

The implementation never opens WhatsApp, never exports on the customer's
behalf, never sends/edits/deletes a message, and exposes no source-write API.

## Bundle v1 schema

The manifest accepts only this metadata shape (values below are illustrative):

```json
{
  "format": "qwave.whatsapp-snapshot-bundle/v1",
  "generation": "export-generation-1",
  "capturedAt": "2026-08-17T11:30:00.000Z",
  "account": { "id": "local-account-id", "label": "Private account label" },
  "people": [
    { "id": "person-id", "label": "Private person label", "accessLevel": "allowed" }
  ],
  "chats": [
    {
      "id": "chat-id",
      "label": "Private chat label",
      "type": "direct",
      "participantIds": ["person-id"],
      "sensitivity": "general",
      "media": "none",
      "segments": [
        {
          "path": "segments/chat-1.jsonl",
          "sha256": "<64 lowercase hex characters>",
          "bytes": 123,
          "count": 1,
          "from": "2026-08-10T12:00:00.000Z",
          "to": "2026-08-10T12:00:00.000Z"
        }
      ]
    }
  ]
}
```

Manifest, account, person, chat, and segment objects reject unknown fields.
That means `body`, `content`, `text`, message arrays, media bodies, and similar
content cannot be smuggled into metadata preflight.

Each JSONL line is opened only after grant and accepts exactly:

```json
{
  "id": "message-id",
  "chatId": "chat-id",
  "senderId": "person-id",
  "sentAt": "2026-08-10T12:00:00.000Z",
  "sensitivity": "general",
  "text": "Untrusted message body",
  "media": [
    {
      "id": "media-id",
      "path": "media/item.bin",
      "sha256": "<64 lowercase hex characters>",
      "bytes": 123,
      "mimeType": "application/octet-stream"
    }
  ]
}
```

Bodies are parsed only to produce inert opaque references. Message text and
media bytes are never returned or persisted by the public lifecycle.

## Permission and privacy behavior

The guided English/Spanish flow is one action at a time:

1. offer a personal, local, non-live snapshot;
2. require customer confirmation of the exact capture time;
3. require explicit manifest-preflight approval;
4. show alias-only metadata and require explicit chat, Allowed-person, date,
   sensitive-category, and media choices;
5. persist the immutable selection;
6. require the exact QWA-139 read-only grant; and
7. read only grant-bound segments/media and return opaque references.

Selection is fail-closed:

- every selected chat participant must be explicitly classified `allowed`;
- the selected people must exactly equal the participant union for the chosen
  chats, so an unrelated Allowed person cannot be added;
- sensitive approvals must exactly equal the chosen chats' sensitivities;
- dates must be strict UTC timestamps, remain inside the reviewed window, and
  end no later than capture;
- media must be an explicit boolean and is immutable in the grant; and
- unknown access, sensitivity, participants, media state, MIME type, or record
  metadata stops processing.

Raw account/person/chat/group/message/media IDs, raw labels, the manifest's raw
generation, local roots, relative filenames, the full manifest digest, and
per-segment/media digests stay inside connector memory or the customer-owned
manifest. Private durable state retains opaque snapshot and selection bindings
needed for replay defense, but never the raw mapping, raw generation, full
manifest digest, or per-content-file paths/digests. Public output exposes no
path or digest; it contains only local aliases such as `wa-account-*`, `wa-person-*`,
`wa-chat-*`, `wa-message-*`, and `wa-media-*`, generic labels, and an opaque
snapshot reference. The connector rejects a caller-supplied account reference
unless it already uses the local `wa-account-*` namespace. The unsupported
Business status boundary enforces the same account-alias rule.

Imported content is always inert and untrusted. It cannot change permission,
open links, reveal secrets, run actions, or write to WhatsApp.

## File and replay defenses

The connector canonicalizes the approved root only after import approval and
rejects:

- native ZIP and other compressed/archive formats;
- absolute, escaping, backslash, empty-component, overlong, or deeply nested
  content paths;
- files inside the code repository;
- symlinked or hard-linked files;
- non-regular files, changed file identities, size mismatches, digest
  mismatches, truncated JSONL, duplicate IDs, reused paths, and overlapping
  chat segments; and
- manifest replacement after review or connector/snapshot substitution.

The immutable manifest binding is revalidated immediately before each selected
segment and each selected media open. Each segment/media file is then opened
read-only with no-follow behavior, identity and byte bounds are checked across
the open, and its SHA-256 digest is verified before records or media references
are used. Reads allocate no more than the approved file size plus one sentinel
byte, so a concurrently growing file cannot turn a bounded import into an
unbounded read.

Default upper bounds are:

| Boundary | Limit |
| --- | ---: |
| Manifest | 512 KiB |
| People / chats / segments | 2,000 / 500 / 2,000 |
| Records | 50,000 |
| One JSONL segment / all JSONL | 8 MiB / 64 MiB |
| One JSONL line / message text | 256 KiB / 128 KiB |
| Media files | 500 |
| One media file / all media | 16 MiB / 128 MiB |
| Path characters / components | 1,024 / 64 |

Callers may only lower these limits.

## Durable failure, resume, and concurrency proof

- A durable pending save occurs before manifest preflight and before selected
  body access. If either save fails, the corresponding file is not opened.
- Metadata review correlation is preserved across an outer final-save failure;
  retry resumes the same generation instead of adopting an unrelated review.
- Review and grant identifiers cannot be reused across generations, and every
  public mutation requires the current numeric generation.
- The generic permission layer persists an alias-only fetch receipt before the
  outer lifecycle marks processing complete. An outer final-save failure is
  reconciled from that receipt without another body read.
- If the fetch outcome lacks a durable receipt, status becomes
  `fetch-interrupted`; there is no automatic retry. A customer must explicitly
  confirm retry. Same-process retries use the connector's immutable idempotency
  cache; after process loss, an explicitly confirmed retry may re-read the same
  unchanged approved files.
- Deny, cancel, revoke, repeated revoke, restart, and cleanup are generation
  safe. Revocation is exactly once and never mutates the source files. The
  connector must read back the exact local grant as inactive and revoked before
  the lifecycle confirms removal. A nonthrowing but lying revoke remains
  `revoke-unconfirmed`, blocks processing, and exposes only a retry action.
- All full-root permission and WhatsApp transactions use the canonical
  process-local re-entrant lock. Internal specialized permission primitives may
  re-enter; descendant state-store and connector callbacks invoking a public
  revoke or cross-source write are rejected before they can save, preventing a
  stale outer save from erasing or resurrecting state.

Cleanup clears connector-private maps, and bounded file byte buffers are zeroed
after each read. The implementation makes no claim about JavaScript garbage-
collection timing for temporary parsed strings. It creates no staging files and
deliberately does not delete the customer-owned export; the customer retains it
until they delete it.

## Official WhatsApp Business truth

No registered shared host provider exists in this release. Therefore every
public WhatsApp Business path is unconditionally:

- `status: "unsupported"`;
- `live: false`;
- `verified: false`; and
- source/content access not started.

Caller-supplied contracts, fake evidence, stale evidence, and simulated claims
are not invoked or accepted. This ticket does not claim live Business access.

## Automated evidence

All evidence uses generated temporary fixtures only. No customer export,
WhatsApp account, network service, or live source was accessed.

Final verified commands and exact results:

| Command | Result |
| --- | ---: |
| `npm run test:qwa-147` | 46/46 passed |
| `npm run test:qwa-139` | 10/10 passed |
| `npm run test:qwa-142` | 8/8 passed |
| `npm run test:qwa-150` | 6/6 passed |
| `npm test` | 93/93 passed |

The focused suite covers zero-I/O construction, manifest-only lazy preflight,
raw-value scans of public and persisted state, exact membership/sensitivity,
no-media and approved-media reads, hostile instructions, malformed/oversize/
truncated files, archive/path/symlink/hardlink/repository defenses, manifest and
file replacement, timestamp/skew/record-capture rules, connector substitution,
generation replay, all durable save seams, explicit retry, idempotency,
concurrent fetch/revoke/cross-source writers, same-context callback re-entry,
terminal revoke recovery, exact-grant revoke readback against a lying adapter,
media-excluded zero-open behavior, cleanup/restart truth, Spanish behavior, and
Business forgery rejection. Public and durable-state scans include raw account,
person, chat, message, media, label, path, manifest-generation, and digest
values.

## Honest release limitations

- This is a local normalized snapshot contract, not native WhatsApp ZIP
  support and not an exporter.
- Personal and Business access both remain non-live.
- Only synthetic bundles were verified; no real/customer WhatsApp data was
  accessed in this ticket.
- The state lock is in-process only. This work does not claim cross-process or
  multi-host atomicity; a future durable state-store transaction contract is
  required for that.
- Source export files remain customer-owned on disk and are not deleted by the
  application.
