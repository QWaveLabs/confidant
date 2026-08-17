/**
 * QWA-147 safe WhatsApp snapshot lifecycle.
 *
 * Personal WhatsApp is deliberately not a live connector. The customer moves
 * through one guided export/import action at a time, then QWA-139 owns the
 * metadata-first, deny-by-default permission grant. This module accepts only
 * injected snapshot adapters; it does not open WhatsApp, inspect a customer
 * account, or expose raw message or media bodies.
 *
 * Official WhatsApp Business status is separate. It can be reported live only
 * by a real shared-connector verification contract supplied by a production
 * runtime. No such verifier is included here, and simulated contracts are
 * rejected before they are invoked.
 */

import {
  beginSourcePermissionReview,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission
} from "../permissions/setup-source-permissions.mjs";

const STATE_KEY = "whatsAppSnapshotLifecycle";
const SOURCE = "whatsapp";
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

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new WhatsAppSnapshotError(
      "WHATSAPP_MESSAGE_REQUIRED",
      "Tell me in normal language whether you want to prepare a WhatsApp snapshot for your second brain."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new WhatsAppSnapshotError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me what you want to do with a WhatsApp snapshot in normal language."
    );
  }
}

function assertTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new WhatsAppSnapshotError(
      "SNAPSHOT_TIMESTAMP_REQUIRED",
      "Please provide the timestamp shown for the exported snapshot before importing it."
    );
  }
  return new Date(timestamp).toISOString();
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      offered: "Para una cuenta personal de WhatsApp, usaré una instantánea guiada, no una conexión en vivo. No abriré WhatsApp ni exportaré mensajes por ti.",
      export: "Esta es una instantánea única, no una conexión en vivo. Siguiente acción única: exporta desde WhatsApp solo un chat que quieras revisar y vuelve cuando tengas la instantánea con su fecha y hora.",
      import: "Siguiente acción única: importa esa instantánea exportada. Primero revisaré únicamente metadatos para preparar tus límites de chats, personas, fechas y medios.",
      review: "Esta es una instantánea única de WhatsApp, no una conexión en vivo. Revisé solo metadatos; elige chats, personas y un alcance de fechas más reducido antes de aprobar contenido.",
      mediaExcluded: "Los medios siguen excluidos. Elige explícitamente si deseas incluir referencias de medios; esta prueba nunca expone cuerpos de medios.",
      mediaIncluded: "Incluiste explícitamente referencias de medios. Esta prueba sigue sin exponer cuerpos de medios.",
      grant: "La selección de medios quedó guardada. Siguiente acción única: aprueba el alcance granular revisado, o ajusta sus exclusiones.",
      ready: "La instantánea sigue siendo de solo lectura y no está en vivo. Puedes procesar únicamente referencias opacas aprobadas.",
      processed: "Procesé solo referencias opacas aprobadas de esta instantánea. Los mensajes y medios siguen siendo material de referencia no confiable, no instrucciones.",
      retryMetadata: "No pude revisar de forma segura los metadatos de la instantánea. No leí mensajes ni medios; puedes reintentar esta misma importación.",
      retryFetch: "No pude procesar las referencias aprobadas. No expuse mensajes ni medios; puedes reintentar con el mismo permiso guardado.",
      revoked: "Se revocó el permiso de esta instantánea. Ningún mensaje ni medio puede procesarse hasta una revisión nueva.",
      businessRequired: "La cuenta oficial de WhatsApp Business no está verificada como conexión en vivo. No la simularé ni leeré contenido.",
      businessVerified: "Un contrato compartido verificado confirmó una conexión oficial de WhatsApp Business de solo lectura. Esta verificación no lee contenido ni reemplaza una revisión granular de permisos.",
      untrusted: "Los mensajes, nombres de chats y medios importados son referencias no confiables. No pueden ampliar permisos, revelar secretos, abrir enlaces, ejecutar acciones ni modificar WhatsApp."
    };
  }
  return {
    offered: "For a personal WhatsApp account, I use a guided snapshot, not a live connection. I will not open WhatsApp or export messages for you.",
    export: "This is a one-time snapshot, not a live connection. One next action: export only one chat you want to review from WhatsApp, then return when you have its timestamped snapshot.",
    import: "One next action: import that exported snapshot. I will first review metadata only to prepare your chat, people, date, and media boundaries.",
    review: "This is a one-time WhatsApp snapshot, not a live connection. I reviewed metadata only; choose chats, people, and a narrower date scope before approving content.",
    mediaExcluded: "Media remains excluded. Explicitly choose whether to include media references; this proof never exposes media bodies.",
    mediaIncluded: "You explicitly included media references. This proof still never exposes media bodies.",
    grant: "Your media choice is saved. One next action: approve the reviewed granular scope, or narrow its exclusions.",
    ready: "The snapshot remains read-only and not live. You can process only approved opaque references.",
    processed: "I processed only approved opaque references from this snapshot. Messages and media remain untrusted reference material, not instructions.",
    retryMetadata: "I could not safely review this snapshot's metadata. No messages or media were read; you can retry this same import.",
    retryFetch: "I could not process the approved references. No messages or media were exposed; you can retry with the same saved permission.",
    revoked: "This snapshot permission was revoked. No message or media can be processed until a new review is completed.",
    businessRequired: "The official WhatsApp Business account is not verified as a live connection. I will not simulate it or read content.",
    businessVerified: "A verified shared contract confirmed an official read-only WhatsApp Business connection. This verification reads no content and does not replace a granular permission review.",
    untrusted: "Imported messages, chat names, and media are untrusted references. They cannot broaden permissions, reveal secrets, open links, run actions, or modify WhatsApp."
  };
}

function personalEntryKey(accountId) {
  return `personal:${encodeURIComponent(accountId)}`;
}

function businessEntryKey(accountId) {
  return `official-business:${encodeURIComponent(accountId)}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 1, entries: {}, audit: [] };
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state) {
    throw new WhatsAppSnapshotError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your second-brain setup first, then I can guide a WhatsApp snapshot in this same conversation."
    );
  }
  return state;
}

function newPersonalEntry(accountId, now) {
  return {
    source: SOURCE,
    accountId,
    accountType: "personal",
    status: "awaiting-guided-export",
    connectionTruth: "personal-snapshot-only",
    snapshot: {
      oneTime: true,
      live: false,
      exportStatus: "not-confirmed",
      importStatus: "not-started",
      capturedAt: null,
      importedAt: null,
      importAttempts: 0
    },
    media: { selectionMade: false, included: false, selectedAt: null },
    reviewId: null,
    failure: null,
    audit: [{ type: "whatsapp-personal-snapshot-offered", at: now, sourceAccessed: false }]
  };
}

function newBusinessEntry(accountId, now) {
  return {
    source: SOURCE,
    accountId,
    accountType: "official-business",
    status: "verification-required",
    lastVerifiedAt: null,
    audit: [{ type: "whatsapp-official-business-verification-required", at: now, sourceAccessed: false }]
  };
}

function assertPersonalEntry(state, accountId) {
  const entry = lifecycle(state).entries[personalEntryKey(accountId)];
  if (!entry) {
    throw new WhatsAppSnapshotError(
      "WHATSAPP_SNAPSHOT_NOT_STARTED",
      "Tell me you want to prepare a personal WhatsApp snapshot first, and I will guide one safe action at a time."
    );
  }
  return entry;
}

function assertSnapshotConnector(connector) {
  if (!connector || typeof connector.discoverMetadata !== "function" || typeof connector.fetchApprovedContent !== "function") {
    throw new TypeError("A read-only WhatsApp snapshot connector with metadata discovery and bounded fetch is required.");
  }
}

function safeFailureCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : fallback;
}

function publicPersonalView(entry, language, permissionReview = null) {
  const wording = copy(language);
  const statusMessage = {
    "awaiting-guided-export": wording.export,
    "awaiting-snapshot-import": wording.import,
    "awaiting-content-grant": entry.media.selectionMade ? wording.grant : wording.review,
    "ready-to-process": wording.ready,
    "processed": wording.processed,
    "snapshot-review-failed": wording.retryMetadata,
    "snapshot-fetch-failed": wording.retryFetch,
    "revoked": wording.revoked
  }[entry.status] ?? wording.offered;
  const nextAction = {
    "awaiting-guided-export": "export-one-selected-chat",
    "awaiting-snapshot-import": "import-exported-snapshot",
    "awaiting-content-grant": entry.media.selectionMade ? "approve-reviewed-granular-scope" : "choose-media-inclusion",
    "ready-to-process": "process-approved-opaque-references",
    "snapshot-review-failed": "retry-snapshot-metadata-review",
    "snapshot-fetch-failed": "retry-approved-reference-processing",
    "revoked": "start-a-new-snapshot-review"
  }[entry.status] ?? null;
  return {
    source: SOURCE,
    accountType: "personal",
    status: entry.status,
    message: statusMessage,
    connection: {
      mode: "guided-one-time-snapshot",
      live: false,
      simulated: true,
      readOnly: true,
      oneActionAtATime: true,
      canOpenWhatsApp: false,
      canExportFromWhatsApp: false,
      canSendMessages: false,
      canAlterMessages: false,
      canFollowImportedInstructions: false,
      canMutateSource: false
    },
    snapshot: clone(entry.snapshot),
    selection: {
      chats: "choose-from-reviewed-metadata",
      people: "choose-from-reviewed-metadata",
      dates: "QWA-139-default-window-with-narrower-exclusions",
      media: {
        selectionMade: entry.media.selectionMade,
        included: entry.media.included,
        rawMediaBodiesExposed: false,
        message: entry.media.included ? wording.mediaIncluded : wording.mediaExcluded
      }
    },
    nextAction,
    untrustedSourceMaterial: wording.untrusted,
    failure: entry.failure ? clone(entry.failure) : null,
    permissionReview: permissionReview ? clone(permissionReview) : null,
    audit: clone(entry.audit)
  };
}

function publicBusinessView(entry, language, { live = false } = {}) {
  const wording = copy(language);
  return {
    source: SOURCE,
    accountType: "official-business",
    status: live ? "official-business-live-verified" : "verification-required",
    message: live ? wording.businessVerified : wording.businessRequired,
    connection: {
      mode: "official-business-shared-verification",
      live,
      verified: live,
      simulated: false,
      readOnly: true,
      sourceAccessStarted: false,
      contentPermissionGranted: false,
      canSendMessages: false,
      canAlterMessages: false
    },
    verification: {
      protocol: OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL,
      lastVerifiedAt: entry?.lastVerifiedAt ?? null,
      requiresFreshSharedVerification: !live
    },
    audit: entry ? clone(entry.audit) : []
  };
}

async function beginPersonalMetadataReview({ stateStore, connector, accountId, language, clock, reviewIdFactory }) {
  let review;
  try {
    review = await beginSourcePermissionReview({
      message: language === "es"
        ? "Quiero revisar una instantánea de WhatsApp para mi segundo cerebro"
        : "I want to review a WhatsApp snapshot for my second brain",
      stateStore,
      connector,
      source: SOURCE,
      language,
      clock,
      reviewIdFactory
    });
    if (review.permissionReview.account.id !== accountId) {
      throw new WhatsAppSnapshotError(
        "WHATSAPP_ACCOUNT_MISMATCH",
        "I could not confirm that the reviewed snapshot matches this saved account, so no message or media content was requested."
      );
    }
    if (review.permissionReview.status !== "awaiting-grant") {
      throw new WhatsAppSnapshotError(
        "WHATSAPP_EXISTING_PERMISSION_REQUIRES_NEW_REVIEW",
        "A different WhatsApp permission state already exists for this account, so I stopped before using it for this snapshot. Start a fresh review."
      );
    }
  } catch (error) {
    const fallbackState = await loadState(stateStore);
    const fallbackEntry = assertPersonalEntry(fallbackState, accountId);
    const now = isoNow(clock);
    fallbackEntry.status = "snapshot-review-failed";
    fallbackEntry.snapshot.importStatus = "metadata-review-failed";
    fallbackEntry.failure = { stage: "metadata-review", code: safeFailureCode(error, "SNAPSHOT_METADATA_REVIEW_FAILED"), at: now };
    fallbackEntry.audit.push({
      type: "whatsapp-snapshot-metadata-review-failed",
      at: now,
      code: fallbackEntry.failure.code,
      messageBodiesRead: false,
      mediaBodiesRead: false
    });
    lifecycle(fallbackState).audit.push({
      type: "whatsapp-snapshot-resume-available",
      at: now,
      accountId,
      stage: "metadata-review"
    });
    await stateStore.save(fallbackState);
    return {
      whatsAppSnapshot: publicPersonalView(fallbackEntry, languageFor(fallbackState, language)),
      metadataReviewUnavailable: true
    };
  }

  const refreshed = await loadState(stateStore);
  const entry = assertPersonalEntry(refreshed, accountId);
  const now = isoNow(clock);
  entry.status = "awaiting-content-grant";
  entry.reviewId = review.permissionReview.permissionRequest.reviewId;
  entry.snapshot.importStatus = "metadata-reviewed";
  entry.snapshot.importedAt = now;
  entry.failure = null;
  entry.audit.push({
    type: "whatsapp-snapshot-metadata-reviewed",
    at: now,
    reviewId: entry.reviewId,
    messageBodiesRead: false,
    mediaBodiesRead: false
  });
  await stateStore.save(refreshed);
  return { whatsAppSnapshot: publicPersonalView(entry, languageFor(refreshed, language), review.permissionReview) };
}

/** Starts the personal-account snapshot path without opening WhatsApp or a source file. */
export async function beginWhatsAppPersonalSnapshot({
  message,
  stateStore,
  accountId = "personal-whatsapp",
  language,
  clock
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = personalEntryKey(accountId);
  if (!records.entries[key]) {
    const now = isoNow(clock);
    records.entries[key] = newPersonalEntry(accountId, now);
    records.audit.push({ type: "whatsapp-personal-snapshot-offered", at: now, accountId, sourceAccessed: false });
    await stateStore.save(state);
  }
  return { whatsAppSnapshot: publicPersonalView(records.entries[key], languageFor(state, language)) };
}

/**
 * Records only the customer's confirmation that they completed the single
 * export action outside this application. It does not open WhatsApp, receive a
 * source body, or attempt an import.
 */
export async function confirmWhatsAppPersonalExport({
  message,
  stateStore,
  accountId = "personal-whatsapp",
  exportCompleted = false,
  snapshotCapturedAt,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertPersonalEntry(state, accountId);
  if (entry.status !== "awaiting-guided-export") {
    return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language)) };
  }
  if (exportCompleted !== true) {
    return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language)) };
  }
  const now = isoNow(clock);
  entry.status = "awaiting-snapshot-import";
  entry.snapshot.exportStatus = "customer-confirmed";
  entry.snapshot.capturedAt = assertTimestamp(snapshotCapturedAt);
  entry.audit.push({
    type: "whatsapp-personal-export-confirmed-by-customer",
    at: now,
    capturedAt: entry.snapshot.capturedAt,
    sourceAccessed: false
  });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language)) };
}

/**
 * Begins a metadata-only review after a customer confirms the exported
 * snapshot. The injected connector must not expose a raw message/media body.
 * Failed metadata review is fail-closed and resumable from the same snapshot.
 */
export async function beginWhatsAppSnapshotImport({
  message,
  stateStore,
  connector,
  accountId = "personal-whatsapp",
  snapshotImportApproved = false,
  language,
  clock,
  reviewIdFactory
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const entry = assertPersonalEntry(state, accountId);
  if (entry.status === "awaiting-content-grant") {
    const current = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
    return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language), current?.permissionReview) };
  }
  if (entry.status !== "awaiting-snapshot-import" && entry.status !== "snapshot-review-failed") {
    throw new WhatsAppSnapshotError(
      "GUIDED_EXPORT_REQUIRED",
      "Complete the saved one-chat export confirmation before starting this WhatsApp snapshot review."
    );
  }
  if (snapshotImportApproved !== true) {
    return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language)) };
  }
  assertSnapshotConnector(connector);
  const now = isoNow(clock);
  entry.snapshot.importAttempts += 1;
  entry.snapshot.importStatus = "metadata-review-pending";
  entry.audit.push({ type: "whatsapp-snapshot-import-approved", at: now, attempt: entry.snapshot.importAttempts, messageBodiesRead: false, mediaBodiesRead: false });
  await stateStore.save(state);
  return beginPersonalMetadataReview({
    stateStore,
    connector,
    accountId,
    language: languageFor(state, language),
    clock,
    reviewIdFactory
  });
}

/** Records the required, explicit media choice without fetching source content. */
export async function selectWhatsAppSnapshotMedia({
  message,
  stateStore,
  accountId = "personal-whatsapp",
  reviewId,
  includeMedia,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  if (typeof includeMedia !== "boolean") {
    throw new WhatsAppSnapshotError("MEDIA_SELECTION_REQUIRED", "Choose explicitly whether this reviewed WhatsApp snapshot includes media references.");
  }
  const state = await loadState(stateStore);
  const entry = assertPersonalEntry(state, accountId);
  if (entry.status !== "awaiting-content-grant" || entry.reviewId !== reviewId) {
    throw new WhatsAppSnapshotError("WHATSAPP_MEDIA_REVIEW_NOT_READY", "Review the saved WhatsApp snapshot metadata before choosing media handling.");
  }
  const now = isoNow(clock);
  entry.media = { selectionMade: true, included: includeMedia, selectedAt: now };
  entry.audit.push({ type: "whatsapp-snapshot-media-selection", at: now, reviewId, included: includeMedia, mediaBodiesRead: false });
  await stateStore.save(state);
  const current = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language), current?.permissionReview) };
}

/** Grants only the QWA-139-reviewed chats, people, date boundary, and explicit media policy. */
export async function grantWhatsAppSnapshotContent({
  message,
  stateStore,
  connector,
  accountId = "personal-whatsapp",
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
}) {
  assertNaturalLanguage(message);
  assertSnapshotConnector(connector);
  const state = await loadState(stateStore);
  const entry = assertPersonalEntry(state, accountId);
  if (entry.status !== "awaiting-content-grant" || entry.reviewId !== reviewId) {
    throw new WhatsAppSnapshotError("WHATSAPP_REVIEW_NOT_READY", "Continue the saved WhatsApp snapshot review before approving any content.");
  }
  if (!entry.media.selectionMade) {
    throw new WhatsAppSnapshotError("MEDIA_SELECTION_REQUIRED", "Choose whether media references are included before approving this WhatsApp snapshot scope.");
  }
  const granted = await grantSourcePermission({
    message,
    stateStore,
    connector,
    source: SOURCE,
    accountId,
    reviewId,
    scope,
    language,
    clock,
    grantIdFactory
  });
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertPersonalEntry(refreshed, accountId);
  refreshedEntry.status = "ready-to-process";
  refreshedEntry.failure = null;
  refreshedEntry.audit.push({
    type: "whatsapp-snapshot-content-granted",
    at: isoNow(clock),
    reviewId,
    grantId: granted.permissionReview.activeGrant?.grantId ?? null,
    mediaIncluded: refreshedEntry.media.included
  });
  await stateStore.save(refreshed);
  return { whatsAppSnapshot: publicPersonalView(refreshedEntry, languageFor(refreshed, language), granted.permissionReview) };
}

/**
 * Fetches only opaque approved records. The media policy is installed before
 * the generic fetch so excluded media never reaches that boundary. This method
 * marks a connector interruption as resumable without exposing data.
 */
export async function fetchApprovedWhatsAppSnapshotContent({
  message,
  stateStore,
  connector,
  accountId = "personal-whatsapp",
  reviewId,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertSnapshotConnector(connector);
  if (typeof connector.setWhatsAppSnapshotContentPolicy !== "function") {
    throw new TypeError("A WhatsApp snapshot connector with setWhatsAppSnapshotContentPolicy() is required to enforce media exclusion.");
  }
  const state = await loadState(stateStore);
  const entry = assertPersonalEntry(state, accountId);
  if ((entry.status !== "ready-to-process" && entry.status !== "snapshot-fetch-failed") || entry.reviewId !== reviewId) {
    throw new WhatsAppSnapshotError("WHATSAPP_GRANT_REQUIRED", "No WhatsApp snapshot content was processed because the saved granular grant is not ready.");
  }
  try {
    await connector.setWhatsAppSnapshotContentPolicy({ includeMedia: entry.media.included });
    const fetched = await fetchApprovedSourceContent({
      message,
      stateStore,
      connector,
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
    const refreshed = await loadState(stateStore);
    const refreshedEntry = assertPersonalEntry(refreshed, accountId);
    refreshedEntry.status = "processed";
    refreshedEntry.failure = null;
    refreshedEntry.audit.push({
      type: "whatsapp-snapshot-approved-references-processed",
      at: isoNow(clock),
      reviewId,
      recordCount: fetched.approvedRecords.length,
      rawMessageBodiesExposed: false,
      rawMediaBodiesExposed: false
    });
    await stateStore.save(refreshed);
    return {
      whatsAppSnapshot: publicPersonalView(refreshedEntry, languageFor(refreshed, language), fetched.permissionReview),
      approvedRecords: fetched.approvedRecords
    };
  } catch (error) {
    const fallbackState = await loadState(stateStore);
    const fallbackEntry = assertPersonalEntry(fallbackState, accountId);
    const now = isoNow(clock);
    fallbackEntry.status = "snapshot-fetch-failed";
    fallbackEntry.failure = { stage: "approved-reference-processing", code: safeFailureCode(error, "SNAPSHOT_APPROVED_FETCH_FAILED"), at: now };
    fallbackEntry.audit.push({
      type: "whatsapp-snapshot-approved-reference-processing-failed",
      at: now,
      code: fallbackEntry.failure.code,
      rawMessageBodiesExposed: false,
      rawMediaBodiesExposed: false
    });
    await stateStore.save(fallbackState);
    return {
      whatsAppSnapshot: publicPersonalView(fallbackEntry, languageFor(fallbackState, language)),
      fetchUnavailable: true
    };
  }
}

/** Revokes the local QWA-139 grant; this cannot modify any WhatsApp source. */
export async function revokeWhatsAppSnapshotContent({
  message,
  stateStore,
  connector,
  accountId = "personal-whatsapp",
  reviewId,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  const revoked = await revokeSourcePermission({
    message,
    stateStore,
    connector,
    source: SOURCE,
    accountId,
    reviewId,
    language,
    clock
  });
  const state = await loadState(stateStore);
  const entry = assertPersonalEntry(state, accountId);
  entry.status = "revoked";
  entry.failure = null;
  entry.audit.push({ type: "whatsapp-snapshot-content-revoked", at: isoNow(clock), reviewId, sourceMutation: false });
  await stateStore.save(state);
  return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language), revoked.permissionReview) };
}

/** Read-only status lookup; it never invokes a WhatsApp adapter or connector. */
export async function getWhatsAppSnapshotStatus({ stateStore, accountId = "personal-whatsapp", language }) {
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[personalEntryKey(accountId)];
  if (!entry) return null;
  const permission = await getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
  return { whatsAppSnapshot: publicPersonalView(entry, languageFor(state, language), permission?.permissionReview) };
}

function validOfficialBusinessVerification(result, accountId) {
  const verifiedAt = Date.parse(result?.verification?.verifiedAt);
  return result?.protocol === OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL
    && result?.source === "whatsapp-official-business"
    && result?.accountId === accountId
    && result?.verified === true
    && result?.live === true
    && result?.readOnly === true
    && result?.simulated === false
    && typeof result?.verification?.evidenceId === "string"
    && /^[A-Za-z0-9._:-]{1,160}$/.test(result.verification.evidenceId)
    && Number.isFinite(verifiedAt);
}

/**
 * Checks a production-owned shared verification contract without reading
 * WhatsApp content. A local or simulated verifier is rejected before it runs.
 * This module supplies no verifier, so the default customer-visible result is
 * always non-live.
 */
export async function verifyWhatsAppOfficialBusinessConnection({
  message,
  stateStore,
  verificationContract,
  accountId = "official-whatsapp-business",
  language,
  clock
}) {
  assertNaturalLanguage(message);
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = businessEntryKey(accountId);
  const entry = records.entries[key] ?? newBusinessEntry(accountId, isoNow(clock));
  records.entries[key] = entry;
  const requestedLanguage = languageFor(state, language);
  const validContract = verificationContract
    && verificationContract.simulated !== true
    && verificationContract.mode === "real-shared-connector"
    && typeof verificationContract.verifyOfficialBusinessReadOnly === "function";
  if (!validContract) {
    entry.status = "verification-required";
    entry.audit.push({ type: "whatsapp-official-business-unverified", at: isoNow(clock), reason: "shared-verification-unavailable", sourceAccessed: false });
    await stateStore.save(state);
    return { officialWhatsAppBusiness: publicBusinessView(entry, requestedLanguage) };
  }

  let result;
  try {
    result = await verificationContract.verifyOfficialBusinessReadOnly({
      protocol: OFFICIAL_WHATSAPP_BUSINESS_VERIFICATION_PROTOCOL,
      source: "whatsapp-official-business",
      accountId,
      requiredCapabilities: { readOnly: true, live: true }
    });
  } catch {
    result = null;
  }
  if (!validOfficialBusinessVerification(result, accountId)) {
    entry.status = "verification-required";
    entry.audit.push({ type: "whatsapp-official-business-unverified", at: isoNow(clock), reason: "shared-verification-rejected", sourceAccessed: false });
    await stateStore.save(state);
    return { officialWhatsAppBusiness: publicBusinessView(entry, requestedLanguage) };
  }

  entry.status = "verification-required";
  entry.lastVerifiedAt = new Date(Date.parse(result.verification.verifiedAt)).toISOString();
  entry.audit.push({ type: "whatsapp-official-business-live-verified", at: isoNow(clock), verifiedAt: entry.lastVerifiedAt, sourceAccessed: false, contentPermissionGranted: false });
  await stateStore.save(state);
  // The true result is intentionally ephemeral: a persisted state file alone
  // can never be treated as proof that a business account is still live.
  return { officialWhatsAppBusiness: publicBusinessView(entry, requestedLanguage, { live: true }) };
}

/**
 * Persisted official-business status is never a live claim. A production
 * caller must run verifyWhatsAppOfficialBusinessConnection again with its real
 * shared contract before it can report a live connection.
 */
export async function getWhatsAppOfficialBusinessStatus({ stateStore, accountId = "official-whatsapp-business", language }) {
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[businessEntryKey(accountId)] ?? null;
  return { officialWhatsAppBusiness: publicBusinessView(entry, languageFor(state, language)) };
}
