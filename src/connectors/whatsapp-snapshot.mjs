/**
 * QWA-147 personal WhatsApp snapshot lifecycle.
 *
 * Personal accounts use a bounded, private, local snapshot bundle. Official
 * Business access remains unsupported and non-live until a shared host-owned
 * provider is registered outside this public API.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  beginSpecializedWhatsAppPermissionReview,
  denySpecializedWhatsAppPermission,
  fetchSpecializedWhatsAppContent,
  getSpecializedWhatsAppPermissionStatus,
  grantSpecializedWhatsAppPermission,
  revokeSpecializedWhatsAppPermission,
  withSourcePermissionStateLock
} from "../permissions/setup-source-permissions.mjs";
import {
  DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF,
  LocalWhatsAppSnapshotConnector,
  WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
  WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL
} from "./local-whatsapp-snapshot-connector.mjs";

const STATE_KEY = "whatsAppSnapshotLifecycle";
const SOURCE = "whatsapp";
const SOURCE_PERMISSION_KEY_PREFIX = `${SOURCE}:`;
const MAX_CAPTURE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_OFFICIAL_BUSINESS_ACCOUNT_REF = "wa-account-business-1";
export const OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL = "qwave.shared-connector-verification/v1";

export class WhatsAppSnapshotError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "WhatsAppSnapshotError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function clone(value) {
  return structuredClone(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new TypeError("clock.now() must return a valid date.");
  return result;
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new WhatsAppSnapshotError("WHATSAPP_MESSAGE_REQUIRED", "Tell me in normal language what you want to do with the WhatsApp snapshot.");
  }
  if (message.trim().startsWith("/")) {
    throw new WhatsAppSnapshotError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do in normal language.");
  }
}

function strictTimestamp(value, { now, field = "snapshot timestamp", futureSkewMs = 0 } = {}) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new WhatsAppSnapshotError("SNAPSHOT_TIMESTAMP_INVALID", `The ${field} must be an exact UTC timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new WhatsAppSnapshotError("SNAPSHOT_TIMESTAMP_INVALID", `The ${field} is invalid.`);
  }
  if (now && parsed > Date.parse(now) + futureSkewMs) {
    throw new WhatsAppSnapshotError("SNAPSHOT_TIMESTAMP_IN_FUTURE", `The ${field} is later than the allowed clock-skew boundary.`);
  }
  return value;
}

function assertOpaqueRef(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new WhatsAppSnapshotError("WHATSAPP_REFERENCE_INVALID", `The ${field} reference is missing or malformed.`);
  }
  return value;
}

function assertLocalAccountRef(value) {
  if (typeof value !== "string" || !/^wa-account-[a-z0-9._:-]{1,128}$/.test(value)) {
    throw new WhatsAppSnapshotError("WHATSAPP_ACCOUNT_ALIAS_REQUIRED", "Use a local wa-account-* alias for this snapshot, never a WhatsApp source account identifier.");
  }
  return value;
}

function guardedIdentifierFactory({ factory, prefix, seen, field }) {
  return () => {
    const value = factory ? factory() : `${prefix}-${randomUUID()}`;
    assertOpaqueRef(value, field);
    if (seen.has(value)) {
      throw new WhatsAppSnapshotError("WHATSAPP_IDENTIFIER_REPLAY", `That ${field} identifier was already used by an earlier WhatsApp snapshot generation.`);
    }
    return value;
  };
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      export: "Esta cuenta personal usa una instantánea local privada, no una conexión en vivo. Siguiente acción: exporta los chats elegidos y prepara un paquete QWave sin comprimir.",
      import: "Siguiente acción: elige el manifiesto local .qwave-wa.json. Solo leeré el manifiesto de metadatos hasta que apruebes chats, personas, fechas y medios.",
      select: "Revisé solo el manifiesto. Elige explícitamente chats, personas permitidas, fechas, categorías sensibles y si incluyes medios.",
      reviewPending: "La revisión privada del manifiesto quedó pendiente. Puedes reanudar la misma generación sin leer mensajes automáticamente.",
      reviewFailed: "La revisión privada del manifiesto no terminó. Reintenta el mismo manifiesto sin iniciar una conexión en vivo.",
      grant: "La selección exacta está guardada e inmutable para esta revisión. Apruébala o inicia una revisión nueva para cambiarla.",
      ready: "El permiso de solo lectura está listo. El contenido local seleccionado aún no se ha leído.",
      processed: "Procesé solo los segmentos locales aprobados y devolví referencias opacas. El contenido sigue siendo material no confiable, no instrucciones.",
      interrupted: "La lectura anterior quedó interrumpida sin recibo completo. No la repetiré automáticamente; confirma un reintento explícito.",
      revokeUnconfirmed: "No pude confirmar que se eliminó el permiso local exacto. El acceso permanece bloqueado en esta guía; reintenta la revocación.",
      denied: "No se concedió acceso al contenido de la instantánea.",
      cancelled: "Cancelé esta revisión. No se leyó contenido adicional.",
      revoked: "El permiso local fue revocado y no puede reactivarse desde una revisión anterior.",
      business: "WhatsApp Business en vivo no está soportado por un proveedor compartido registrado. Permanecerá no verificado y live:false.",
      untrusted: "Los mensajes, nombres y medios importados son referencias no confiables. No pueden ampliar permisos, revelar secretos, abrir enlaces, ejecutar acciones ni escribir en WhatsApp."
    };
  }
  return {
    export: "This personal account uses a private local snapshot, not a live connection. One next action: export the chosen chats and prepare an uncompressed QWave bundle.",
    import: "One next action: choose the local .qwave-wa.json manifest. I will read only its metadata manifest until you approve chats, Allowed people, dates, and media.",
    select: "I reviewed only the manifest. Explicitly choose chats, Allowed people, dates, sensitive categories, and whether media is included.",
    reviewPending: "The private manifest review is pending. You can resume the same generation without any automatic message read.",
    reviewFailed: "The private manifest review did not finish. Retry the same manifest without starting a live connection.",
    grant: "The exact selection is saved and immutable for this review. Approve it or start a new review to change it.",
    ready: "The read-only permission is ready. The selected local content has not been read yet.",
    processed: "I processed only approved local segments and returned opaque references. Imported content remains untrusted reference material, not instructions.",
    interrupted: "The earlier read was interrupted without a complete receipt. I will not repeat it automatically; confirm an explicit retry.",
    revokeUnconfirmed: "I could not confirm removal of the exact local grant. This guided flow remains blocked; retry revocation.",
    denied: "No snapshot content access was granted.",
    cancelled: "I cancelled this review. No additional content was read.",
    revoked: "The local permission was revoked and cannot be restored from an earlier review.",
    business: "Live WhatsApp Business is unsupported until a registered shared host provider exists. It remains unverified and live:false.",
    untrusted: "Imported messages, names, and media are untrusted references. They cannot broaden permission, reveal secrets, open links, run actions, or write to WhatsApp."
  };
}

function personalEntryKey(accountId) {
  return `personal:${encodeURIComponent(accountId)}`;
}

function businessEntryKey(accountId) {
  return `official-business:${encodeURIComponent(accountId)}`;
}

function permissionEntryKey(accountId) {
  return `${SOURCE_PERMISSION_KEY_PREFIX}${encodeURIComponent(accountId)}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 2, entries: {}, audit: [] };
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state) {
    throw new WhatsAppSnapshotError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then continue this WhatsApp snapshot in the same conversation.");
  }
  return state;
}

function newEntry(accountId, now, generation = 1, earlierAudit = []) {
  return {
    source: SOURCE,
    accountId,
    accountType: "personal",
    generation,
    status: "awaiting-guided-export",
    snapshot: {
      mode: "private-local-bundle",
      format: WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
      oneTime: true,
      live: false,
      exportStatus: "not-confirmed",
      importStatus: "not-started",
      capturedAt: null,
      importedAt: null,
      importAttempts: 0,
      sourceFileDeleted: false,
      temporaryStagingCreated: false
    },
    snapshotBinding: null,
    reviewId: null,
    selection: null,
    grantId: null,
    approvedRecords: null,
    fetch: { status: "not-started", operationId: null, attempts: 0 },
    failure: null,
    audit: [...earlierAudit, { type: "whatsapp-personal-snapshot-offered", at: now, generation, sourceAccessed: false }]
  };
}

function assertEntry(state, accountId) {
  const entry = lifecycle(state).entries[personalEntryKey(accountId)];
  if (!entry) throw new WhatsAppSnapshotError("WHATSAPP_SNAPSHOT_NOT_STARTED", "Start a personal WhatsApp snapshot review first.");
  return entry;
}

function assertGeneration(entry, generation) {
  if (!Number.isSafeInteger(generation) || generation !== entry.generation) {
    throw new WhatsAppSnapshotError("STALE_WHATSAPP_GENERATION", "That WhatsApp snapshot action belongs to an older or unknown review generation, so I did not change access.");
  }
}

function assertConnector(connector) {
  if (!(connector instanceof LocalWhatsAppSnapshotConnector)) {
    throw new WhatsAppSnapshotError("WHATSAPP_CONNECTOR_NOT_REGISTERED", "Only the registered private local WhatsApp snapshot connector can be used for this flow.");
  }
}

function safeFailure(error, fallback, at) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : fallback;
  return { code, at };
}

function publicSelection(selection) {
  if (!selection) {
    return {
      complete: false,
      chatRefs: [],
      personRefs: [],
      dateRange: null,
      media: { selectionMade: false, included: false },
      sensitiveCategories: []
    };
  }
  return {
    complete: true,
    chatRefs: [...selection.chatRefs],
    personRefs: [...selection.personRefs],
    dateRange: { from: selection.from, to: selection.to },
    media: { selectionMade: true, included: selection.includeMedia },
    sensitiveCategories: [...selection.sensitiveCategories]
  };
}

function publicView(entry, language, permissionReview = null) {
  const wording = copy(language);
  const message = {
    "awaiting-guided-export": wording.export,
    "awaiting-snapshot-import": wording.import,
    "snapshot-review-pending": wording.reviewPending,
    "snapshot-review-failed": wording.reviewFailed,
    "awaiting-selection": wording.select,
    "awaiting-content-grant": wording.grant,
    "ready-to-process": wording.ready,
    "fetch-interrupted": wording.interrupted,
    "revoke-unconfirmed": wording.revokeUnconfirmed,
    processed: wording.processed,
    denied: wording.denied,
    cancelled: wording.cancelled,
    revoked: wording.revoked
  }[entry.status] ?? wording.import;
  const nextAction = {
    "awaiting-guided-export": "prepare-private-uncompressed-export-bundle",
    "awaiting-snapshot-import": "approve-local-manifest-preflight",
    "snapshot-review-pending": "resume-local-manifest-preflight",
    "snapshot-review-failed": "retry-local-manifest-preflight",
    "awaiting-selection": "choose-chats-allowed-people-dates-sensitivity-and-media",
    "awaiting-content-grant": "approve-exact-immutable-selection",
    "ready-to-process": "process-approved-local-segments",
    "fetch-interrupted": "confirm-explicit-fetch-retry",
    "revoke-unconfirmed": "retry-local-revocation",
    denied: "start-new-snapshot-review",
    cancelled: "start-new-snapshot-review",
    revoked: "start-new-snapshot-review"
  }[entry.status] ?? null;
  return {
    source: SOURCE,
    accountType: "personal",
    accountRef: entry.accountId,
    generation: entry.generation,
    status: entry.status,
    message,
    nextAction,
    connection: {
      mode: "guided-private-local-snapshot",
      live: false,
      simulated: false,
      readOnly: true,
      oneActionAtATime: true,
      canOpenWhatsApp: false,
      canExportFromWhatsApp: false,
      canSendMessages: false,
      canAlterMessages: false,
      canMutateSource: false,
      canFollowImportedInstructions: false
    },
    snapshot: clone(entry.snapshot),
    binding: entry.snapshotBinding ? {
      protocol: entry.snapshotBinding.protocol,
      format: entry.snapshotBinding.format,
      snapshotRef: entry.snapshotBinding.snapshotId,
      capturedAt: entry.snapshotBinding.capturedAt,
      generationBound: true,
      digestBound: true
    } : null,
    selection: publicSelection(entry.selection),
    approvedRecords: entry.approvedRecords ? clone(entry.approvedRecords) : null,
    cleanup: {
      sourceFileDeleted: false,
      temporaryStagingCreated: false,
      byteBuffersZeroedAfterEachRead: true,
      rawBodiesPersisted: false,
      garbageCollectionTimingClaimed: false,
      processExitDeletesCustomerExport: false,
      customerRetainsExportUntilTheyDeleteIt: true
    },
    untrustedSourceMaterial: wording.untrusted,
    failure: entry.failure ? clone(entry.failure) : null,
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
  };
}

function publicBusinessView(entry, language) {
  return {
    source: SOURCE,
    accountType: "official-business",
    status: "unsupported",
    message: copy(language).business,
    connection: {
      mode: "official-business-provider-unavailable",
      live: false,
      verified: false,
      simulated: false,
      readOnly: true,
      sourceAccessStarted: false,
      contentPermissionGranted: false,
      canSendMessages: false,
      canAlterMessages: false
    },
    verification: {
      protocol: OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL,
      hostProviderRegistered: false,
      callerSuppliedAttestationsAccepted: false,
      lastVerifiedAt: null
    },
    audit: clone(entry?.audit ?? [])
  };
}

async function currentPermission(stateStore, accountId, language) {
  return getSpecializedWhatsAppPermissionStatus({ stateStore, source: SOURCE, accountId, language });
}

function sourcePermissionEntry(state, accountId) {
  return state.sourcePermissionLifecycle?.entries?.[permissionEntryKey(accountId)] ?? null;
}

async function ensureConnectorBinding(connector, entry) {
  assertConnector(connector);
  await connector.discoverMetadata({ source: SOURCE });
  const binding = connector.getSnapshotBinding();
  if (binding.accountRef !== entry.accountId || (entry.snapshotBinding && JSON.stringify(binding) !== JSON.stringify(entry.snapshotBinding))) {
    throw new WhatsAppSnapshotError("SNAPSHOT_CONNECTOR_SUBSTITUTION", "The local connector does not match this immutable snapshot generation.");
  }
  if (binding.capturedAt !== entry.snapshot.capturedAt) {
    throw new WhatsAppSnapshotError("SNAPSHOT_CAPTURE_BINDING_MISMATCH", "The manifest capture time does not match the customer-confirmed export time.");
  }
  return binding;
}

function permissionProxy(connector, entry) {
  const selection = clone(entry.selection);
  const snapshotBinding = clone(entry.snapshotBinding);
  return {
    discoverMetadata: (request) => connector.discoverMetadata(request),
    registerPermissionGrant: async ({ grant }) => {
      const result = await connector.registerPermissionGrant({ grant, snapshotBinding, selection });
      const readback = await connector.readPermissionGrantStatus({ grantId: grant.id, snapshotBinding });
      if (readback?.grantId !== grant.id || readback.active !== true || readback.revoked !== false) {
        throw new WhatsAppSnapshotError("WHATSAPP_GRANT_ACTIVATION_UNCONFIRMED", "The exact local WhatsApp grant was not confirmed active, so content access remains denied.");
      }
      return result;
    },
    revokePermissionGrant: async ({ grantId }) => {
      const result = await connector.revokePermissionGrant({ grantId, snapshotBinding });
      const readback = await connector.readPermissionGrantStatus({ grantId, snapshotBinding });
      if (readback?.grantId !== grantId || readback.active !== false || readback.revoked !== true) {
        throw new WhatsAppSnapshotError("WHATSAPP_REVOCATION_UNCONFIRMED", "The exact local WhatsApp grant still appears active, so I did not confirm revocation.");
      }
      return result;
    },
    fetchApprovedContent: ({ source, accountId, grant }) => connector.fetchApprovedContent({ source, accountId, grant, snapshotBinding, selection })
  };
}

function metadataMatchesPermissionReview(metadata, permissionReview) {
  const reviewedPeople = permissionReview?.metadataPreflight?.people;
  const reviewedItems = permissionReview?.metadataPreflight?.reviewedItems;
  if (!Array.isArray(reviewedPeople) || !Array.isArray(reviewedItems) || metadata?.account?.id !== permissionReview?.account?.id) return false;
  const people = metadata.people.map((person) => ({ id: person.id, accessLevel: person.accessLevel })).sort((a, b) => a.id.localeCompare(b.id));
  const expectedPeople = reviewedPeople.map((person) => ({ id: person.id, accessLevel: person.accessLevel })).sort((a, b) => a.id.localeCompare(b.id));
  const items = metadata.items.map((item) => ({
    id: item.id,
    category: item.category,
    isGroup: item.isGroup === true,
    participantIds: [...item.participantIds].sort(),
    sensitiveCategories: [...item.sensitiveCategories].sort()
  })).sort((a, b) => a.id.localeCompare(b.id));
  const expectedItems = reviewedItems.map((item) => ({
    id: item.id,
    category: item.category,
    isGroup: item.isGroup === true,
    participantIds: [...item.participantIds].sort(),
    sensitiveCategories: [...item.sensitiveCategories].sort()
  })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(people) === JSON.stringify(expectedPeople) && JSON.stringify(items) === JSON.stringify(expectedItems);
}

function reconcileEntryFromPermissionState(state, entry, now) {
  const permission = sourcePermissionEntry(state, entry.accountId);
  if (!permission || permission.review?.id !== entry.reviewId) return false;
  const active = permission.grants?.find((grant) => grant.status === "active") ?? null;
  const revoked = permission.grants?.find((grant) => grant.status === "revoked"
    && grant.reviewId === entry.reviewId && grant.id === entry.grantId) ?? null;
  let changed = false;
  if (revoked && entry.status !== "revoked") {
    entry.status = "revoked";
    entry.grantId = revoked.id;
    if (entry.fetch.status === "pending") entry.fetch.status = "revoked";
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-reconciled-revocation", at: now, reviewId: entry.reviewId });
    changed = true;
  } else if (permission.status === "denied" && !["denied", "cancelled"].includes(entry.status)) {
    entry.status = "denied";
    if (entry.fetch.status === "pending") entry.fetch.status = "denied";
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-reconciled-denial", at: now, reviewId: entry.reviewId });
    changed = true;
  } else if (active && entry.selection && ["awaiting-content-grant", "awaiting-selection"].includes(entry.status)) {
    entry.status = "ready-to-process";
    entry.grantId = active.id;
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-reconciled-grant", at: now, reviewId: entry.reviewId });
    changed = true;
  }
  const receipt = permission.lastApprovedFetch;
  if (receipt?.reviewId === entry.reviewId && receipt?.grantId === (entry.grantId ?? active?.id)
    && Array.isArray(receipt.records) && entry.status !== "revoked") {
    entry.status = "processed";
    entry.grantId = receipt.grantId;
    entry.approvedRecords = clone(receipt.records);
    entry.fetch = { ...entry.fetch, status: "completed", completedAt: receipt.completedAt };
    entry.failure = null;
    if (!entry.audit.some((event) => event.type === "whatsapp-fetch-receipt-reconciled" && event.operationId === entry.fetch.operationId)) {
      entry.audit.push({ type: "whatsapp-fetch-receipt-reconciled", at: now, operationId: entry.fetch.operationId, recordCount: receipt.records.length });
    }
    changed = true;
  } else if (entry.fetch.status === "pending" && !["processed", "revoked", "denied", "cancelled"].includes(entry.status)) {
    entry.status = "fetch-interrupted";
    entry.fetch.status = "interrupted";
    entry.failure = { stage: "approved-content-read", code: "SNAPSHOT_FETCH_OUTCOME_UNCONFIRMED", at: now };
    entry.audit.push({ type: "whatsapp-fetch-interrupted", at: now, operationId: entry.fetch.operationId, automaticRetry: false });
    changed = true;
  }
  return changed;
}

async function beginPersonalUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, language, clock }) {
  assertNaturalLanguage(message);
  assertLocalAccountRef(accountId);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = personalEntryKey(accountId);
  if (!records.entries[key]) {
    const now = isoNow(clock);
    records.entries[key] = newEntry(accountId, now);
    records.audit.push({ type: "whatsapp-personal-snapshot-offered", at: now, accountRef: accountId, generation: 1, sourceAccessed: false });
    await stateStore.save(state);
  }
  return { whatsAppSnapshot: publicView(records.entries[key], languageFor(state, language)) };
}

export async function beginWhatsAppPersonalSnapshot(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => beginPersonalUnlocked(args));
}

async function confirmExportUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, exportCompleted = false, snapshotCapturedAt, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.status !== "awaiting-guided-export") return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
  if (exportCompleted !== true) return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
  const now = isoNow(clock);
  const capturedAt = strictTimestamp(snapshotCapturedAt, { now, field: "snapshot capture time", futureSkewMs: MAX_CAPTURE_FUTURE_SKEW_MS });
  entry.status = "awaiting-snapshot-import";
  entry.snapshot.exportStatus = "customer-confirmed";
  entry.snapshot.capturedAt = capturedAt;
  entry.audit.push({ type: "whatsapp-export-confirmed", at: now, capturedAt, generation: entry.generation, sourceAccessed: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
}

export async function confirmWhatsAppPersonalExport(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => confirmExportUnlocked(args));
}

async function beginImportUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, snapshotImportApproved = false, language, clock, reviewIdFactory }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (snapshotImportApproved !== true) return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
  if (["awaiting-selection", "awaiting-content-grant", "ready-to-process", "processed"].includes(entry.status)) {
    const permission = await currentPermission(stateStore, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview) };
  }
  if (!["awaiting-snapshot-import", "snapshot-review-failed", "snapshot-review-pending"].includes(entry.status)) {
    throw new WhatsAppSnapshotError("GUIDED_EXPORT_REQUIRED", "Confirm the private export before starting its local metadata preflight.");
  }
  assertConnector(connector);
  const now = isoNow(clock);
  entry.status = "snapshot-review-pending";
  entry.snapshot.importStatus = "metadata-preflight-pending";
  entry.snapshot.importAttempts += 1;
  entry.audit.push({ type: "whatsapp-local-preflight-approved", at: now, attempt: entry.snapshot.importAttempts, messageBodiesRead: false, mediaBodiesRead: false });
  // This durable save happens before discoverMetadata, so a failed save cannot
  // cause even manifest metadata to be opened.
  await stateStore.save(state);

  let recoverableReviewId = null;
  let recoverableBinding = null;
  try {
    const discoveredMetadata = await connector.discoverMetadata({ source: SOURCE });
    const existing = await currentPermission(stateStore, accountId, language);
    let review = entry.reviewId && existing?.permissionReview?.status === "awaiting-grant"
      && existing.permissionReview.permissionRequest.reviewId === entry.reviewId
      ? existing
      : null;
    if (!review) {
      const currentRoot = await loadState(stateStore);
      const currentPermissionEntry = sourcePermissionEntry(currentRoot, accountId);
      const seenReviewIds = new Set([
        ...entry.audit.map((event) => event.reviewId).filter(Boolean),
        ...(currentPermissionEntry?.audit ?? []).map((event) => event.reviewId).filter(Boolean)
      ]);
      review = await beginSpecializedWhatsAppPermissionReview({
        message: languageFor(state, language) === "es" ? "Quiero revisar la instantánea para mi segundo cerebro" : "I want to review the snapshot for my second brain",
        stateStore,
        connector,
        source: SOURCE,
        language,
        clock,
        reviewIdFactory: guardedIdentifierFactory({ factory: reviewIdFactory, prefix: "wa-review", seen: seenReviewIds, field: "review" })
      });
    } else {
      // discoverMetadata above recreated the private alias map after process
      // restart without reading any selected message or media body.
    }
    if (review.permissionReview.account.id !== accountId || review.permissionReview.status !== "awaiting-grant") {
      throw new WhatsAppSnapshotError("WHATSAPP_PERMISSION_REVIEW_MISMATCH", "The saved permission review does not match this snapshot account.");
    }
    if (!metadataMatchesPermissionReview(discoveredMetadata, review.permissionReview)) {
      throw new WhatsAppSnapshotError("SNAPSHOT_PERMISSION_METADATA_MISMATCH", "An existing permission review does not match this immutable local snapshot manifest.");
    }
    const binding = connector.getSnapshotBinding();
    if (binding.accountRef !== accountId || binding.capturedAt !== entry.snapshot.capturedAt) {
      throw new WhatsAppSnapshotError("SNAPSHOT_CAPTURE_BINDING_MISMATCH", "The immutable manifest does not match the confirmed account and capture time.");
    }
    recoverableReviewId = review.permissionReview.permissionRequest.reviewId;
    recoverableBinding = clone(binding);
    const refreshed = await loadState(stateStore);
    const refreshedEntry = assertEntry(refreshed, accountId);
    if (refreshedEntry.generation !== entry.generation) throw new WhatsAppSnapshotError("STALE_WHATSAPP_GENERATION", "A newer WhatsApp snapshot review replaced this one.");
    if (refreshedEntry.snapshotBinding && JSON.stringify(refreshedEntry.snapshotBinding) !== JSON.stringify(binding)) {
      throw new WhatsAppSnapshotError("SNAPSHOT_REPLAY_REJECTED", "A different snapshot cannot replace an in-progress immutable review.");
    }
    refreshedEntry.snapshotBinding = clone(binding);
    refreshedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
    refreshedEntry.status = "awaiting-selection";
    refreshedEntry.snapshot.importStatus = "metadata-reviewed";
    refreshedEntry.snapshot.importedAt = now;
    refreshedEntry.failure = null;
    refreshedEntry.audit.push({ type: "whatsapp-manifest-metadata-reviewed", at: now, reviewId: refreshedEntry.reviewId, generation: refreshedEntry.generation, messageBodiesRead: false, mediaBodiesRead: false });
    await stateStore.save(refreshed);
    return { whatsAppSnapshot: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview) };
  } catch (error) {
    const fallback = await loadState(stateStore);
    const fallbackEntry = assertEntry(fallback, accountId);
    assertGeneration(fallbackEntry, generation);
    const permissionEntry = sourcePermissionEntry(fallback, accountId);
    if (recoverableReviewId && recoverableBinding
      && permissionEntry?.status === "awaiting-grant"
      && permissionEntry.review?.id === recoverableReviewId) {
      fallbackEntry.reviewId = recoverableReviewId;
      fallbackEntry.snapshotBinding = clone(recoverableBinding);
      fallbackEntry.audit.push({ type: "whatsapp-pending-review-bound", at: isoNow(clock), reviewId: recoverableReviewId, generation, contentBodiesRead: false });
    }
    fallbackEntry.status = "snapshot-review-failed";
    fallbackEntry.snapshot.importStatus = "metadata-review-failed";
    fallbackEntry.failure = { stage: "metadata-preflight", ...safeFailure(error, "SNAPSHOT_METADATA_REVIEW_FAILED", isoNow(clock)) };
    fallbackEntry.audit.push({ type: "whatsapp-manifest-review-failed", at: fallbackEntry.failure.at, code: fallbackEntry.failure.code, messageBodiesRead: false, mediaBodiesRead: false });
    await stateStore.save(fallback);
    return { whatsAppSnapshot: publicView(fallbackEntry, languageFor(fallback, language)), metadataReviewUnavailable: true };
  }
}

export async function beginWhatsAppSnapshotImport(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => beginImportUnlocked(args));
}

async function selectScopeUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, chatRefs, personRefs, from, to, includeMedia, sensitiveCategories, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.status !== "awaiting-selection" || entry.reviewId !== reviewId) {
    throw new WhatsAppSnapshotError("WHATSAPP_SELECTION_NOT_READY", "Complete the current manifest review before selecting snapshot content.");
  }
  await ensureConnectorBinding(connector, entry);
  const selection = connector.validateSelection({ chatRefs, personRefs, from, to, includeMedia, sensitiveCategories });
  const permission = await currentPermission(stateStore, accountId, language);
  const requested = permission?.permissionReview?.permissionRequest?.requestedScope;
  if (!requested || Date.parse(selection.from) < Date.parse(requested.dateRange.from) || Date.parse(selection.to) > Date.parse(requested.dateRange.to)) {
    throw new WhatsAppSnapshotError("WHATSAPP_DATE_SCOPE_EXPANSION", "The selected dates must stay within this metadata review's visible communication window.");
  }
  entry.selection = clone(selection);
  entry.status = "awaiting-content-grant";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-explicit-scope-selected", at: isoNow(clock), reviewId, chatCount: selection.chatRefs.length, personCount: selection.personRefs.length, mediaIncluded: selection.includeMedia });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission.permissionReview) };
}

export async function selectWhatsAppSnapshotScope(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => selectScopeUnlocked(args));
}

/** Compatibility boundary: a media-only choice is intentionally insufficient. */
export async function selectWhatsAppSnapshotMedia({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, includeMedia, language }) {
  assertNaturalLanguage(message);
  if (typeof includeMedia !== "boolean") throw new WhatsAppSnapshotError("MEDIA_SELECTION_REQUIRED", "Choose explicitly whether media is included.");
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    if (entry.reviewId !== reviewId || entry.status !== "awaiting-selection") throw new WhatsAppSnapshotError("WHATSAPP_SELECTION_NOT_READY", "Complete the current manifest review first.");
    return {
      whatsAppSnapshot: publicView(entry, languageFor(state, language)),
      mediaChoiceRecorded: false,
      explicitScopeRequired: true
    };
  });
}

function dateExclusions(requestedRange, selection) {
  const exclusions = [];
  if (Date.parse(selection.from) > Date.parse(requestedRange.from)) {
    exclusions.push({ from: requestedRange.from, to: new Date(Date.parse(selection.from) - 1).toISOString() });
  }
  if (Date.parse(selection.to) < Date.parse(requestedRange.to)) {
    exclusions.push({ from: new Date(Date.parse(selection.to) + 1).toISOString(), to: requestedRange.to });
  }
  return exclusions;
}

function scopeForSelection(permissionReview, selection) {
  const requested = clone(permissionReview.permissionRequest.requestedScope);
  const allPeople = [
    ...requested.people.allowed,
    ...requested.people.restricted,
    ...requested.people.blocked
  ];
  requested.conversations = [...selection.chatRefs];
  requested.people.allowed = [...selection.personRefs];
  requested.exclusions.people = [...new Set([...requested.exclusions.people, ...allPeople.filter((ref) => !selection.personRefs.includes(ref))])];
  requested.sensitiveGroups.included = [...selection.sensitiveCategories];
  requested.sensitiveGroups.excluded = requested.sensitiveGroups.excluded.filter((category) => !selection.sensitiveCategories.includes(category));
  requested.categories = [...new Set([...requested.categories, ...selection.sensitiveCategories])];
  requested.exclusions.categories = requested.exclusions.categories.filter((category) => !selection.sensitiveCategories.includes(category));
  requested.exclusions.dateRanges = dateExclusions(requested.dateRange, selection);
  requested.acknowledgements.modelProcessing = true;
  requested.acknowledgements.untrustedSourceMaterial = true;
  return requested;
}

async function grantUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, scope, language, clock, grantIdFactory }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
  if (entry.status === "ready-to-process" || entry.status === "processed") {
    const permission = await currentPermission(stateStore, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview) };
  }
  if (entry.status !== "awaiting-content-grant" || entry.reviewId !== reviewId || !entry.selection) {
    throw new WhatsAppSnapshotError("WHATSAPP_EXPLICIT_SELECTION_REQUIRED", "Choose chats, Allowed people, dates, sensitivity, and media before granting access.");
  }
  await ensureConnectorBinding(connector, entry);
  const permission = await currentPermission(stateStore, accountId, language);
  if (!permission?.permissionReview || permission.permissionReview.status !== "awaiting-grant") {
    throw new WhatsAppSnapshotError("WHATSAPP_PERMISSION_REVIEW_MISMATCH", "The current permission review is not ready for this grant.");
  }
  const exactScope = scopeForSelection(permission.permissionReview, entry.selection);
  if (scope !== undefined && JSON.stringify(scope) !== JSON.stringify(exactScope)) {
    throw new WhatsAppSnapshotError("WHATSAPP_SCOPE_REBIND_REJECTED", "The grant must match the exact saved WhatsApp selection; start a new review to change it.");
  }
  const seenGrantIds = new Set([
    ...entry.audit.map((event) => event.grantId).filter(Boolean),
    ...(sourcePermissionEntry(state, accountId)?.grants ?? []).map((grant) => grant.id).filter(Boolean)
  ]);
  const granted = await grantSpecializedWhatsAppPermission({
    message,
    stateStore,
    connector: permissionProxy(connector, entry),
    source: SOURCE,
    accountId,
    reviewId,
    scope: exactScope,
    language,
    clock,
    grantIdFactory: guardedIdentifierFactory({ factory: grantIdFactory, prefix: "wa-grant", seen: seenGrantIds, field: "grant" })
  });
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.reviewId !== reviewId) throw new WhatsAppSnapshotError("STALE_WHATSAPP_GENERATION", "A newer snapshot review replaced this grant.");
  entry.status = "ready-to-process";
  entry.grantId = granted.permissionReview.activeGrant?.grantId ?? null;
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-content-granted", at: isoNow(clock), reviewId, grantId: entry.grantId, generation });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), granted.permissionReview) };
}

export async function grantWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => grantUnlocked(args));
}

async function fetchUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  const now = isoNow(clock);
  if (reconcileEntryFromPermissionState(state, entry, now)) await stateStore.save(state);
  if (entry.status === "processed" && Array.isArray(entry.approvedRecords)) {
    const permission = await currentPermission(stateStore, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview), approvedRecords: clone(entry.approvedRecords), idempotentReplay: true };
  }
  if (entry.status === "fetch-interrupted") {
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), fetchUnavailable: true, explicitRetryRequired: true };
  }
  if (entry.status !== "ready-to-process" || entry.reviewId !== reviewId || !entry.selection || !entry.grantId) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_REQUIRED", "An active exact WhatsApp snapshot grant is required before local content is read.");
  }
  await ensureConnectorBinding(connector, entry);
  entry.fetch = {
    status: "pending",
    operationId: `wa-fetch-${hash(`${entry.snapshotBinding.snapshotId}:${entry.generation}:${entry.reviewId}:${entry.grantId}`).slice(0, 24)}`,
    attempts: entry.fetch.attempts + 1,
    startedAt: now
  };
  entry.audit.push({ type: "whatsapp-fetch-started", at: now, operationId: entry.fetch.operationId, generation: entry.generation });
  // Persist the operation before opening any selected body. If this save fails,
  // the connector is never invoked.
  await stateStore.save(state);
  try {
    const fetched = await fetchSpecializedWhatsAppContent({
      message,
      stateStore,
      connector: permissionProxy(connector, entry),
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    entry.status = "processed";
    entry.approvedRecords = clone(fetched.approvedRecords);
    entry.fetch = { ...entry.fetch, status: "completed", completedAt: isoNow(clock) };
    entry.failure = null;
    entry.audit.push({ type: "whatsapp-fetch-completed", at: entry.fetch.completedAt, operationId: entry.fetch.operationId, recordCount: fetched.approvedRecords.length, rawBodiesReturned: false });
    await stateStore.save(state);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), fetched.permissionReview), approvedRecords: clone(entry.approvedRecords) };
  } catch (error) {
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    // A generic durable receipt means the body read completed and only the
    // outer save was interrupted. Reconcile it without a duplicate read.
    if (reconcileEntryFromPermissionState(state, entry, isoNow(clock)) && entry.status === "processed") {
      await stateStore.save(state);
      return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), approvedRecords: clone(entry.approvedRecords), recoveredFromDurableReceipt: true };
    }
    entry.status = "fetch-interrupted";
    entry.fetch.status = "interrupted";
    entry.failure = { stage: "approved-content-read", ...safeFailure(error, "SNAPSHOT_APPROVED_FETCH_FAILED", isoNow(clock)) };
    entry.audit.push({ type: "whatsapp-fetch-interrupted", at: entry.failure.at, operationId: entry.fetch.operationId, code: entry.failure.code, automaticRetry: false });
    await stateStore.save(state);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), fetchUnavailable: true, explicitRetryRequired: true };
  }
}

export async function fetchApprovedWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => fetchUnlocked(args));
}

async function resumeFetchUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, confirmRetry = false, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.status !== "fetch-interrupted" || entry.reviewId !== reviewId) throw new WhatsAppSnapshotError("WHATSAPP_FETCH_RETRY_NOT_READY", "There is no interrupted current snapshot read to retry.");
  if (confirmRetry !== true) return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), explicitRetryRequired: true };
  entry.status = "ready-to-process";
  entry.fetch.status = "retry-confirmed";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-fetch-retry-confirmed", at: isoNow(clock), previousOperationId: entry.fetch.operationId });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
}

export async function resumeWhatsAppSnapshotFetch(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => resumeFetchUnlocked(args));
}

async function revokeUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
  if (entry.status === "revoked") {
    const permission = await currentPermission(stateStore, accountId, language);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview), idempotentReplay: true };
  }
  if (!entry.grantId || entry.reviewId !== reviewId) throw new WhatsAppSnapshotError("WHATSAPP_ACTIVE_GRANT_NOT_FOUND", "There is no active current WhatsApp snapshot grant to revoke.");
  await ensureConnectorBinding(connector, entry);
  let revoked;
  try {
    revoked = await revokeSpecializedWhatsAppPermission({
      message,
      stateStore,
      connector: permissionProxy(connector, entry),
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
  } catch (error) {
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    entry.status = "revoke-unconfirmed";
    entry.failure = { stage: "grant-revocation-readback", ...safeFailure(error, "WHATSAPP_REVOCATION_UNCONFIRMED", isoNow(clock)) };
    entry.audit.push({
      type: "whatsapp-revocation-unconfirmed",
      at: entry.failure.at,
      reviewId,
      grantId: entry.grantId,
      code: entry.failure.code,
      sourceMutationConfirmed: false
    });
    await stateStore.save(state);
    return {
      whatsAppSnapshot: publicView(entry, languageFor(state, language)),
      revocationConfirmed: false,
      retryRequired: true
    };
  }
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  entry.status = "revoked";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-content-revoked", at: isoNow(clock), reviewId, grantId: entry.grantId, sourceMutation: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), revoked.permissionReview) };
}

export async function revokeWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => revokeUnlocked(args));
}

async function denyUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (!["awaiting-selection", "awaiting-content-grant"].includes(entry.status) || entry.reviewId !== reviewId) {
    if (entry.status === "denied") return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), idempotentReplay: true };
    throw new WhatsAppSnapshotError("WHATSAPP_DENIAL_NOT_READY", "Only the current ungranted snapshot review can be denied.");
  }
  const denied = await denySpecializedWhatsAppPermission({ message, stateStore, source: SOURCE, accountId, reviewId, language, clock });
  state = await loadState(stateStore);
  entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  entry.status = "denied";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-review-denied", at: isoNow(clock), reviewId, contentBodiesRead: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language), denied.permissionReview) };
}

export async function denyWhatsAppSnapshotContent(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => denyUnlocked(args));
}

async function cancelUnlocked({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, reviewId, language, clock }) {
  assertNaturalLanguage(message);
  let state = await loadState(stateStore);
  let entry = assertEntry(state, accountId);
  assertGeneration(entry, generation);
  if (entry.status === "cancelled") return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), idempotentReplay: true };
  if (["ready-to-process", "processed", "fetch-interrupted", "revoke-unconfirmed"].includes(entry.status)) {
    if (!connector) throw new WhatsAppSnapshotError("WHATSAPP_REVOKE_REQUIRED", "Cancelling an active snapshot first requires its local grant to be revoked.");
    return revokeUnlocked({ message, stateStore, connector, accountId, generation, reviewId: reviewId ?? entry.reviewId, language, clock });
  }
  if (["awaiting-selection", "awaiting-content-grant", "snapshot-review-pending", "snapshot-review-failed"].includes(entry.status) && entry.reviewId) {
    await denySpecializedWhatsAppPermission({ message, stateStore, source: SOURCE, accountId, reviewId: reviewId ?? entry.reviewId, language, clock });
    state = await loadState(stateStore);
    entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
  }
  entry.status = "cancelled";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-review-cancelled", at: isoNow(clock), reviewId: entry.reviewId, sourceMutation: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(entry, languageFor(state, language)) };
}

export async function cancelWhatsAppSnapshotReview(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => cancelUnlocked(args));
}

async function restartUnlocked({ message, stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, language, clock }) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const old = assertEntry(state, accountId);
  assertGeneration(old, generation);
  if (!["denied", "cancelled", "revoked", "snapshot-review-failed"].includes(old.status)) {
    throw new WhatsAppSnapshotError("WHATSAPP_RESTART_NOT_READY", "Finish, deny, cancel, or revoke the current snapshot review before starting a new generation.");
  }
  const now = isoNow(clock);
  const replacement = newEntry(accountId, now, old.generation + 1, old.audit);
  replacement.audit.push({ type: "whatsapp-new-review-generation", at: now, previousGeneration: old.generation, generation: replacement.generation });
  lifecycle(state).entries[personalEntryKey(accountId)] = replacement;
  await stateStore.save(state);
  return { whatsAppSnapshot: publicView(replacement, languageFor(state, language)) };
}

export async function restartWhatsAppSnapshotReview(args) {
  return withSourcePermissionStateLock(args?.stateStore, () => restartUnlocked(args));
}

export async function cleanupWhatsAppSnapshotPrivateMemory({ message, stateStore, connector, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, generation, language, clock }) {
  assertNaturalLanguage(message);
  return withSourcePermissionStateLock(stateStore, async () => {
    assertConnector(connector);
    const state = await loadState(stateStore);
    const entry = assertEntry(state, accountId);
    assertGeneration(entry, generation);
    const result = connector.cleanupPrivateMemory();
    entry.audit.push({ type: "whatsapp-private-memory-cleared", at: isoNow(clock), sourceFilesDeleted: false, stagingFilesCreated: false });
    await stateStore.save(state);
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language)), cleanup: result };
  });
}

export async function getWhatsAppSnapshotStatus({ stateStore, accountId = DEFAULT_WHATSAPP_SNAPSHOT_ACCOUNT_REF, language, clock }) {
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = lifecycle(state).entries[personalEntryKey(accountId)];
    if (!entry) return null;
    if (reconcileEntryFromPermissionState(state, entry, isoNow(clock))) await stateStore.save(state);
    const permission = entry.reviewId ? await currentPermission(stateStore, accountId, language) : null;
    return { whatsAppSnapshot: publicView(entry, languageFor(state, language), permission?.permissionReview) };
  });
}

export async function verifyWhatsAppOfficialBusinessConnection({ message, stateStore, verificationContract, accountId = DEFAULT_OFFICIAL_BUSINESS_ACCOUNT_REF, language, clock }) {
  assertNaturalLanguage(message);
  assertLocalAccountRef(accountId);
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const records = lifecycle(state);
    const key = businessEntryKey(accountId);
    const entry = records.entries[key] ?? {
      source: SOURCE,
      accountId,
      accountType: "official-business",
      status: "unsupported",
      audit: []
    };
    records.entries[key] = entry;
    entry.status = "unsupported";
    entry.audit.push({
      type: "whatsapp-official-business-unsupported",
      at: isoNow(clock),
      reason: verificationContract ? "caller-supplied-attestation-rejected" : "registered-host-provider-unavailable",
      suppliedContractInvoked: false,
      sourceAccessed: false
    });
    await stateStore.save(state);
    return { officialWhatsAppBusiness: publicBusinessView(entry, languageFor(state, language)) };
  });
}

export async function getWhatsAppOfficialBusinessStatus({ stateStore, accountId = DEFAULT_OFFICIAL_BUSINESS_ACCOUNT_REF, language }) {
  assertLocalAccountRef(accountId);
  return withSourcePermissionStateLock(stateStore, async () => {
    const state = await loadState(stateStore);
    const entry = lifecycle(state).entries[businessEntryKey(accountId)] ?? null;
    return { officialWhatsAppBusiness: publicBusinessView(entry, languageFor(state, language)) };
  });
}

export const WHATSAPP_LOCAL_SNAPSHOT_CONTRACT = Object.freeze({
  connectorProtocol: WHATSAPP_SNAPSHOT_CONNECTOR_PROTOCOL,
  bundleFormat: WHATSAPP_SNAPSHOT_BUNDLE_FORMAT,
  nativeZipSupported: false,
  sourceWritesSupported: false,
  livePersonalAccess: false,
  liveBusinessAccess: false
});
