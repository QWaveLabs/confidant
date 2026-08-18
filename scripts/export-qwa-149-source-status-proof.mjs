/**
 * Emits a safe, customer-visible QWA-149 proof as JSON.
 *
 * It uses only synthetic opaque export ids and a temporary local state file.
 * It never opens a real source, reads a source body, or writes to a source.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedGenericExportAdapter,
  SimulatedObsidianAdapter,
  beginSimulatedExportPreview,
  buildSimulatedExportPermissionScope,
  getSourceStatusHandoff,
  grantSimulatedExportPermission,
  getGoogleDriveConnectionStatus,
  getIMessageBetaStatus,
  importSimulatedExportSnapshot,
  startSetupSession
} from "../src/index.mjs";

const clock = { now: () => new Date("2026-08-17T12:00:00.000Z") };
const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa149-proof-"));

try {
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  await startSetupSession({
    message: "Set up my second brain",
    answers: { displayName: "Demo", focus: "review safe source states" },
    decisions: { vaultName: "My Second Brain" },
    stateStore,
    clock,
    adapters: {
      environment: new SimulatedEnvironmentAdapter(),
      obsidian: new SimulatedObsidianAdapter(),
      vault: new SimulatedDesktopVaultAdapter()
    }
  });
  const adapter = new SimulatedGenericExportAdapter({
    exportId: "proof-export",
    items: [{ id: "proof-item-001", category: "planning" }]
  });
  const preview = await beginSimulatedExportPreview({
    message: "Preview a simulated export for my second brain",
    stateStore,
    adapter,
    clock,
    reviewIdFactory: () => "proof-review"
  });
  const scope = buildSimulatedExportPermissionScope({
    metadataPreview: preview.sourceStatus.metadataPreview,
    selectedItemIds: ["proof-item-001"]
  });
  scope.acknowledgements.metadataOnlyPreview = true;
  scope.acknowledgements.untrustedSourceMaterial = true;
  scope.acknowledgements.simulatedSnapshot = true;
  await grantSimulatedExportPermission({
    message: "I approve exactly this simulated export item",
    stateStore,
    adapter,
    reviewId: "proof-review",
    scope,
    clock,
    grantIdFactory: () => "proof-grant"
  });
  const imported = await importSimulatedExportSnapshot({
    message: "Import the approved simulated snapshot",
    stateStore,
    adapter,
    reviewId: "proof-review",
    clock
  });
  const rawFailureCodes = [
    "RAW_PROOF_DRIVE_METADATA_CODE",
    "RAW_PROOF_DRIVE_FETCH_CODE",
    "RAW_PROOF_DRIVE_REVOKED_CODE",
    "RAW_PROOF_IMESSAGE_METADATA_CODE",
    "RAW_PROOF_IMESSAGE_ROOT_CODE"
  ];
  const legacyState = await stateStore.load();
  legacyState.googleDriveLifecycle = {
    version: 1,
    entries: {
      "drive:proof-drive-attention": {
        source: "drive",
        accountId: "proof-drive-attention",
        status: "needs-attention",
        authorization: { status: "unavailable", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: ["proof-drive-folder"],
        reviewId: "proof-drive-review",
        normalizedMetadataById: {
          "proof-drive-record": {
            source: "drive",
            sourceRecordId: "proof-drive-record",
            folderId: "proof-drive-folder"
          }
        },
        audit: [{
          type: "drive-metadata-review-unavailable",
          accountId: "proof-drive-attention",
          reviewId: "proof-drive-review",
          grantId: "proof-drive-grant",
          sourceRecordId: "proof-drive-record",
          operationId: "proof-drive-metadata-operation",
          reason: rawFailureCodes[0],
          contentBodiesRead: false
        }, {
          type: "drive-approved-reference-fetch-interrupted",
          accountId: "proof-drive-attention",
          reviewId: "proof-drive-review",
          grantId: "proof-drive-grant",
          sourceRecordId: "proof-drive-record",
          operationId: "proof-drive-fetch-operation",
          reason: rawFailureCodes[1],
          contentBodiesRead: false
        }]
      },
      "drive:proof-drive-revoked": {
        source: "drive",
        accountId: "proof-drive-revoked",
        status: "revoked",
        authorization: { status: "revoked", readOnly: false, metadataOnly: false, attempts: 1 },
        authorizedFolderIds: [],
        reviewId: "proof-drive-revoked-review",
        normalizedMetadataById: {},
        audit: [{
          type: "drive-approved-reference-fetch-interrupted",
          accountId: "proof-drive-revoked",
          reviewId: "proof-drive-revoked-review",
          grantId: "proof-drive-revoked-grant",
          operationId: "proof-drive-revoked-operation",
          reason: rawFailureCodes[2],
          contentBodiesRead: false
        }]
      }
    },
    audit: []
  };
  legacyState.imessageBetaLifecycle = {
    version: 1,
    entries: {
      "imessage:proof-imessage-fallback": {
        source: "imessage",
        accountId: "proof-imessage-fallback",
        status: "snapshot-available",
        mode: "snapshot",
        connectionTruth: "beta",
        localAccess: { status: "unavailable", attempts: 1 },
        snapshot: { available: true, started: false, oneTime: true, live: false },
        contactAndGroupPrivacyApplied: false,
        sensitiveApprovals: {
          attachments: { approved: false, approvedAt: null },
          highRiskIdentifiers: { approved: false, approvedAt: null }
        },
        reviewId: "proof-imessage-review",
        audit: [{
          type: "imessage-metadata-review-unavailable",
          accountId: "proof-imessage-fallback",
          reviewId: "proof-imessage-review",
          grantId: "proof-imessage-grant",
          sourceRecordId: "proof-imessage-record",
          operationId: "proof-imessage-operation",
          reason: rawFailureCodes[3],
          contentBodiesRead: false
        }]
      }
    },
    audit: [{
      type: "imessage-snapshot-fallback-available",
      accountId: "proof-imessage-fallback",
      reason: rawFailureCodes[4]
    }]
  };
  await stateStore.save(legacyState);

  // Reopen the durable file, then ask for handoff first. No specialized
  // connector status call is allowed to pre-clean this proof fixture.
  const restartedStore = new FileStateStore(stateStore.filePath);
  let handoffMigrationSaveCalls = 0;
  const countingRestartedStore = {
    async load() {
      return restartedStore.load();
    },
    async save(nextState) {
      handoffMigrationSaveCalls += 1;
      return restartedStore.save(nextState);
    }
  };
  const handoff = await getSourceStatusHandoff({ stateStore: countingRestartedStore });
  assert.equal(handoffMigrationSaveCalls, 1);
  const persisted = await restartedStore.load();
  const driveAttention = persisted.googleDriveLifecycle.entries["drive:proof-drive-attention"];
  const driveRevoked = persisted.googleDriveLifecycle.entries["drive:proof-drive-revoked"];
  const imessage = persisted.imessageBetaLifecycle.entries["imessage:proof-imessage-fallback"];
  const accountAlias = (entry) => entry.publicIdentifierAliases.mappings
    .find((mapping) => mapping.kind === "account" && mapping.raw === entry.accountId).alias;
  const driveAttentionAlias = accountAlias(driveAttention);
  const driveRevokedAlias = accountAlias(driveRevoked);
  const imessageAlias = accountAlias(imessage);
  const driveAttentionStatus = await getGoogleDriveConnectionStatus({
    stateStore: restartedStore,
    accountId: driveAttentionAlias
  });
  const driveRevokedStatus = await getGoogleDriveConnectionStatus({
    stateStore: restartedStore,
    accountId: driveRevokedAlias
  });
  const imessageStatus = await getIMessageBetaStatus({
    stateStore: restartedStore,
    accountId: imessageAlias
  });
  const publicEvidence = JSON.stringify({
    handoff,
    driveAttentionStatus,
    driveRevokedStatus,
    imessageStatus
  });
  const persistedRoot = JSON.stringify(persisted);
  for (const rawFailureCode of rawFailureCodes) {
    assert.equal(persistedRoot.includes(rawFailureCode), false);
    assert.equal(publicEvidence.includes(rawFailureCode), false);
  }
  assert.deepEqual(
    driveAttention.audit.map((event) => event.reason),
    ["DRIVE_METADATA_REVIEW_FAILED", "DRIVE_APPROVED_FETCH_FAILED"]
  );
  assert.equal(driveRevoked.audit[0].reason, "DRIVE_APPROVED_FETCH_AUTHORIZATION_REVOKED");
  assert.equal(imessage.audit[0].reason, "IMESSAGE_METADATA_REVIEW_FAILED");
  assert.equal(persisted.imessageBetaLifecycle.audit[0].reason, "IMESSAGE_METADATA_REVIEW_FAILED");
  assert.notEqual(driveAttentionAlias, driveRevokedAlias);

  console.log(JSON.stringify({
    proof: "QWA-149 simulated source-status export",
    source: imported.sourceStatus.source,
    state: imported.sourceStatus.state,
    connection: imported.sourceStatus.connection,
    metadataPreview: imported.sourceStatus.metadataPreview,
    granularPermission: imported.sourceStatus.granularPermission,
    snapshotImport: imported.sourceStatus.snapshotImport,
    legacyFailureMigration: {
      processRestartedBeforeHandoff: true,
      handoffMigrationSaveCalls,
      aliasesMigratedWithoutCollision: true,
      rootIMessageAuditNormalized: true,
      fixedFailureReasons: {
        drive: [
          "DRIVE_METADATA_REVIEW_FAILED",
          "DRIVE_APPROVED_FETCH_FAILED",
          "DRIVE_APPROVED_FETCH_AUTHORIZATION_REVOKED"
        ],
        imessage: ["IMESSAGE_METADATA_REVIEW_FAILED"]
      },
      rawAdapterFailureCodesPersisted: false,
      rawAdapterFailureCodesProjected: false
    },
    releaseGate: handoff.sourceStatusHandoff.releaseGate,
    adapterCounters: {
      metadataPreviewCalls: adapter.metadataPreviewCalls,
      snapshotImportCalls: adapter.snapshotImportCalls,
      bodyReads: adapter.bodyReads,
      writeCalls: adapter.writeCalls
    }
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
