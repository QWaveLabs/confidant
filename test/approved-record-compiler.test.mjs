import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_SUBJECT_TYPES,
  FileStateStore,
  KnowledgeCompilationError,
  LocalTemporaryStaging,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedObsidianAdapter,
  SimulatedReadOnlyConnector,
  beginSourcePermissionReview,
  cleanupExpiredKnowledgeStaging,
  compileApprovedRecords,
  getKnowledgeCompilationStatus,
  grantSourcePermission,
  revokeSourcePermission,
  startSetupSession
} from "../src/index.mjs";

const startedAt = "2026-08-17T12:00:00.000Z";
const laterToday = "2026-08-17T13:00:00.000Z";

function clockAt(value) {
  return { now: () => new Date(value) };
}

function scopeForApproval(review) {
  const scope = structuredClone(review.permissionReview.permissionRequest.requestedScope);
  scope.acknowledgements.modelProcessing = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  return scope;
}

async function approveFixtureSource({
  stateStore,
  source,
  accountId,
  sourceRecordId,
  language = "en",
  sourceTimestamp = startedAt,
  participantRefs = [],
  sourceLabel = "Fixture metadata only",
  stableLink = null
}) {
  const connector = new SimulatedReadOnlyConnector({
    source,
    account: { id: accountId, label: "Fixture account" },
    people: participantRefs.map((id) => ({ id, label: `Fixture ${id}`, accessLevel: "allowed" })),
    items: [{
      id: sourceRecordId,
      kind: "item",
      area: "fixture-area",
      category: "planning",
      timestamp: sourceTimestamp,
      participantIds: participantRefs,
      label: sourceLabel,
      stableLink
    }]
  });
  const reviewId = `${source}-fixture-review`;
  const grantId = `${source}-fixture-grant`;
  const review = await beginSourcePermissionReview({
    message: language === "es" ? "Quiero revisar esta fuente para mi segundo cerebro" : "I want to review this source for my second brain",
    stateStore,
    connector,
    source,
    language,
    clock: clockAt(startedAt),
    reviewIdFactory: () => reviewId
  });
  await grantSourcePermission({
    message: language === "es" ? "Apruebo este alcance de solo lectura" : "I approve this read-only scope",
    stateStore,
    connector,
    source,
    accountId,
    reviewId,
    scope: scopeForApproval(review),
    language,
    clock: clockAt(startedAt),
    grantIdFactory: () => grantId
  });
  return {
    connector,
    source,
    accountId,
    sourceRecordId,
    reviewId,
    grantId,
    sourceTimestamp,
    participantRefs,
    sourceLabel,
    stableLink
  };
}

async function withCompilerFixture(run, { language = "en" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const staging = new LocalTemporaryStaging({ root: path.join(directory, ".qwave-second-brain-staging") });
  const adapters = {
    environment: new SimulatedEnvironmentAdapter(),
    obsidian: new SimulatedObsidianAdapter(),
    vault: new SimulatedDesktopVaultAdapter()
  };
  try {
    await startSetupSession({
      message: language === "es" ? "Configura mi segundo cerebro" : "Set up my second brain",
      answers: { displayName: "Fixture", focus: "exercise a safe compilation contract" },
      decisions: { vaultName: "Fixture Second Brain", language },
      stateStore,
      adapters,
      clock: clockAt(startedAt),
      installationIdFactory: () => "fixture-installation"
    });
    const gmail = await approveFixtureSource({
      stateStore,
      source: "gmail",
      accountId: "fixture-gmail-account",
      sourceRecordId: "fixture-mail-001",
      participantRefs: ["person-fixture-alex"],
      stableLink: "https://fixture.example.test/mail/fixture-mail-001",
      language
    });
    const calendar = await approveFixtureSource({
      stateStore,
      source: "calendar",
      accountId: "fixture-calendar-account",
      sourceRecordId: "fixture-event-001",
      language
    });
    await run({ directory, stateStore, staging, gmail, calendar });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function approvedRecord(permission, assertions, overrides = {}) {
  return {
    source: permission.source,
    accountId: permission.accountId,
    sourceRecordId: permission.sourceRecordId,
    reviewId: permission.reviewId,
    grantId: permission.grantId,
    processingDisposition: "untrusted-inert-reference",
    sourceTimestamp: permission.sourceTimestamp,
    approvedParticipantRefs: permission.participantRefs,
    sourceLabel: permission.sourceLabel,
    stableLink: permission.stableLink,
    observedAt: startedAt,
    verifiedAt: laterToday,
    privacyRestrictions: ["private", "no-external-sharing"],
    assertions,
    ...overrides
  };
}

function inertStagingRecord(overrides = {}) {
  return {
    source: "fixture",
    accountId: "fixture-account",
    sourceRecordId: "fixture-record",
    reviewId: "fixture-review",
    grantId: "fixture-grant",
    processingDisposition: "untrusted-inert-reference",
    sourceTimestamp: startedAt,
    approvedParticipantRefs: [],
    sourceLabel: null,
    stableLink: null,
    observedAt: startedAt,
    verifiedAt: laterToday,
    privacyRestrictions: ["private"],
    assertions: [assertion("knowledge", "knowledge-fixture-staging", "Staging", "The direct staging contract is normalized.")],
    ...overrides
  };
}

function assertion(subjectType, subjectId, subjectLabel, value, confidence = "confirmed", privacyRestrictions = ["private"]) {
  return {
    subjectType,
    subjectId,
    subjectLabel,
    assertion: value,
    confidence,
    privacyRestrictions
  };
}

function allApprovedRecords(gmail, calendar) {
  return [
    approvedRecord(gmail, [
      assertion("people", "person-fixture-alex", "Fixture Alex", "Fixture Alex owns the Atlas project."),
      assertion("organizations", "organization-fixture-qwave", "Fixture QWave", "Fixture QWave sponsors the Atlas project."),
      assertion("projects", "project-fixture-atlas", "Atlas", "Atlas has a bounded planning scope."),
      assertion("decisions", "decision-fixture-focus", "Focus decision", "The team chose a privacy-first compilation path.")
    ]),
    approvedRecord(calendar, [
      assertion("priorities", "priority-fixture-review", "Privacy review", "Privacy review is the current priority."),
      assertion("areas", "area-fixture-operations", "Operations", "Operations owns the fixture follow-up."),
      assertion("meetings", "meeting-fixture-kickoff", "Fixture kickoff", "The fixture kickoff recorded the approved scope."),
      assertion("knowledge", "knowledge-fixture-boundary", "Boundary note", "Only approved normalized references are compiled.")
    ])
  ];
}

class FailOnceReadStaging {
  constructor(delegate) {
    this.delegate = delegate;
    this.remainingReadFailures = 1;
  }

  async stage(input) { return this.delegate.stage(input); }

  async read(input) {
    if (this.remainingReadFailures > 0) {
      this.remainingReadFailures -= 1;
      throw new Error("Simulated transient staging interruption.");
    }
    return this.delegate.read(input);
  }

  async delete(input) { return this.delegate.delete(input); }

  async cleanupExpired(input) { return this.delegate.cleanupExpired(input); }
}

class FailNextSaveStateStore {
  constructor(delegate) {
    this.delegate = delegate;
    this.failNextSave = false;
  }

  async load() { return this.delegate.load(); }

  async save(state) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("Simulated private state save interruption.");
    }
    return this.delegate.save(state);
  }
}

test("approved references compile into sourced canonical notes for every QWA-146 subject category without retaining staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail, calendar }) => {
    const result = await compileApprovedRecords({
      message: "Compile my approved canonical notes",
      stateStore,
      staging,
      batchId: "fixture-full-batch",
      approvedRecords: allApprovedRecords(gmail, calendar),
      clock: clockAt(laterToday)
    });

    assert.equal(result.compilation.status, "compiled");
    assert.equal(result.compilation.live, false);
    assert.equal(result.compilation.simulated, true);
    assert.equal(result.compilation.rawSourceBodiesRetained, false);
    assert.equal(result.compilation.staging.status, "deleted-after-compilation");
    assert.equal(result.compilation.staging.deletedAt, laterToday);
    assert.equal(result.claims.length, 8);
    assert.deepEqual(
      result.canonicalNotes.map((note) => note.subject.type).sort(),
      [...CANONICAL_SUBJECT_TYPES].sort()
    );
    assert.equal(result.sourceIndexes.length, 2);
    assert.equal(gmail.connector.bodyFetchCalls, 0, "the compiler does not fetch a source body");
    assert.equal(calendar.connector.bodyFetchCalls, 0, "the compiler does not fetch a source body");

    for (const claim of result.claims) {
      assert.match(claim.id, /^claim-[a-f0-9]{20}$/);
      assert.equal(claim.confidence, "confirmed");
      assert.equal(claim.observedAt, startedAt);
      assert.equal(claim.verifiedAt, laterToday);
      assert.deepEqual(claim.privacyRestrictions, ["no-external-sharing", "private"]);
      assert.equal(claim.sourceReferences.length, 1);
      const reference = claim.sourceReferences[0];
      assert.match(reference.sourceRecordId, /^fixture-(mail|event)-001$/);
      assert.equal(reference.sourceTimestamp, startedAt);
      assert.equal(reference.processedAt, laterToday);
      assert.equal(reference.sourceLabel, "Fixture metadata only");
      if (reference.source === "gmail") {
        assert.deepEqual(reference.approvedParticipantRefs, ["person-fixture-alex"]);
        assert.equal(reference.stableLink, "https://fixture.example.test/mail/fixture-mail-001");
      } else {
        assert.deepEqual(reference.approvedParticipantRefs, []);
        assert.equal(reference.stableLink, null);
      }
    }

    const personNote = result.canonicalNotes.find((note) => note.subject.type === "people");
    assert.match(personNote.path, /^People\/person-fixture-alex\.md$/);
    assert.match(personNote.content, /Generated canonical claims/);
    assert.match(personNote.content, /Your notes/);
    assert.match(personNote.content, /user-owned and is never overwritten/);
    assert.match(personNote.content, /Fixture Alex owns the Atlas project/);
    assert.match(personNote.content, /claim-[a-f0-9]{20}/);
    assert.match(personNote.content, /Approved participant references: `person-fixture-alex`/);
    assert.match(personNote.content, /Stable link/);

    const gmailIndex = result.sourceIndexes.find((index) => index.source === "gmail");
    assert.match(gmailIndex.path, /^Sources\/gmail--fixture-gmail-account\.md$/);
    assert.match(gmailIndex.content, /Authoritative claims remain in the linked canonical notes/);
    assert.match(gmailIndex.content, /\[\[People\/person-fixture-alex\]\]/);
    assert.equal(gmailIndex.content.includes("Fixture Alex owns the Atlas project."), false, "source indexes navigate but do not duplicate claim authority");
    assert.equal(Object.hasOwn(gmailIndex.entries[0], "assertion"), false);
    assert.equal(gmailIndex.entries[0].sourceTimestamp, startedAt);
    assert.deepEqual(gmailIndex.entries[0].approvedParticipantRefs, ["person-fixture-alex"]);
    assert.equal(gmailIndex.entries[0].stableLink, "https://fixture.example.test/mail/fixture-mail-001");

    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    assert.equal(JSON.stringify(result).includes(directory), false, "public output never exposes a local staging path");

    const status = await getKnowledgeCompilationStatus({ stateStore, batchId: "fixture-full-batch" });
    assert.equal(status.compilation.status, "compiled");
    assert.equal(status.result.claimCount, 8);
  });
});

test("Spanish output renders unknown evidence explicitly instead of inventing a fact", async () => {
  await withCompilerFixture(async ({ stateStore, staging, gmail }) => {
    const result = await compileApprovedRecords({
      message: "Compila mis notas canónicas aprobadas",
      stateStore,
      staging,
      batchId: "fixture-spanish-unknown",
      approvedRecords: [approvedRecord(gmail, [
        assertion("knowledge", "knowledge-fixture-unknown", "Nota pendiente", null, "uncertain", ["private"])
      ], { verifiedAt: null, sourceLabel: null })],
      language: "es",
      clock: clockAt(laterToday)
    });

    assert.equal(result.claims[0].assertion, null);
    assert.equal(result.claims[0].confidence, "uncertain");
    assert.equal(result.claims[0].verifiedAt, null);
    assert.match(result.canonicalNotes[0].content, /Afirmaciones canónicas generadas/);
    assert.match(result.canonicalNotes[0].content, /Desconocido \(sin evidencia aprobada\)/);
    assert.match(result.canonicalNotes[0].content, /Tus notas/);
    assert.match(result.canonicalNotes[0].content, /Approved gmail reference/);
    assert.match(result.compilation.message, /notas canónicas/i);
  }, { language: "es" });
});

test("raw fields, slash commands, and records without an active granular grant fail before staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const safeRecord = approvedRecord(gmail, [
      assertion("knowledge", "knowledge-fixture-guard", "Guard", "The record is normalized.")
    ]);
    await assert.rejects(
      () => compileApprovedRecords({
        message: "/compile approved notes",
        stateStore,
        staging,
        batchId: "fixture-slash-command",
        approvedRecords: [safeRecord],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "NO_SLASH_COMMANDS"
    );
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile approved notes",
        stateStore,
        staging,
        batchId: "fixture-raw-field",
        approvedRecords: [{ ...safeRecord, body: "fixture raw body is blocked" }],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RAW_SOURCE_FIELD_BLOCKED"
    );
    const noGrantRecord = { ...safeRecord, grantId: "missing-grant" };
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile approved notes",
        stateStore,
        staging,
        batchId: "fixture-no-grant",
        approvedRecords: [noGrantRecord],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    const stagingRoot = path.join(directory, ".qwave-second-brain-staging");
    assert.deepEqual(await readdir(stagingRoot), [], "validation may create the protected root, but it never stages a batch");
  });
});

test("safe per-source provenance must exactly match the reviewed QWA-139 metadata before staging", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const base = approvedRecord(gmail, [
      assertion("knowledge", "knowledge-fixture-provenance", "Provenance", "Only reviewed provenance reaches a canonical note.")
    ]);
    const mismatches = [
      { batchId: "fixture-source-time-mismatch", record: { ...base, sourceTimestamp: laterToday } },
      { batchId: "fixture-participant-mismatch", record: { ...base, approvedParticipantRefs: ["person-fixture-other"] } },
      { batchId: "fixture-label-mismatch", record: { ...base, sourceLabel: "Different safe metadata label" } },
      { batchId: "fixture-link-mismatch", record: { ...base, stableLink: "https://fixture.example.test/mail/different-reference" } }
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(
        () => compileApprovedRecords({
          message: "Compile my approved notes",
          stateStore,
          staging,
          batchId: mismatch.batchId,
          approvedRecords: [mismatch.record],
          clock: clockAt(laterToday)
        }),
        (error) => error instanceof KnowledgeCompilationError && error.code === "SOURCE_PROVENANCE_INVALID"
      );
    }
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("temporary staging rejects repository roots and symlink escapes", async () => {
  await assert.rejects(
    async () => new LocalTemporaryStaging({ root: path.join(process.cwd(), ".qwave-second-brain-staging") }),
    (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_PUBLIC_REPOSITORY_BLOCKED"
  );
  await assert.rejects(
    async () => new LocalTemporaryStaging({ root: path.parse(process.cwd()).root }),
    (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_ROOT_TOO_BROAD"
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa146-security-"));
  try {
    const symlinkParent = path.join(directory, "symlink-parent");
    const symlinkRoot = path.join(symlinkParent, ".qwave-second-brain-staging");
    const target = path.join(directory, "target-directory");
    await mkdir(symlinkParent);
    await mkdir(target);
    await symlink(target, symlinkRoot);
    const linked = new LocalTemporaryStaging({ root: symlinkRoot });
    await assert.rejects(
      () => linked.stage({ batchId: "linked-batch", records: [inertStagingRecord()], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_SYMLINK_BLOCKED"
    );

    const safeRoot = path.join(directory, "safe-parent", ".qwave-second-brain-staging");
    await mkdir(path.dirname(safeRoot));
    const safeStaging = new LocalTemporaryStaging({ root: safeRoot });
    await safeStaging.initialize();
    await assert.rejects(
      () => safeStaging.stage({ batchId: "raw-shape-batch", records: [{ body: "blocked" }], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "RAW_SOURCE_FIELD_BLOCKED"
    );
    await assert.rejects(
      () => safeStaging.stage({ batchId: "missing-schema-batch", records: [{}], createdAt: startedAt }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "SOURCE_REFERENCE_INVALID"
    );
    await assert.rejects(
      () => safeStaging.stage({
        batchId: "missing-provenance-batch",
        records: [inertStagingRecord({ sourceTimestamp: undefined })],
        createdAt: startedAt
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "SOURCE_TIMESTAMP_REQUIRED"
    );
    const outside = path.join(directory, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    await symlink(outside, path.join(safeRoot, "batch-symlink-batch.json"));
    await assert.rejects(
      () => safeStaging.read({ batchId: "symlink-batch" }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_SYMLINK_BLOCKED"
    );

    await safeStaging.stage({ batchId: "tampered-expiry", records: [inertStagingRecord()], createdAt: startedAt });
    await writeFile(path.join(safeRoot, "batch-tampered-expiry.json"), JSON.stringify({
      version: 1,
      batchId: "tampered-expiry",
      createdAt: startedAt,
      expiresAt: "2030-01-01T00:00:00.000Z",
      records: [inertStagingRecord()]
    }), "utf8");
    const tamperCleanup = await safeStaging.cleanupExpired({ now: laterToday });
    assert.deepEqual(tamperCleanup.removedBatchIds, ["symlink-batch", "tampered-expiry"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a broadened persisted QWA-139 scope fails closed before any batch is staged", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const state = await stateStore.load();
    const entry = state.sourcePermissionLifecycle.entries[`gmail:${encodeURIComponent(gmail.accountId)}`];
    const activeGrant = entry.grants.find((grant) => grant.status === "active");
    activeGrant.scope.categories = ["planning", "unreviewed-category"];
    await stateStore.save(state);

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore,
        staging,
        batchId: "fixture-tampered-grant",
        approvedRecords: [approvedRecord(gmail, [
          assertion("knowledge", "knowledge-fixture-tampered", "Tampered grant", "A broadened grant is rejected before compilation.")
        ])],
        clock: clockAt(laterToday)
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "PERSISTED_GRANT_INVALID"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
  });
});

test("a transient staging interruption resumes the same protected batch and deletes it after success", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    const records = [approvedRecord(gmail, [
      assertion("projects", "project-fixture-resume", "Resume project", "The protected batch can resume after a temporary interruption.")
    ])];
    const interrupted = await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-resume-batch",
      approvedRecords: records,
      clock: clockAt(laterToday)
    });
    assert.equal(interrupted.compilation.status, "staged");
    assert.equal(interrupted.interruption.retryable, true);
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), ["batch-fixture-resume-batch.json"]);

    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-resume-batch",
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.status, "compiled");
    assert.equal(resumed.claims.length, 1);
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);

    const idempotent = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-resume-batch",
      clock: clockAt("2026-08-17T13:06:00.000Z")
    });
    assert.deepEqual(idempotent.claims, resumed.claims);
  });
});

test("a disk-staged batch reconciles after a private state-save interruption instead of reporting STAGING_BATCH_EXISTS", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStore = new FailNextSaveStateStore(stateStore);
    interruptedStore.failNextSave = true;
    const records = [approvedRecord(gmail, [
      assertion("projects", "project-fixture-state-retry", "State retry project", "The durable stage can reconcile after a private state interruption.")
    ])];

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore: interruptedStore,
        staging,
        batchId: "fixture-state-save-retry",
        approvedRecords: records,
        clock: clockAt(laterToday)
      }),
      /Simulated private state save interruption/
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), ["batch-fixture-state-save-retry.json"]);

    // Recreate the adapter to model a restart: recovery comes from the
    // bounded on-disk batch, not from the prior instance's memory.
    const restartedStaging = new LocalTemporaryStaging({ root: path.join(directory, ".qwave-second-brain-staging") });
    const resumed = await compileApprovedRecords({
      message: "Continue compiling my approved notes",
      stateStore: interruptedStore,
      staging: restartedStaging,
      batchId: "fixture-state-save-retry",
      clock: clockAt("2026-08-17T13:05:00.000Z")
    });
    assert.equal(resumed.compilation.status, "compiled");
    assert.equal(resumed.claims.length, 1);
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);

    const state = await stateStore.load();
    const entry = state.knowledgeCompilationLifecycle.batches["fixture-state-save-retry"];
    assert.equal(entry.audit.some((event) => event.type === "approved-normalized-records-reconciled-after-state-save-interruption"), true);
    assert.equal(entry.audit.some((event) => event.reason === "STAGING_BATCH_EXISTS"), false);
  });
});

test("an untracked disk stage is discarded if its QWA-139 grant is revoked before recovery", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStore = new FailNextSaveStateStore(stateStore);
    interruptedStore.failNextSave = true;
    const batchId = "fixture-untracked-revoked";
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Compile my approved notes",
        stateStore: interruptedStore,
        staging,
        batchId,
        approvedRecords: [approvedRecord(gmail, [
          assertion("decisions", "decision-fixture-untracked-revoked", "Untracked revoked", "A revoked grant cannot recover an untracked stage.")
        ])],
        clock: clockAt(laterToday)
      }),
      /Simulated private state save interruption/
    );
    await revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:01:00.000Z")
    });

    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore: interruptedStore,
        staging: new LocalTemporaryStaging({ root: path.join(directory, ".qwave-second-brain-staging") }),
        batchId,
        clock: clockAt("2026-08-17T13:02:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "discarded");
  });
});

test("a QWA-139 revocation between interruption and resume deletes staged references before compilation", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-revoked-resume",
      approvedRecords: [approvedRecord(gmail, [
        assertion("decisions", "decision-fixture-revoked", "Revoked decision", "The grant must still be active at resume time.")
      ])],
      clock: clockAt(laterToday)
    });
    await revokeSourcePermission({
      message: "Revoke this source permission",
      stateStore,
      connector: gmail.connector,
      source: gmail.source,
      accountId: gmail.accountId,
      reviewId: gmail.reviewId,
      clock: clockAt("2026-08-17T13:01:00.000Z")
    });
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging: interruptedStaging,
        batchId: "fixture-revoked-resume",
        clock: clockAt("2026-08-17T13:02:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "ACTIVE_GRANT_REQUIRED"
    );
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId: "fixture-revoked-resume" });
    assert.equal(status.compilation.status, "discarded");
    assert.equal(status.compilation.rawSourceBodiesRetained, false);
  });
});

test("the 24-hour cleanup deletes interrupted staging and makes resume fail closed", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId: "fixture-expiry-batch",
      approvedRecords: [approvedRecord(gmail, [
        assertion("meetings", "meeting-fixture-expiry", "Expiry meeting", "The temporary batch expires after one day.")
      ])],
      clock: clockAt(startedAt)
    });
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), ["batch-fixture-expiry-batch.json"]);

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: interruptedStaging,
      clock: clockAt("2026-08-18T12:00:00.000Z")
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, ["fixture-expiry-batch"]);
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);
    await assert.rejects(
      () => compileApprovedRecords({
        message: "Continue compiling my approved notes",
        stateStore,
        staging: interruptedStaging,
        batchId: "fixture-expiry-batch",
        clock: clockAt("2026-08-18T12:00:00.000Z")
      }),
      (error) => error instanceof KnowledgeCompilationError && error.code === "STAGING_EXPIRED"
    );
  });
});

test("a fresh staging adapter removes an expired durable batch on restart and leaves an expiry tombstone", async () => {
  await withCompilerFixture(async ({ directory, stateStore, staging, gmail }) => {
    const interruptedStaging = new FailOnceReadStaging(staging);
    const batchId = "fixture-restart-expiry";
    await compileApprovedRecords({
      message: "Compile my approved notes",
      stateStore,
      staging: interruptedStaging,
      batchId,
      approvedRecords: [approvedRecord(gmail, [
        assertion("meetings", "meeting-fixture-restart-expiry", "Restart expiry", "The durable staging expiry is checked after a restart.")
      ])],
      clock: clockAt(startedAt)
    });

    const stagedPath = path.join(directory, ".qwave-second-brain-staging", `batch-${batchId}.json`);
    const stale = JSON.parse(await readFile(stagedPath, "utf8"));
    stale.createdAt = "2020-01-01T00:00:00.000Z";
    stale.expiresAt = "2020-01-02T00:00:00.000Z";
    await writeFile(stagedPath, `${JSON.stringify(stale)}\n`, "utf8");

    const restartedStaging = new LocalTemporaryStaging({ root: path.join(directory, ".qwave-second-brain-staging") });
    await restartedStaging.initialize();
    assert.deepEqual(await readdir(path.join(directory, ".qwave-second-brain-staging")), []);

    const cleanup = await cleanupExpiredKnowledgeStaging({
      stateStore,
      staging: restartedStaging,
      clock: clockAt("2026-08-17T13:00:00.000Z")
    });
    assert.deepEqual(cleanup.cleanup.expiredBatchIds, [batchId]);
    const status = await getKnowledgeCompilationStatus({ stateStore, batchId });
    assert.equal(status.compilation.status, "expired");
    assert.equal(status.compilation.staging.status, "expired-deleted");
  });
});
