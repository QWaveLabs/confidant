# QWA-151 — Sanitized QWave support escalation proof

Date: 2026-08-19

This is a local controlled-adapter proof. It did **not** send an email, deploy
a relay, authenticate to an email provider, read customer sources, or create a
customer profile.

## Customer-visible path

Setup first tries the blocked stage again. Only after the same safe repair has
failed twice can it prepare an escalation automatically. A customer can also
say a normal-language request such as:

> Please contact QWave support about this blocker.

Automatic delivery is attempted at most once for a given blocker. If delivery
cannot be verified, ordinary setup retries preserve the local fallback instead
of repeatedly sending in the background; the customer can explicitly ask to
retry later.

When the controlled relay confirms delivery, Setup Session tells the customer
that a sanitized report was sent. When delivery cannot be verified, it says so
plainly and retains the sanitized report only in local setup state; it does not
pretend an email was delivered.

## Fixed, stateless support boundary

The client cannot select recipients. Every request is schema-limited to:

- `support@qwavelabs.io` and `rob@qwavelabs.io`;
- an anonymous installation ID, installer version, timestamp, sanitized macOS
  version/architecture/timezone, blocked stage and connector category;
- one allowlisted sanitized error category/message, safe-action outcome,
  bounded repair count, and allowlisted validation labels.

The relay validates the exact request shape, exact recipients, canonical
subject/body, 8 KiB maximum payload, duplicate blocker key, and a bounded
per-installation rate window. It rejects caller-added fields and never accepts
source content, customer contacts, credentials, prompts, local paths, or
caller-provided diagnostic text.

## Local acceptance evidence

Run from the private implementation repository:

```text
npm run test:qwa-151
```

Captured result after the final boundary review:

```text
1..7
# pass 7
# fail 0
```

The tests prove, using hostile fixture values, that:

1. one safe repair occurs before automatic escalation;
2. an ordinary-language support request works without a slash command;
3. arbitrary recipients, schema additions, oversized requests, duplicates,
   and rate-limit bypasses are rejected;
4. customer source text, contact identities, credentials, prompts, local paths,
   local usernames, and sensitive filenames do not enter the serialized relay
   request; and
5. unavailable or missing relays keep a truthful local fallback, and ordinary
   setup retries do not silently re-send it;
6. a customer can explicitly retry an unavailable handoff, while a successful
   repair sends nothing; and
7. a report sent for one blocker is never presented as covering a later,
   different blocker.

Focused neighboring slices were also rerun locally after this change:

```text
npm run test:qwa-138
npm run test:qwa-139
npm run test:qwa-142
npm run test:qwa-143
npm run test:qwa-145
npm run test:qwa-147
npm run test:qwa-148
npm run test:qwa-149
npm run test:qwa-150
```

All completed without a reported test failure in this local workspace.

## Honest limitation and release gate

This proves the application-side contract only. A host-owned production relay
still needs its own deployment, provider delivery evidence, operational
monitoring, and retention review before anyone can claim that a real email was
sent. The clean-Mac, permission-aware release proof remains a separate gate;
this work does not replace it.
