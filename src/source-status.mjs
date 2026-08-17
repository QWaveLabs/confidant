/**
 * QWA-149 source-state presentation and safe generic-export vertical slice.
 *
 * This module is a status boundary, not a connector SDK. It never opens an
 * OAuth flow, calls a real source, reads a source body, writes to a source, or
 * turns a reported adapter state into a claim that a connector is live. The
 * one import path is intentionally a simulated generic export that returns
 * opaque, snapshot-labelled references only after granular consent.
 */

import { randomUUID } from "node:crypto";

const STATE_KEY = "sourceStatusV2";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID = /^simulated-export(?::[a-z0-9][a-z0-9-]{0,63})?$/;
const BODY_FIELD_NAMES = new Set([
  "body",
  "html",
  "text",
  "content",
  "snippet",
  "raw",
  "payload",
  "headers",
  "mime",
  "attachment",
  "attachments",
  "messagebody",
  "emailbody"
]);
const MAX_PREVIEW_ITEMS = 250;

/** Shared state vocabulary used by every adapter presentation. */
export const SOURCE_STATUS_STATES = Object.freeze({
  NOT_STARTED: "not-started",
  AWAITING_GRANT: "awaiting-grant",
  READY_TO_IMPORT: "ready-to-import",
  IMPORTING: "importing",
  IMPORTED: "imported",
  SKIPPED: "skipped",
  REVOKED: "revoked",
  UNSUPPORTED: "unsupported",
  NEEDS_ATTENTION: "needs-attention"
});

export const SOURCE_STATE_VOCABULARY = SOURCE_STATUS_STATES;

/** Final customer handoff buckets. Each source appears in exactly one. */
export const SOURCE_HANDOFF_CATEGORIES = Object.freeze({
  UNFINISHED: "unfinished",
  SKIPPED: "skipped",
  IMPORTED: "imported",
  REVOKED: "revoked",
  UNSUPPORTED: "unsupported"
});

export const SOURCE_ADAPTER_NAMES = Object.freeze({
  GENERIC_EXPORT: "simulated-generic-export",
  GMAIL: "gmail-readonly",
  GOOGLE_DRIVE: "google-drive",
  IMESSAGE: "imessage-beta"
});

export const LIVE_CONNECTOR_RELEASE_GATE = Object.freeze({
  id: "at-least-one-live-verified-connector",
  requirement: "At least one live, independently verified, read-only connector",
  simulationDoesNotSatisfyRequirement: true
});

const ALL_STATES = new Set(Object.values(SOURCE_STATUS_STATES));
const FINAL_STATES = new Set([
  SOURCE_STATUS_STATES.IMPORTED,
  SOURCE_STATUS_STATES.SKIPPED,
  SOURCE_STATUS_STATES.REVOKED,
  SOURCE_STATUS_STATES.UNSUPPORTED
]);

export class SourceStatusError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "SourceStatusError";
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

function assertNaturalLanguage(message, action = "start") {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new SourceStatusError(
      "SOURCE_STATUS_MESSAGE_REQUIRED",
      "Tell me in normal language what you would like to do with this optional source."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new SourceStatusError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me normally whether you want to preview, approve, skip, resume, import, or revoke this source."
    );
  }
  if (action === "start" && !/(source|export|import|second\s+brain|segundo\s+cerebro|fuente|exportaci[oó]n|importar|conectar|connect|preview|vista previa|review|revisar)/i.test(message)) {
    throw new SourceStatusError(
      "UNRECOGNIZED_SOURCE_REQUEST",
      "Tell me you would like to preview a simulated export for your second brain, and I will guide the safe next step."
    );
  }
}

function assertSourceId(sourceId) {
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) {
    throw new SourceStatusError(
      "SIMULATED_SOURCE_ID_REQUIRED",
      "This safe slice only supports an explicitly simulated generic export. It will not open or imitate a real source connection."
    );
  }
  return sourceId;
}

function unsupportedSourceId(requestedSource) {
  const safe = typeof requestedSource === "string" && /^[a-z][a-z0-9-]{0,63}$/i.test(requestedSource)
    ? requestedSource.toLowerCase()
    : "unavailable-source";
  return `unsupported:${safe}`;
}

function languageFor(state, requestedLanguage) {
  return requestedLanguage === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function wording(language) {
  if (language === "es") {
    return {
      notStarted: "Esta fuente opcional todavía no se ha iniciado. No está conectada.",
      awaitingGrant: "La vista previa fue solo de metadatos. No se leyó ningún cuerpo de fuente. Elige exactamente qué elementos de exportación simulada autorizas antes de importar una instantánea.",
      readyToImport: "Tu permiso granular se guardó para esta exportación simulada. El siguiente paso importará únicamente una instantánea etiquetada y de una sola vez; no conecta una fuente real.",
      importing: "La importación de la instantánea simulada está en curso. Si se interrumpe, se pausará de forma segura y requerirá una vista previa nueva antes de volver a intentarlo.",
      imported: "Se importó una instantánea etiquetada de la exportación simulada. No se conectó ni verificó una fuente real, y el permiso de una sola vez quedó cerrado.",
      skipped: "Esta fuente opcional quedó omitida por ahora. Puedes reanudarla aquí más adelante; no se concedió acceso al contenido.",
      revoked: "El permiso de esta fuente fue revocado. Una pantalla o solicitud anterior no puede reactivarlo; inicia una vista previa nueva si quieres volver a considerarlo.",
      unsupported: "Esta fuente no es compatible en esta configuración segura. No se intentó ninguna conexión y no se leyó ningún dato de fuente. Puedes usar una exportación simulada de metadatos si quieres ver el flujo.",
      needsAttention: "Esta fuente necesita atención antes de continuar. El flujo se detuvo de forma segura y no se expuso ningún cuerpo de fuente. Puedes reanudar el paso seguro guardado.",
      metadataOnly: "Solo metadatos: nombres genéricos de elementos, identificadores opacos y categorías. No hay cuerpos, adjuntos, mensajes, archivos ni enlaces de fuente.",
      noLiveConnection: "No hay una conexión en vivo ni verificada en esta vista segura.",
      releaseGateUnsatisfied: "La puerta de lanzamiento sigue sin cumplir: esta entrega no tiene al menos un conector en vivo verificado de forma independiente. Las simulaciones y los estados informados por adaptadores no cuentan.",
      releaseGateSatisfied: "La puerta de lanzamiento cuenta con evidencia externa de al menos un conector en vivo y de solo lectura verificado de forma independiente.",
      unsupportedSafe: "No puedo conectar esta fuente desde esta configuración. No inventaré una conexión, enlace ni estado en vivo."
    };
  }
  return {
    notStarted: "This optional source has not been started. It is not connected.",
    awaitingGrant: "The preview was metadata-only. No source body was read. Choose exactly which simulated export items you approve before importing a labelled snapshot.",
    readyToImport: "Your granular permission is saved for this simulated export. The next step imports only a labelled, one-time snapshot; it does not connect a real source.",
    importing: "The simulated snapshot import is in progress. If it is interrupted, it will pause safely and require a fresh preview before retrying.",
    imported: "A labelled simulated-export snapshot was imported. No real source was connected or verified, and the one-time permission is closed.",
    skipped: "This optional source is skipped for now. You can resume it here later; no content access was granted.",
    revoked: "This source permission was revoked. An earlier screen or request cannot reactivate it; start a fresh preview if you want to consider it again.",
    unsupported: "This source is unsupported in this safe setup. No connection was attempted and no source data was read. You can use a metadata-only simulated export to see the flow.",
    needsAttention: "This source needs attention before it can continue. The flow stopped safely and no source body was exposed. You can resume the saved safe step.",
    metadataOnly: "Metadata only: generic item labels, opaque ids, and categories. No bodies, attachments, messages, files, or source links are present.",
    noLiveConnection: "There is no live or verified connection in this safe view.",
    releaseGateUnsatisfied: "The release gate remains unsatisfied: this delivery has no independently verified live connector. Simulations and adapter-reported states do not count.",
    releaseGateSatisfied: "The release gate has externally supplied evidence of at least one independently verified, read-only live connector.",
    unsupportedSafe: "I cannot connect this source from this safe setup. I will not invent a connection, link, or live status."
  };
}

function handoffCategoryFor(state) {
  if (state === SOURCE_STATUS_STATES.SKIPPED) return SOURCE_HANDOFF_CATEGORIES.SKIPPED;
  if (state === SOURCE_STATUS_STATES.IMPORTED) return SOURCE_HANDOFF_CATEGORIES.IMPORTED;
  if (state === SOURCE_STATUS_STATES.REVOKED) return SOURCE_HANDOFF_CATEGORIES.REVOKED;
  if (state === SOURCE_STATUS_STATES.UNSUPPORTED) return SOURCE_HANDOFF_CATEGORIES.UNSUPPORTED;
  return SOURCE_HANDOFF_CATEGORIES.UNFINISHED;
}

function stateMessage(state, language) {
  const copy = wording(language);
  const key = {
    [SOURCE_STATUS_STATES.NOT_STARTED]: "notStarted",
    [SOURCE_STATUS_STATES.AWAITING_GRANT]: "awaitingGrant",
    [SOURCE_STATUS_STATES.READY_TO_IMPORT]: "readyToImport",
    [SOURCE_STATUS_STATES.IMPORTING]: "importing",
    [SOURCE_STATUS_STATES.IMPORTED]: "imported",
    [SOURCE_STATUS_STATES.SKIPPED]: "skipped",
    [SOURCE_STATUS_STATES.REVOKED]: "revoked",
    [SOURCE_STATUS_STATES.UNSUPPORTED]: "unsupported",
    [SOURCE_STATUS_STATES.NEEDS_ATTENTION]: "needsAttention"
  }[state] ?? "needsAttention";
  return copy[key];
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", message);
  }
}

function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, `${field} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", `${field} included an unsupported field, so I stopped without changing access.`);
  }
}

function assertNoSourceBody(value, location = "adapter response", seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSourceBody(item, `${location}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (BODY_FIELD_NAMES.has(key.toLowerCase())) {
      throw new SourceStatusError(
        "SOURCE_BODY_BOUNDARY_INVALID",
        `The ${location} included a source-body field, so I stopped before saving or showing it.`
      );
    }
    assertNoSourceBody(child, `${location}.${key}`, seen);
  }
}

function opaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", `${field} must be a short opaque identifier.`);
  }
  return value;
}

function uniqueOpaqueIds(values, field) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_PREVIEW_ITEMS) {
    throw new SourceStatusError("GRANULAR_SELECTION_REQUIRED", `Choose one or more individual reviewed export items for ${field}.`);
  }
  const normalized = values.map((value) => opaqueId(value, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new SourceStatusError("GRANULAR_SELECTION_INVALID", "Each selected export item must appear once so the permission stays unambiguous.");
  }
  return normalized;
}

function rootLifecycle(state) {
  if (!state?.installationId) {
    throw new SourceStatusError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your second-brain setup first, then I can guide this optional source safely in the same conversation."
    );
  }
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = { version: 2, entries: {}, audit: [] };
  }
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  rootLifecycle(state);
  return state;
}

function defaultEntry(sourceId, now) {
  return {
    sourceId,
    adapter: SOURCE_ADAPTER_NAMES.GENERIC_EXPORT,
    state: SOURCE_STATUS_STATES.NOT_STARTED,
    resumeState: SOURCE_STATUS_STATES.NOT_STARTED,
    metadataPreview: null,
    permission: {
      status: "none",
      reviewId: null,
      grantId: null,
      selectedItemIds: [],
      grantedAt: null,
      revokedAt: null
    },
    snapshotImport: {
      status: "not-started",
      snapshotLabel: null,
      importedAt: null,
      records: []
    },
    lastSafeError: null,
    audit: [{ type: "simulated-export-selected", at: now, sourceBodiesRead: false }]
  };
}

function safePreview(preview) {
  if (!preview) return null;
  return {
    metadataOnly: true,
    contentBodiesRead: false,
    previewedAt: preview.previewedAt,
    itemCount: preview.itemCount,
    items: preview.items.map((item) => ({ id: item.id, label: item.label, category: item.category })),
    message: preview.message
  };
}

function publicSourceStatus(entry, language, { adapterReportedState = null, external = false } = {}) {
  const simulated = entry.adapter === SOURCE_ADAPTER_NAMES.GENERIC_EXPORT;
  const category = handoffCategoryFor(entry.state);
  return {
    source: {
      id: entry.sourceId,
      adapter: entry.adapter,
      kind: simulated ? "simulated-generic-export" : "adapter-status-only",
      label: entry.state === SOURCE_STATUS_STATES.UNSUPPORTED ? "Unsupported source" : simulated ? "Simulated generic export" : "Source status"
    },
    state: entry.state,
    handoffCategory: category,
    message: stateMessage(entry.state, language),
    connection: {
      status: simulated ? "not-connected-simulation" : "not-verified",
      live: false,
      independentlyVerified: false,
      readOnly: simulated ? true : null,
      realConnectionAttempted: false,
      sourceBodiesRead: false,
      sourceWrites: false,
      note: wording(language).noLiveConnection
    },
    metadataPreview: safePreview(entry.metadataPreview),
    granularPermission: {
      status: entry.permission.status,
      reviewId: entry.permission.reviewId,
      grantId: entry.permission.grantId,
      selectedItemIds: clone(entry.permission.selectedItemIds),
      grantedAt: entry.permission.grantedAt,
      revokedAt: entry.permission.revokedAt
    },
    snapshotImport: {
      status: entry.snapshotImport.status,
      snapshotLabel: entry.snapshotImport.snapshotLabel,
      simulated: simulated,
      importedAt: entry.snapshotImport.importedAt,
      recordCount: entry.snapshotImport.records.length,
      records: entry.snapshotImport.records.map((record) => ({
        source: record.source,
        snapshotRecordId: record.snapshotRecordId,
        processingDisposition: record.processingDisposition
      }))
    },
    nextAction: nextActionFor(entry, language),
    lastSafeError: entry.lastSafeError ? clone(entry.lastSafeError) : null,
    adapterReportedState: adapterReportedState ? { value: adapterReportedState, treatedAsProofOfLiveConnection: false } : null,
    external,
    audit: clone(entry.audit)
  };
}

function nextActionFor(entry, language) {
  const isEs = language === "es";
  if (entry.state === SOURCE_STATUS_STATES.AWAITING_GRANT) {
    return {
      kind: "review-granular-simulated-export-permission",
      instruction: isEs ? "Revisa los elementos de exportación simulada y aprueba exactamente los que quieres incluir." : "Review the simulated export items and approve exactly the ones you want included."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.READY_TO_IMPORT) {
    return {
      kind: "import-approved-simulated-snapshot",
      instruction: isEs ? "Importa la instantánea simulada aprobada de una sola vez." : "Import the approved one-time simulated snapshot."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.SKIPPED) {
    return {
      kind: "resume-optional-source",
      instruction: isEs ? "Reanuda esta fuente opcional cuando quieras continuar." : "Resume this optional source whenever you want to continue."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION) {
    return {
      kind: "retry-safe-simulated-step",
      instruction: isEs ? "Reintenta la vista previa segura guardada; no se reutilizará un permiso activo después de un fallo." : "Retry the saved safe preview; an active permission is never reused after a failure."
    };
  }
  if (entry.state === SOURCE_STATUS_STATES.UNSUPPORTED) {
    return {
      kind: "choose-supported-safe-path",
      instruction: wording(language).unsupportedSafe
    };
  }
  return null;
}

function normalizePreview(result, sourceId, now, language) {
  assertNoSourceBody(result, "metadata preview");
  if (!result || typeof result !== "object" || result.sourceId !== sourceId || result.simulated !== true || result.metadataOnly !== true || result.contentBodiesRead !== false) {
    throw new SourceStatusError(
      "METADATA_PREVIEW_INVALID",
      "I could not confirm a metadata-only simulated export preview, so I stopped before asking for content permission."
    );
  }
  if (!Array.isArray(result.items) || result.items.length > MAX_PREVIEW_ITEMS) {
    throw new SourceStatusError("METADATA_PREVIEW_INVALID", "The simulated export preview did not contain a safe bounded item list, so I stopped before asking for permission.");
  }
  const items = result.items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new SourceStatusError("METADATA_PREVIEW_INVALID", "The simulated export preview contained an invalid item, so I stopped safely.");
    }
    return {
      id: opaqueId(item.id, "Simulated export preview item id"),
      // Never preserve an adapter title in status state: it can contain PII or
      // prompt-injection text. A deterministic ordinal still supports consent.
      label: `Export item ${index + 1}`,
      category: typeof item.category === "string" && /^[a-z][a-z0-9-]{0,31}$/i.test(item.category) ? item.category : "general"
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SourceStatusError("METADATA_PREVIEW_INVALID", "The simulated export preview contained ambiguous item identifiers, so I stopped safely.");
  }
  return {
    previewedAt: now,
    itemCount: items.length,
    items,
    message: wording(language).metadataOnly
  };
}

function requireEntry(records, sourceId) {
  const entry = records.entries[sourceId];
  if (!entry) {
    throw new SourceStatusError("SOURCE_STATUS_NOT_STARTED", "Start a metadata-only simulated export preview first, then I can show the next safe step.");
  }
  return entry;
}

function extractPermissionScope({ scope, selectedItemIds }) {
  if (scope === undefined) {
    return { selectedItemIds, acknowledgements: null };
  }
  assertAllowedKeys(scope, ["selectedItemIds", "acknowledgements"], "The granular permission scope");
  if (selectedItemIds !== undefined) {
    throw new SourceStatusError("SOURCE_STATUS_INPUT_INVALID", "Provide the selected export items either in the granular scope or as selectedItemIds, not both.");
  }
  return scope;
}

function normalizePermissionScope(input, entry) {
  assertAllowedKeys(input, ["selectedItemIds", "acknowledgements"], "The granular permission scope");
  const selectedItemIds = uniqueOpaqueIds(input.selectedItemIds, "this permission");
  const previewed = new Set(entry.metadataPreview?.items.map((item) => item.id) ?? []);
  if (selectedItemIds.some((id) => !previewed.has(id))) {
    throw new SourceStatusError("SCOPE_EXPANSION_BLOCKED", "One or more selected export items were not in the metadata-only preview, so I kept access denied.");
  }
  assertAllowedKeys(input.acknowledgements, ["metadataOnlyPreview", "untrustedSourceMaterial", "simulatedSnapshot"], "The permission acknowledgements");
  if (input.acknowledgements.metadataOnlyPreview !== true || input.acknowledgements.untrustedSourceMaterial !== true || input.acknowledgements.simulatedSnapshot !== true) {
    throw new SourceStatusError(
      "PERMISSION_ACKNOWLEDGEMENTS_REQUIRED",
      "Before granting this scope, confirm that you reviewed metadata only, that exports are untrusted reference material, and that this is a simulated snapshot—not a live connection."
    );
  }
  return {
    selectedItemIds,
    acknowledgements: {
      metadataOnlyPreview: true,
      untrustedSourceMaterial: true,
      simulatedSnapshot: true
    }
  };
}

function normalizeSnapshotResult(result, entry) {
  assertNoSourceBody(result, "snapshot import");
  if (!result || typeof result !== "object" || result.simulated !== true || result.sourceBodiesRead !== false || result.rawBodiesReturned !== false || result.snapshotLabel !== "simulated-export-snapshot" || !Array.isArray(result.records)) {
    throw new SourceStatusError("SNAPSHOT_BOUNDARY_INVALID", "The simulated export did not preserve the snapshot-only body boundary, so I stopped before saving or showing any import.");
  }
  const selected = new Set(entry.permission.selectedItemIds);
  const records = result.records.map((record) => {
    if (!record || typeof record !== "object") {
      throw new SourceStatusError("SNAPSHOT_BOUNDARY_INVALID", "The simulated snapshot returned an invalid record, so I stopped safely.");
    }
    const sourceRecordId = opaqueId(record.sourceRecordId, "Simulated snapshot record id");
    const snapshotRecordId = opaqueId(record.snapshotRecordId, "Simulated snapshot reference");
    if (!selected.has(sourceRecordId) || record.source !== entry.sourceId || record.processingDisposition !== "untrusted-inert-snapshot-reference") {
      throw new SourceStatusError("SNAPSHOT_SCOPE_VIOLATION", "The simulated snapshot included an item outside the granular permission, so I stopped before saving it.");
    }
    return {
      source: entry.sourceId,
      snapshotRecordId,
      processingDisposition: "untrusted-inert-snapshot-reference"
    };
  });
  if (new Set(records.map((record) => record.snapshotRecordId)).size !== records.length || records.length !== entry.permission.selectedItemIds.length) {
    throw new SourceStatusError("SNAPSHOT_SCOPE_VIOLATION", "The simulated snapshot did not exactly match the granular permission, so I stopped before saving it.");
  }
  return { snapshotLabel: "simulated-export-snapshot", records };
}

function safeErrorCode(error, fallback) {
  const value = typeof error?.code === "string" ? error.code : fallback;
  return /^[A-Z0-9_:-]{3,80}$/.test(value) ? value : fallback;
}

async function revokeAdapterPermission(adapter, grantId) {
  if (!adapter || typeof adapter.revokeSnapshotPermission !== "function") return false;
  const result = await adapter.revokeSnapshotPermission({ grantId });
  return result?.status === "revoked";
}

/** Creates a safe default scope that callers must explicitly acknowledge before granting. */
export function buildSimulatedExportPermissionScope({ metadataPreview, selectedItemIds } = {}) {
  const preview = metadataPreview?.items ?? metadataPreview?.metadataPreview?.items;
  const allowed = new Set((Array.isArray(preview) ? preview : []).map((item) => item?.id).filter((id) => typeof id === "string"));
  const selected = Array.isArray(selectedItemIds) ? selectedItemIds.filter((id) => allowed.has(id)) : [];
  return {
    selectedItemIds: [...new Set(selected)],
    acknowledgements: {
      metadataOnlyPreview: false,
      untrustedSourceMaterial: false,
      simulatedSnapshot: false
    }
  };
}

/**
 * Starts (or safely retries) a metadata-only simulated generic-export preview.
 * The adapter is required to return no source body fields; no real connector is
 * accepted by this API.
 */
export async function beginSimulatedExportPreview({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  language,
  clock,
  reviewIdFactory
} = {}) {
  assertNaturalLanguage(message, "start");
  assertSourceId(sourceId);
  if (!adapter || adapter.isSimulation !== true || typeof adapter.previewMetadata !== "function") {
    throw new TypeError("A simulated generic-export adapter with previewMetadata() is required. Real source adapters are not accepted here.");
  }
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const safeLanguage = languageFor(state, language);
  let entry = records.entries[sourceId];
  if (entry?.state === SOURCE_STATUS_STATES.SKIPPED || entry?.state === SOURCE_STATUS_STATES.UNSUPPORTED) {
    return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
  }
  if (entry?.state === SOURCE_STATUS_STATES.AWAITING_GRANT || entry?.state === SOURCE_STATUS_STATES.READY_TO_IMPORT || entry?.state === SOURCE_STATUS_STATES.IMPORTED) {
    return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
  }
  const now = isoNow(clock);
  if (!entry || entry.state === SOURCE_STATUS_STATES.REVOKED || entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION) {
    const previousAudit = entry?.audit ?? [];
    entry = defaultEntry(sourceId, now);
    entry.audit.unshift(...previousAudit, { type: "fresh-simulated-preview-started", at: now, sourceBodiesRead: false });
    records.entries[sourceId] = entry;
  }
  try {
    const preview = normalizePreview(await adapter.previewMetadata({ sourceId }), sourceId, now, safeLanguage);
    entry.metadataPreview = { ...preview, reviewId: (reviewIdFactory ?? (() => `simulated-export-review-${randomUUID()}`))() };
    entry.state = SOURCE_STATUS_STATES.AWAITING_GRANT;
    entry.resumeState = SOURCE_STATUS_STATES.AWAITING_GRANT;
    entry.permission = { status: "none", reviewId: entry.metadataPreview.reviewId, grantId: null, selectedItemIds: [], grantedAt: null, revokedAt: null };
    entry.snapshotImport = { status: "not-started", snapshotLabel: null, importedAt: null, records: [] };
    entry.lastSafeError = null;
    entry.audit.push({ type: "metadata-only-simulated-export-preview", at: now, reviewId: entry.metadataPreview.reviewId, itemCount: preview.itemCount, sourceBodiesRead: false });
    records.audit.push({ type: "metadata-only-simulated-export-preview", at: now, sourceId, sourceBodiesRead: false });
  } catch (error) {
    entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    entry.lastSafeError = { code: safeErrorCode(error, "SIMULATED_EXPORT_PREVIEW_FAILED"), stage: "metadata-preview", at: now, sourceBodiesRead: false };
    entry.audit.push({ type: "simulated-export-preview-paused", at: now, code: entry.lastSafeError.code, sourceBodiesRead: false });
    records.audit.push({ type: "simulated-export-preview-paused", at: now, sourceId, sourceBodiesRead: false });
  }
  await stateStore.save(state);
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

/** Saves a granular, one-time simulated-export permission; it never imports. */
export async function grantSimulatedExportPermission({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  reviewId,
  scope,
  selectedItemIds,
  language,
  clock,
  grantIdFactory
} = {}) {
  assertNaturalLanguage(message, "grant");
  assertSourceId(sourceId);
  if (!adapter || adapter.isSimulation !== true || typeof adapter.registerSnapshotPermission !== "function") {
    throw new TypeError("A simulated generic-export adapter with registerSnapshotPermission() is required.");
  }
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const entry = requireEntry(records, sourceId);
  const safeLanguage = languageFor(state, language);
  if (![SOURCE_STATUS_STATES.AWAITING_GRANT, SOURCE_STATUS_STATES.NEEDS_ATTENTION].includes(entry.state) || !entry.metadataPreview || entry.permission.reviewId !== reviewId) {
    throw new SourceStatusError("STALE_SIMULATED_EXPORT_REVIEW", "That simulated export review is not ready. Start or use the current metadata-only preview before approving anything.");
  }
  if (entry.permission.status === "active") {
    return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
  }
  const normalizedScope = normalizePermissionScope(extractPermissionScope({ scope, selectedItemIds }), entry);
  const now = isoNow(clock);
  const grant = {
    id: (grantIdFactory ?? (() => `simulated-export-grant-${randomUUID()}`))(),
    status: "active",
    sourceId,
    reviewId,
    approvedAt: now,
    scope: normalizedScope
  };
  opaqueId(grant.id, "Simulated export grant id");
  try {
    await adapter.registerSnapshotPermission({ grant: clone(grant) });
  } catch (error) {
    // A connector could fail after accepting a request. Revoke the candidate
    // grant best-effort and keep the persisted state deny-by-default either
    // way; a retry always starts from the saved metadata review.
    await revokeAdapterPermission(adapter, grant.id).catch(() => false);
    entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    entry.lastSafeError = { code: safeErrorCode(error, "SIMULATED_EXPORT_GRANT_FAILED"), stage: "permission-grant", at: now, sourceBodiesRead: false };
    entry.audit.push({ type: "simulated-export-grant-paused", at: now, code: entry.lastSafeError.code, sourceBodiesRead: false });
    await stateStore.save(state);
    return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
  }
  entry.permission = {
    status: "active",
    reviewId,
    grantId: grant.id,
    selectedItemIds: normalizedScope.selectedItemIds,
    grantedAt: now,
    revokedAt: null
  };
  entry.state = SOURCE_STATUS_STATES.READY_TO_IMPORT;
  entry.resumeState = SOURCE_STATUS_STATES.READY_TO_IMPORT;
  entry.lastSafeError = null;
  entry.audit.push({ type: "simulated-export-granular-permission-granted", at: now, reviewId, grantId: grant.id, selectedItemCount: normalizedScope.selectedItemIds.length, sourceBodiesRead: false });
  records.audit.push({ type: "simulated-export-granular-permission-granted", at: now, sourceId, reviewId, grantId: grant.id, sourceBodiesRead: false });
  await stateStore.save(state);
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

/** Imports exactly the approved opaque snapshot references, then closes the one-time permission. */
export async function importSimulatedExportSnapshot({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  reviewId,
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "import");
  assertSourceId(sourceId);
  if (!adapter || adapter.isSimulation !== true || typeof adapter.importApprovedSnapshot !== "function") {
    throw new TypeError("A simulated generic-export adapter with importApprovedSnapshot() is required.");
  }
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const entry = requireEntry(records, sourceId);
  const safeLanguage = languageFor(state, language);
  if (entry.state !== SOURCE_STATUS_STATES.READY_TO_IMPORT || entry.permission.status !== "active" || entry.permission.reviewId !== reviewId) {
    throw new SourceStatusError("SIMULATED_EXPORT_GRANT_REQUIRED", "No simulated snapshot was imported because there is no active granular permission for this current review.");
  }
  const now = isoNow(clock);
  const grant = {
    id: entry.permission.grantId,
    status: "active",
    sourceId,
    reviewId,
    scope: { selectedItemIds: clone(entry.permission.selectedItemIds) }
  };
  entry.state = SOURCE_STATUS_STATES.IMPORTING;
  entry.snapshotImport.status = "importing";
  entry.audit.push({ type: "simulated-snapshot-import-started", at: now, reviewId, grantId: grant.id, sourceBodiesRead: false });
  await stateStore.save(state);
  let normalized;
  try {
    normalized = normalizeSnapshotResult(await adapter.importApprovedSnapshot({ sourceId, grant: clone(grant) }), entry);
  } catch (error) {
    const refreshed = await loadState(stateStore);
    const refreshedEntry = requireEntry(rootLifecycle(refreshed), sourceId);
    const failedAt = isoNow(clock);
    await revokeAdapterPermission(adapter, refreshedEntry.permission.grantId).catch(() => false);
    refreshedEntry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
    refreshedEntry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
    refreshedEntry.permission.status = "revoked-after-failure";
    refreshedEntry.permission.revokedAt = failedAt;
    refreshedEntry.snapshotImport.status = "failed-safely";
    refreshedEntry.lastSafeError = { code: safeErrorCode(error, "SIMULATED_EXPORT_IMPORT_FAILED"), stage: "snapshot-import", at: failedAt, sourceBodiesRead: false };
    refreshedEntry.audit.push({ type: "simulated-snapshot-import-paused", at: failedAt, code: refreshedEntry.lastSafeError.code, permissionInvalidated: true, sourceBodiesRead: false });
    await stateStore.save(refreshed);
    return { sourceStatus: publicSourceStatus(refreshedEntry, languageFor(refreshed, language)), snapshotRecords: [] };
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = requireEntry(rootLifecycle(refreshed), sourceId);
  const importedAt = isoNow(clock);
  const revoked = await revokeAdapterPermission(adapter, refreshedEntry.permission.grantId).catch(() => false);
  refreshedEntry.snapshotImport = {
    status: "imported",
    snapshotLabel: normalized.snapshotLabel,
    importedAt,
    records: normalized.records
  };
  refreshedEntry.permission.status = revoked ? "consumed-and-revoked" : "revocation-unconfirmed";
  refreshedEntry.permission.revokedAt = revoked ? importedAt : null;
  refreshedEntry.state = revoked ? SOURCE_STATUS_STATES.IMPORTED : SOURCE_STATUS_STATES.NEEDS_ATTENTION;
  refreshedEntry.resumeState = revoked ? SOURCE_STATUS_STATES.IMPORTED : SOURCE_STATUS_STATES.NOT_STARTED;
  refreshedEntry.lastSafeError = revoked ? null : { code: "SIMULATED_EXPORT_REVOCATION_UNCONFIRMED", stage: "post-import-revocation", at: importedAt, sourceBodiesRead: false };
  refreshedEntry.audit.push({ type: "simulated-snapshot-imported", at: importedAt, recordCount: normalized.records.length, oneTimePermissionClosed: revoked, sourceBodiesRead: false });
  await stateStore.save(refreshed);
  return {
    sourceStatus: publicSourceStatus(refreshedEntry, languageFor(refreshed, language)),
    snapshotRecords: normalized.records.map((record) => ({ ...record }))
  };
}

/** Revokes a saved simulated-export permission. It never writes to a source. */
export async function revokeSimulatedExportPermission({
  message,
  stateStore,
  adapter,
  sourceId = "simulated-export",
  reviewId,
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "revoke");
  assertSourceId(sourceId);
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const entry = requireEntry(records, sourceId);
  const safeLanguage = languageFor(state, language);
  if (entry.permission.reviewId !== reviewId) {
    throw new SourceStatusError("STALE_SIMULATED_EXPORT_REVIEW", "That earlier review cannot revoke or change the current source state.");
  }
  if (entry.state === SOURCE_STATUS_STATES.REVOKED) return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
  if (entry.permission.status === "active") {
    if (!adapter || adapter.isSimulation !== true || typeof adapter.revokeSnapshotPermission !== "function") {
      throw new TypeError("A simulated generic-export adapter with revokeSnapshotPermission() is required to revoke an active permission.");
    }
    const revoked = await revokeAdapterPermission(adapter, entry.permission.grantId).catch(() => false);
    if (!revoked) {
      entry.state = SOURCE_STATUS_STATES.NEEDS_ATTENTION;
      entry.lastSafeError = { code: "SIMULATED_EXPORT_REVOCATION_UNCONFIRMED", stage: "permission-revocation", at: isoNow(clock), sourceBodiesRead: false };
      entry.audit.push({ type: "simulated-export-revocation-unconfirmed", at: entry.lastSafeError.at, sourceBodiesRead: false });
      await stateStore.save(state);
      return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
    }
  }
  const now = isoNow(clock);
  entry.permission.status = "revoked";
  entry.permission.revokedAt = now;
  entry.state = SOURCE_STATUS_STATES.REVOKED;
  entry.resumeState = SOURCE_STATUS_STATES.NOT_STARTED;
  entry.lastSafeError = null;
  entry.audit.push({ type: "simulated-export-permission-revoked", at: now, reviewId, sourceBodiesRead: false });
  records.audit.push({ type: "simulated-export-permission-revoked", at: now, sourceId, reviewId, sourceBodiesRead: false });
  await stateStore.save(state);
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

/** Skips an optional source only while it has no active permission. */
export async function skipOptionalSource({
  message,
  stateStore,
  sourceId = "simulated-export",
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "skip");
  assertSourceId(sourceId);
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const safeLanguage = languageFor(state, language);
  const now = isoNow(clock);
  let entry = records.entries[sourceId];
  if (!entry) {
    entry = defaultEntry(sourceId, now);
    records.entries[sourceId] = entry;
  }
  if (entry.permission.status === "active") {
    throw new SourceStatusError("REVOKE_REQUIRED_BEFORE_SKIP", "This source has an active granular permission. Revoke it explicitly before skipping so access is not left enabled.");
  }
  if (entry.state === SOURCE_STATUS_STATES.IMPORTED || entry.state === SOURCE_STATUS_STATES.REVOKED || entry.state === SOURCE_STATUS_STATES.UNSUPPORTED) {
    throw new SourceStatusError("SOURCE_STATE_FINAL", "This source is already in a final state. Start a fresh simulated preview if you want to begin again.");
  }
  if (entry.state !== SOURCE_STATUS_STATES.SKIPPED) {
    entry.resumeState = entry.state === SOURCE_STATUS_STATES.NEEDS_ATTENTION ? SOURCE_STATUS_STATES.NOT_STARTED : entry.state;
    entry.state = SOURCE_STATUS_STATES.SKIPPED;
    entry.audit.push({ type: "optional-source-skipped", at: now, resumeState: entry.resumeState, sourceBodiesRead: false });
    records.audit.push({ type: "optional-source-skipped", at: now, sourceId, sourceBodiesRead: false });
    await stateStore.save(state);
  }
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

/** Restores only the previously saved optional state; it never restores a grant. */
export async function resumeOptionalSource({
  message,
  stateStore,
  sourceId = "simulated-export",
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "resume");
  assertSourceId(sourceId);
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const entry = requireEntry(records, sourceId);
  const safeLanguage = languageFor(state, language);
  if (entry.state !== SOURCE_STATUS_STATES.SKIPPED) {
    throw new SourceStatusError("SOURCE_NOT_SKIPPED", "This source is not currently skipped, so there is no saved optional source state to resume.");
  }
  const next = ALL_STATES.has(entry.resumeState) && !FINAL_STATES.has(entry.resumeState)
    ? entry.resumeState
    : SOURCE_STATUS_STATES.NOT_STARTED;
  entry.state = next;
  entry.audit.push({ type: "optional-source-resumed", at: isoNow(clock), restoredState: next, sourceBodiesRead: false });
  records.audit.push({ type: "optional-source-resumed", at: isoNow(clock), sourceId, restoredState: next, sourceBodiesRead: false });
  await stateStore.save(state);
  return { sourceStatus: publicSourceStatus(entry, safeLanguage) };
}

/** Records an honest unsupported state without attempting an adapter connection. */
export async function explainUnsupportedSource({
  message,
  stateStore,
  requestedSource,
  language,
  clock
} = {}) {
  assertNaturalLanguage(message, "unsupported");
  const state = await loadState(stateStore);
  const records = rootLifecycle(state);
  const sourceId = unsupportedSourceId(requestedSource);
  const now = isoNow(clock);
  if (!records.entries[sourceId]) {
    records.entries[sourceId] = {
      ...defaultEntry(sourceId, now),
      adapter: "unsupported-safe-explanation",
      state: SOURCE_STATUS_STATES.UNSUPPORTED,
      resumeState: SOURCE_STATUS_STATES.NOT_STARTED,
      audit: [{ type: "unsupported-source-explained-without-connection", at: now, sourceBodiesRead: false, realConnectionAttempted: false }]
    };
    records.audit.push({ type: "unsupported-source-explained-without-connection", at: now, sourceId, sourceBodiesRead: false });
    await stateStore.save(state);
  }
  return { sourceStatus: publicSourceStatus(records.entries[sourceId], languageFor(state, language)) };
}

/** Read-only lookup. It never invokes an adapter. */
export async function getSourceStatus({ stateStore, sourceId = "simulated-export", language } = {}) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state?.[STATE_KEY]) return null;
  const entry = Object.hasOwn(state[STATE_KEY].entries ?? {}, sourceId)
    ? state[STATE_KEY].entries[sourceId]
    : null;
  return entry ? { sourceStatus: publicSourceStatus(entry, languageFor(state, language)) } : null;
}

function normalizeAdapterName(adapter) {
  const normalized = typeof adapter === "string" ? adapter.trim().toLowerCase() : "";
  if (["gmail", "gmail-readonly"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GMAIL;
  if (["drive", "google-drive", "google-drive-folder-scope"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE;
  if (["imessage", "imessage-beta", "i-message"].includes(normalized)) return SOURCE_ADAPTER_NAMES.IMESSAGE;
  if (["simulated-export", "simulated-generic-export", "generic-export"].includes(normalized)) return SOURCE_ADAPTER_NAMES.GENERIC_EXPORT;
  return "unsupported-safe-explanation";
}

function reportedStatusValue(adapterStatus) {
  const value = typeof adapterStatus === "string"
    ? adapterStatus
    : typeof adapterStatus?.status === "string"
      ? adapterStatus.status
      : null;
  // Status text is adapter-controlled input. Preserve only a compact state
  // token; never reflect an arbitrary provider error or source-derived text.
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function stateForAdapter(adapter, reported) {
  const maps = {
    [SOURCE_ADAPTER_NAMES.GMAIL]: {
      "selected-but-unfinished": SOURCE_STATUS_STATES.NOT_STARTED,
      "awaiting-privacy-review": SOURCE_STATUS_STATES.AWAITING_GRANT,
      "ready-to-verify": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      importing: SOURCE_STATUS_STATES.IMPORTING,
      imported: SOURCE_STATUS_STATES.IMPORTED,
      skipped: SOURCE_STATUS_STATES.SKIPPED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      unsupported: SOURCE_STATUS_STATES.UNSUPPORTED,
      "needs-attention": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      // A reported live state alone is intentionally not treated as proof.
      "live-and-verified": SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE]: {
      "awaiting-authorization": SOURCE_STATUS_STATES.NOT_STARTED,
      "awaiting-folder-review": SOURCE_STATUS_STATES.AWAITING_GRANT,
      "ready-to-fetch": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      importing: SOURCE_STATUS_STATES.IMPORTING,
      imported: SOURCE_STATUS_STATES.IMPORTED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      "authorization-unavailable": SOURCE_STATUS_STATES.NEEDS_ATTENTION,
      "authorization-denied": SOURCE_STATUS_STATES.SKIPPED,
      "authorization-cancelled": SOURCE_STATUS_STATES.SKIPPED,
      "needs-attention": SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.IMESSAGE]: {
      "awaiting-macos-permission": SOURCE_STATUS_STATES.NOT_STARTED,
      "snapshot-available": SOURCE_STATUS_STATES.NOT_STARTED,
      "awaiting-content-grant": SOURCE_STATUS_STATES.AWAITING_GRANT,
      "ready-to-process": SOURCE_STATUS_STATES.READY_TO_IMPORT,
      processed: SOURCE_STATUS_STATES.IMPORTED,
      revoked: SOURCE_STATUS_STATES.REVOKED,
      unsupported: SOURCE_STATUS_STATES.UNSUPPORTED,
      "needs-attention": SOURCE_STATUS_STATES.NEEDS_ATTENTION
    },
    [SOURCE_ADAPTER_NAMES.GENERIC_EXPORT]: Object.fromEntries(Object.values(SOURCE_STATUS_STATES).map((state) => [state, state]))
  };
  return maps[adapter]?.[reported] ?? SOURCE_STATUS_STATES.NEEDS_ATTENTION;
}

function isKnownAdapterStatus(adapter, reported) {
  const known = {
    [SOURCE_ADAPTER_NAMES.GMAIL]: ["selected-but-unfinished", "awaiting-privacy-review", "ready-to-verify", "importing", "imported", "skipped", "revoked", "unsupported", "needs-attention", "live-and-verified"],
    [SOURCE_ADAPTER_NAMES.GOOGLE_DRIVE]: ["awaiting-authorization", "awaiting-folder-review", "ready-to-fetch", "importing", "imported", "revoked", "authorization-unavailable", "authorization-denied", "authorization-cancelled", "needs-attention"],
    [SOURCE_ADAPTER_NAMES.IMESSAGE]: ["awaiting-macos-permission", "snapshot-available", "awaiting-content-grant", "ready-to-process", "processed", "revoked", "unsupported", "needs-attention"],
    [SOURCE_ADAPTER_NAMES.GENERIC_EXPORT]: Object.values(SOURCE_STATUS_STATES)
  };
  return known[adapter]?.includes(reported) ?? false;
}

/**
 * Normalizes an already-returned adapter status into the shared vocabulary.
 * This helper is deliberately pure: it does not invoke an adapter or trust a
 * claimed `live: true` field as independent verification.
 */
export function normalizeAdapterSourceStatus({ sourceId, adapter, adapterStatus, language = "en" } = {}) {
  const normalizedAdapter = normalizeAdapterName(adapter);
  const candidate = reportedStatusValue(adapterStatus);
  // Treat unknown provider status text as an opaque failure, not displayable
  // metadata. This avoids reflecting hostile or source-derived text.
  const reported = isKnownAdapterStatus(normalizedAdapter, candidate) ? candidate : null;
  const safeSourceId = typeof sourceId === "string" && /^[a-z][a-z0-9._:-]{0,127}$/i.test(sourceId)
    ? sourceId
    : "adapter-status";
  const state = normalizedAdapter === "unsupported-safe-explanation"
    ? SOURCE_STATUS_STATES.UNSUPPORTED
    : stateForAdapter(normalizedAdapter, reported);
  const entry = {
    ...defaultEntry(safeSourceId, "1970-01-01T00:00:00.000Z"),
    adapter: normalizedAdapter,
    state,
    resumeState: state,
    audit: [{ type: "adapter-status-normalized-without-connection", at: "1970-01-01T00:00:00.000Z", reportedState: reported, sourceBodiesRead: false }]
  };
  return publicSourceStatus(entry, language === "es" ? "es" : "en", { adapterReportedState: reported, external: true });
}

function normalizeLiveVerificationEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  const seen = new Set();
  return evidence.flatMap((item) => {
    if (!item || typeof item !== "object" || item.simulated === true || item.live !== true || item.readOnly !== true || item.verificationMethod !== "independent-live-readback") return [];
    if (typeof item.sourceId !== "string" || item.sourceId.startsWith("simulated-export") || !/^[a-z][a-z0-9._:-]{0,127}$/i.test(item.sourceId)) return [];
    if (typeof item.connectorId !== "string" || !OPAQUE_ID.test(item.connectorId)) return [];
    if (typeof item.verificationReference !== "string" || !OPAQUE_ID.test(item.verificationReference)) return [];
    const verifiedAt = new Date(item.verifiedAt);
    if (!Number.isFinite(verifiedAt.getTime())) return [];
    const key = `${item.sourceId}:${item.connectorId}:${item.verificationReference}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      sourceId: item.sourceId,
      connectorId: item.connectorId,
      readOnly: true,
      verificationMethod: "independent-live-readback",
      verificationReference: item.verificationReference,
      verifiedAt: verifiedAt.toISOString()
    }];
  });
}

function releaseGate(language, evidence) {
  const verifiedLiveConnectors = normalizeLiveVerificationEvidence(evidence);
  const satisfied = verifiedLiveConnectors.length > 0;
  return {
    ...LIVE_CONNECTOR_RELEASE_GATE,
    status: satisfied ? "satisfied-with-external-evidence" : "unsatisfied",
    satisfied,
    verifiedLiveConnectors,
    message: satisfied ? wording(language).releaseGateSatisfied : wording(language).releaseGateUnsatisfied,
    note: "This status layer does not create, infer, or verify live evidence. A simulated export and an adapter-reported status cannot satisfy this gate."
  };
}

/**
 * Final customer handoff: cleanly separates unfinished, skipped, imported,
 * revoked, and unsupported sources. It does not invoke adapters, and it keeps
 * the live-connector release requirement blocked unless externally structured
 * independent evidence is actually supplied.
 */
export async function getSourceStatusHandoff({
  stateStore,
  language,
  adapterStatuses = [],
  verifiedLiveConnectorEvidence = []
} = {}) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  const safeLanguage = languageFor(state, language);
  const entries = Object.values(state?.[STATE_KEY]?.entries ?? {}).map((entry) => publicSourceStatus(entry, safeLanguage));
  const external = (Array.isArray(adapterStatuses) ? adapterStatuses : []).map((snapshot) => normalizeAdapterSourceStatus({
    sourceId: snapshot?.sourceId,
    adapter: snapshot?.adapter,
    adapterStatus: snapshot?.adapterStatus,
    language: safeLanguage
  }));
  const sourceById = new Map();
  for (const item of [...entries, ...external]) sourceById.set(item.source.id, item);
  const sources = [...sourceById.values()].sort((a, b) => a.source.id.localeCompare(b.source.id));
  const sections = Object.fromEntries(Object.values(SOURCE_HANDOFF_CATEGORIES).map((category) => [category, []]));
  for (const source of sources) sections[source.handoffCategory].push(source);
  return {
    sourceStatusHandoff: {
      vocabulary: {
        states: Object.values(SOURCE_STATUS_STATES),
        finalCategories: Object.values(SOURCE_HANDOFF_CATEGORIES),
        explanation: "A source is never presented as live merely because an adapter reports a connection-like state."
      },
      releaseGate: releaseGate(safeLanguage, verifiedLiveConnectorEvidence),
      sections,
      sources
    }
  };
}
