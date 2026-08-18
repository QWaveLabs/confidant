/**
 * Emits a safe, customer-visible QWA-149 proof as JSON.
 *
 * It uses only synthetic opaque export ids and a temporary local state file.
 * It never opens a real source, reads a source body, or writes to a source.
 */

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
  const handoff = await getSourceStatusHandoff({ stateStore });

  console.log(JSON.stringify({
    proof: "QWA-149 simulated source-status export",
    source: imported.sourceStatus.source,
    state: imported.sourceStatus.state,
    connection: imported.sourceStatus.connection,
    metadataPreview: imported.sourceStatus.metadataPreview,
    granularPermission: imported.sourceStatus.granularPermission,
    snapshotImport: imported.sourceStatus.snapshotImport,
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
