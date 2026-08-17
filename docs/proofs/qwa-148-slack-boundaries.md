# QWA-148 Slack channel and people boundaries proof (simulated)

Date: 2026-08-17

This proof exercises the public QWave Second Brain Setup Session extension with
a controlled, offline adapter for the official Slack-plugin seam. It does not
open a Slack workspace, begin OAuth, read a customer message body, retain a
workspace dump, post, react, edit, archive, invite, change Slack state, or use
customer credentials.

## Customer-visible guided path

After the normal, plain-language Setup Session, a customer can say:

> Please connect Slack to my second brain

The saved flow remains in the same conversation:

```text
plain-language Slack request
  -> explain the official-plugin seam and explicit read-only approval
  -> simulated non-writing verification
  -> complete metadata-only pagination review
  -> granular channel / DM / group / people / date permission grant
  -> bounded opaque stable-thread-reference processing
```

No slash command is required. The same guidance is covered in Spanish. Every
public result says that this is a **simulation-only** contract proof and keeps
`live: false`; it never represents the fixture as a connected live Slack
workspace.

## Read-only and privacy boundaries

Before any approved fetch, the customer can independently narrow:

- public channels;
- direct-message conversations;
- group-message conversations;
- Allowed, Restricted, and Blocked people; and
- the default previous-90-days date window.

The shared permission lifecycle now treats the Allowed-person selection as a
real allowlist: an omitted Allowed person is added to the connector-side
exclusions before the bounded fetch. Restricted and Blocked people remain
excluded.

Private channels, and channels whose visibility is unknown, are excluded
before they enter the metadata review. The status reports only a safe count;
it does not expose their names or identifiers. Every simulated Slack record
must carry a valid timestamp, so an undated record cannot bypass the date
boundary.

A group containing a Blocked person is listed only as an opaque group ID and
is skipped by default. It can be included only after a separate review and an
explicit confirmation for that single group. That exception cannot approve a
different group or a different Blocked person. The connector receives that
persisted one-group policy before the fetch, so a generic grant containing an
exception cannot by itself make a blocked group readable.

The adapter exposes no write operation. The read-only verification proves that
posting, reactions, edits, archiving, invitations, and workspace-state changes
are all unavailable. Its counters remain zero for writes.

## Safe source references

An approved fetch returns only validated, inert references such as:

```text
slack:<workspace-id>:<conversation-id>:<thread-id>
```

Each reference can include an opaque conversation ID, thread ID, and (when
available) opaque parent-thread ID. It does not contain a message body, title,
workspace name, permalink, attachment, participant profile, or raw channel
dump. Imported source material remains untrusted reference data and cannot
change scope or cause a write.

## Failure, resume, and truthful status

- An authorization denial becomes `skipped` without reading metadata or a
  message body, and can be retried later.
- Incomplete metadata pagination becomes `needs-attention`; no permission
  review or content fetch is created. Once pagination is complete, the saved
  setup resumes through a fresh metadata-only review.
- A revoked plugin response deactivates the local simulated grant and reports
  `revoked`, `live: false`, and no approved references.
- A malformed safe-reference response stops in `needs-attention` and exposes
  no reference payload.

## Automated acceptance evidence

Run from the private implementation repository:

```text
npm run test:qwa-148
npm test
```

The focused suite contains seven passing scenarios:

1. explicit authorization, read-only verification, complete metadata
   pagination, and no body access;
2. independent channel, direct-message, group-message, people, and date
   enforcement before opaque references are exposed;
3. default blocked-group exclusion plus a separate one-group exception review;
4. truthful incomplete-pagination recovery and private-channel denial;
5. revoked access deactivating the local grant without a Slack write; and
6. malformed stable-reference output failing closed without exposing its
   injected source text; and
7. denial/retry plus equivalent Spanish safety language.

Captured verification after the final security pass:

```text
# QWA-148 focused suite
1..7
# pass 7
# fail 0

# full private suite
1..46
# pass 46
# fail 0
```

## Honest limitation and release gate

This is a controlled adapter-contract proof, not evidence that a real Slack
plugin, OAuth flow, workspace, pagination API, or production read-only token
works. It does not satisfy the real-device connector validation gate. Until a
clean-Mac, interactive official-plugin verification passes, customer-facing
status must remain **selected but unfinished / simulation-only**, never live
and verified.
