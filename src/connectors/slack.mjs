/**
 * QWA-148 Slack setup lifecycle.
 *
 * The public Setup Session owns the customer conversation and invokes an
 * injected official-plugin seam only after explicit approval. This vertical
 * slice is deliberately simulation-only: `live` is always false, and source
 * records remain opaque stable references outside the injected adapter.
 */

import { randomUUID } from "node:crypto";

import {
  PermissionLifecycleError,
  beginSourcePermissionReview,
  fetchApprovedSourceContent,
  getSourcePermissionStatus,
  grantSourcePermission,
  revokeSourcePermission
} from "../permissions/setup-source-permissions.mjs";

const SOURCE = "slack";
const STATE_KEY = "slackLifecycle";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WRITE_CAPABILITIES = Object.freeze([
  "canPost",
  "canReact",
  "canEdit",
  "canArchive",
  "canInvite",
  "canChangeWorkspaceState"
]);

export class SlackLifecycleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "SlackLifecycleError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new SlackLifecycleError("SLACK_MESSAGE_REQUIRED", "Tell me in normal language whether you want to connect or review Slack.");
  }
  if (message.trim().startsWith("/")) {
    throw new SlackLifecycleError("NO_SLASH_COMMANDS", "You do not need a command. Tell me what you want to do with Slack in normal language.");
  }
}

function assertOpaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new SlackLifecycleError("SLACK_IDENTIFIER_INVALID", `I could not safely identify the ${field}, so I kept Slack access unchanged.`);
  }
  return value;
}

function languageFor(state, requestedLanguage) {
  return requestedLanguage === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function copy(language) {
  if (language === "es") {
    return {
      start: "Slack está seleccionado pero sin terminar. Esta prueba usa un punto de conexión simulado para el plugin oficial de Slack; no ha conectado un espacio de trabajo real ni leído mensajes.",
      awaitingAuthorization: "Para continuar, aprueba abrir el flujo de autorización de solo lectura del plugin oficial de Slack. No revisaré metadatos ni contenido hasta que lo apruebes.",
      verified: "El punto de conexión simulado verificó una conexión de solo lectura. No puede publicar, reaccionar, editar, archivar, invitar ni cambiar Slack. Ahora revisaré únicamente metadatos para que elijas canales, mensajes directos, grupos, personas y fechas.",
      metadataReady: "Revisé únicamente metadatos de Slack. No he leído ningún cuerpo de mensaje. Revisa el alcance antes de aprobar contenido.",
      ready: "El permiso limitado está listo. Solo puedo procesar referencias de hilos aprobadas y opacas; Slack permanece de solo lectura.",
      processed: "Procesé solo referencias de hilos aprobadas y opacas. Esta prueba no demuestra una conexión de Slack en vivo.",
      skipped: "No se concedió autorización de Slack. Se marcó como omitido y no se revisaron metadatos ni mensajes.",
      needsAttention: "Slack necesita atención antes de continuar. Detuve la revisión de forma segura y no procesé ningún cuerpo de mensaje. Puedes reintentar el paso guardado.",
      revoked: "El acceso de Slack fue revocado. Dejé de procesar la fuente y no afirmaré que está conectada. Inicia una revisión nueva si vuelves a autorizarla.",
      privateChannels: "Los canales privados se excluyen por defecto en esta revisión y no se muestran sus nombres ni identificadores.",
      blockedGroups: "Los grupos con una persona bloqueada se omiten por defecto. Requieren una revisión separada y limitada antes de que puedan incluirse.",
      groupReview: "Este grupo contiene una persona bloqueada. Puedes revisarlo por separado; no se incluirá hasta una confirmación explícita para este único grupo.",
      groupApproved: "La excepción limitada para ese único grupo se guardó. Sigue siendo de solo lectura y no amplía otros grupos ni personas bloqueadas.",
      readOnly: "La verificación y esta fuente son solo de lectura: no pueden publicar, reaccionar, editar, archivar, invitar ni cambiar Slack."
    };
  }
  return {
    start: "Slack is selected but unfinished. This proof uses a simulated official Slack-plugin seam; it has not connected a real workspace or read any messages.",
    awaitingAuthorization: "To continue, approve opening the official Slack plugin's read-only authorization flow. I will not review metadata or content until you approve it.",
    verified: "The simulated seam verified a read-only connection. It cannot post, react, edit, archive, invite, or change Slack. I can now review metadata only so you can choose channels, direct messages, groups, people, and dates.",
    metadataReady: "I reviewed Slack metadata only. I have not read any message body. Review the scope before approving content.",
    ready: "The narrowed permission is ready. I can process only approved opaque thread references; Slack remains read-only.",
    processed: "I processed only approved opaque thread references. This proof does not demonstrate a live Slack connection.",
    skipped: "Slack authorization was not granted. It is marked skipped, and no metadata or message was reviewed.",
    needsAttention: "Slack needs attention before it can continue. I stopped the review safely and did not process any message body. You can retry the saved step.",
    revoked: "Slack access was revoked. I stopped processing the source and will not claim it is connected. Start a new review if you authorize it again.",
    privateChannels: "Private channels are excluded by default from this review, and their names and identifiers are not shown.",
    blockedGroups: "Groups with a blocked person are skipped by default. They need a separate, narrow review before one group can be included.",
    groupReview: "This group includes a blocked person. You can review it separately; it will not be included until an explicit confirmation for this one group.",
    groupApproved: "The narrow exception for that one group is saved. It remains read-only and does not expand other groups or blocked people.",
    readOnly: "The verification and this source are read-only: they cannot post, react, edit, archive, invite, or change Slack."
  };
}

function entryKey(accountId) {
  return `${SOURCE}:${encodeURIComponent(assertOpaqueId(accountId, "Slack workspace"))}`;
}

function lifecycle(state) {
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = { version: 1, entries: {}, audit: [] };
  }
  return state[STATE_KEY];
}

function requireSetup(state) {
  if (!state || typeof state !== "object" || typeof state.status !== "string") {
    throw new SlackLifecycleError("SETUP_SESSION_NOT_FOUND", "Start your second-brain setup first, then I can guide Slack in this same conversation.");
  }
}

function newEntry(accountId, now, priorAudit = []) {
  return {
    source: SOURCE,
    accountId,
    status: "selected-but-unfinished",
    phase: "awaiting-plugin-authorization",
    pluginAuthorization: { status: "not-started", attempts: 0, authorizedAt: null },
    verification: { status: "not-run", verifiedAt: null, readOnly: false },
    metadata: {
      pagination: { status: "not-started", pagesReviewed: 0, pagesExpected: 0 },
      privateChannels: { status: "excluded-by-default", count: 0 }
    },
    reviewId: null,
    blockedGroupReviews: {},
    audit: [...priorAudit, { type: "slack-official-plugin-offered", at: now }]
  };
}

function assertEntry(state, accountId) {
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) {
    throw new SlackLifecycleError("SLACK_NOT_STARTED", "Tell me you would like to connect Slack first, and I will guide the read-only plugin path.");
  }
  return entry;
}

function assertPlugin(plugin) {
  const required = [
    "requestOfficialPluginAuthorization",
    "verifyReadOnlyConnection",
    "discoverMetadata",
    "fetchApprovedContent",
    "registerPermissionGrant",
    "revokePermissionGrant",
    "getSafeMetadataSummary",
    "setSlackContentPolicy",
    "normalizeStableThreadReferences"
  ];
  if (!plugin || required.some((method) => typeof plugin[method] !== "function")) {
    throw new TypeError("A read-only Slack official-plugin seam with authorization, verification, metadata, grant, and bounded-reference methods is required.");
  }
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function safeMetadataSummary(plugin) {
  let summary;
  try {
    summary = await plugin.getSafeMetadataSummary();
  } catch {
    return {
      unavailable: true,
      pagination: { status: "incomplete", pagesReviewed: 0, pagesExpected: 0 },
      privateChannels: { status: "excluded-by-default", count: 0 }
    };
  }
  const paginationStatus = summary?.pagination?.status === "complete"
    ? "complete"
    : summary?.pagination?.status === "incomplete"
      ? "incomplete"
      : "not-started";
  return {
    unavailable: false,
    pagination: {
      status: paginationStatus,
      pagesReviewed: safeNonNegativeInteger(summary?.pagination?.pagesReviewed),
      pagesExpected: safeNonNegativeInteger(summary?.pagination?.pagesExpected)
    },
    privateChannels: {
      status: "excluded-by-default",
      count: safeNonNegativeInteger(summary?.privateChannels?.count)
    }
  };
}

function publicPermissionReview(permissionReview) {
  if (!permissionReview) return null;
  const safe = clone(permissionReview);
  if (Array.isArray(safe?.metadataPreflight?.blockedGroupConversations)) {
    safe.metadataPreflight.blockedGroupConversations = safe.metadataPreflight.blockedGroupConversations
      .map((conversation) => ({ id: typeof conversation?.id === "string" && OPAQUE_ID.test(conversation.id) ? conversation.id : "unavailable" }));
  }
  // The simulation adapter gives the generic lifecycle only neutral account
  // labels, but remove one anyway so this wrapper cannot become a workspace
  // metadata dump if a future adapter changes its implementation.
  if (safe?.account) safe.account.label = "Selected Slack workspace";
  if (safe?.permissionRequest?.account) safe.permissionRequest.account.label = "Selected Slack workspace";
  return safe;
}

function currentBlockedGroupIds(permissionReview) {
  return new Set((permissionReview?.metadataPreflight?.blockedGroupConversations ?? [])
    .map((conversation) => conversation?.id)
    .filter((value) => typeof value === "string" && OPAQUE_ID.test(value)));
}

function reviewedExceptionSummaries(entry) {
  return Object.values(entry.blockedGroupReviews ?? {})
    .filter((review) => review && typeof review.conversationId === "string" && OPAQUE_ID.test(review.conversationId))
    .map((review) => ({
      conversationId: review.conversationId,
      reviewId: typeof review.id === "string" && OPAQUE_ID.test(review.id) ? review.id : "unavailable",
      status: review.status === "approved" || review.status === "awaiting-customer-confirmation" ? review.status : "unavailable"
    }))
    .sort((left, right) => left.conversationId.localeCompare(right.conversationId));
}

function publicView(entry, language, permissionReview = null) {
  const wording = copy(language);
  let message = wording.start;
  if (entry.status === "skipped") message = wording.skipped;
  else if (entry.status === "needs-attention") message = wording.needsAttention;
  else if (entry.status === "revoked") message = wording.revoked;
  else if (entry.phase === "awaiting-plugin-authorization") message = wording.awaitingAuthorization;
  else if (entry.phase === "metadata-preflight") message = wording.verified;
  else if (entry.phase === "awaiting-content-grant") message = wording.metadataReady;
  else if (entry.phase === "ready-to-process") message = wording.ready;
  else if (entry.phase === "processed-simulated") message = wording.processed;

  const safeReview = publicPermissionReview(permissionReview);
  const blockedGroups = safeReview?.metadataPreflight?.blockedGroupConversations ?? [];
  return {
    source: SOURCE,
    status: entry.status,
    phase: entry.phase,
    message,
    connection: {
      provider: "official-slack-plugin",
      simulationOnly: true,
      live: false,
      readOnly: entry.verification?.readOnly === true,
      verifiedReadOnly: entry.verification?.status === "verified",
      canPost: false,
      canReact: false,
      canEdit: false,
      canArchive: false,
      canInvite: false,
      canChangeWorkspaceState: false,
      message: wording.readOnly
    },
    metadata: {
      pagination: clone(entry.metadata?.pagination ?? { status: "not-started", pagesReviewed: 0, pagesExpected: 0 }),
      privateChannels: {
        ...clone(entry.metadata?.privateChannels ?? { status: "excluded-by-default", count: 0 }),
        message: wording.privateChannels
      }
    },
    privacy: {
      channelBoundary: "independently-enforceable",
      directMessageBoundary: "independently-enforceable",
      groupMessageBoundary: "independently-enforceable",
      peopleBoundary: "independently-enforceable",
      dateBoundary: "independently-enforceable",
      blockedGroupConversations: blockedGroups.map((conversation) => ({ id: conversation.id, status: "skipped-unless-separately-reviewed" })),
      blockedGroupMessage: wording.blockedGroups,
      blockedGroupReviews: reviewedExceptionSummaries(entry)
    },
    permissionReview: safeReview,
    audit: clone(entry.audit)
  };
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  requireSetup(state);
  return state;
}

function noWriteVerification(verification) {
  return verification?.status === "verified"
    && verification.readOnly === true
    && WRITE_CAPABILITIES.every((capability) => verification.operations?.[capability] === false);
}

function statusFromAuthorization(status) {
  if (status === "denied") return { status: "skipped", phase: "authorization-denied" };
  if (status === "revoked") return { status: "revoked", phase: "access-revoked" };
  return { status: "needs-attention", phase: "authorization-unavailable" };
}

async function permissionStatus(stateStore, accountId, language) {
  return getSourcePermissionStatus({ stateStore, source: SOURCE, accountId, language });
}

/** Begins the customer-visible, ordinary-language Slack choice in Setup Session. */
export async function beginSlackConnection({ message, stateStore, accountId = "slack-workspace", language, clock }) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  const state = await loadState(stateStore);
  const records = lifecycle(state);
  const key = entryKey(accountId);
  const existing = records.entries[key];
  if (!existing) {
    records.entries[key] = newEntry(accountId, isoNow(clock));
    records.audit.push({ type: "slack-official-plugin-offered", at: isoNow(clock), accountId });
    await stateStore.save(state);
  } else if (existing.status === "skipped" || existing.status === "revoked") {
    records.entries[key] = newEntry(accountId, isoNow(clock), existing.audit);
    records.audit.push({ type: "slack-official-plugin-restart-requested", at: isoNow(clock), accountId });
    await stateStore.save(state);
  }
  const entry = records.entries[key];
  const current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  return { slack: publicView(entry, languageFor(state, language), current?.permissionReview) };
}

/**
 * Performs only the simulated official-plugin authorization and read-only
 * verification after explicit customer approval. It then starts QWA-139's
 * metadata-only review; it never asks the adapter to fetch message bodies.
 */
export async function authorizeSlackOfficialPlugin({
  message,
  stateStore,
  plugin,
  accountId = "slack-workspace",
  pluginAuthorizationApproved = false,
  language,
  clock,
  reviewIdFactory
}) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  if (!["awaiting-plugin-authorization", "authorization-denied", "authorization-unavailable", "access-revoked"].includes(entry.phase)
    && entry.status !== "needs-attention") {
    const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview) };
  }
  if (pluginAuthorizationApproved !== true) {
    const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview) };
  }
  assertPlugin(plugin);

  const now = isoNow(clock);
  let authorization;
  try {
    authorization = await plugin.requestOfficialPluginAuthorization({
      source: SOURCE,
      accountId,
      purpose: "Prepare a metadata-only, read-only Slack permission review after explicit customer approval."
    });
  } catch (error) {
    authorization = { status: error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "revoked" : "unavailable" };
  }
  const authorizationStatus = ["authorized", "denied", "unavailable", "revoked"].includes(authorization?.status)
    ? authorization.status
    : "unavailable";
  entry.pluginAuthorization = {
    status: authorizationStatus,
    attempts: safeNonNegativeInteger(entry.pluginAuthorization?.attempts) + 1,
    authorizedAt: authorizationStatus === "authorized" ? now : null
  };
  if (authorizationStatus !== "authorized" || authorization.accountId !== accountId) {
    const next = authorization.accountId !== undefined && authorization.accountId !== accountId
      ? { status: "needs-attention", phase: "account-mismatch" }
      : statusFromAuthorization(authorizationStatus);
    entry.status = next.status;
    entry.phase = next.phase;
    entry.audit.push({ type: "slack-plugin-authorization-not-ready", at: now, result: next.phase });
    await stateStore.save(state);
    return { slack: publicView(entry, resolvedLanguage) };
  }

  let verification;
  try {
    verification = await plugin.verifyReadOnlyConnection({ source: SOURCE, accountId });
  } catch (error) {
    verification = { status: error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "revoked" : "unavailable", readOnly: false };
  }
  if (!noWriteVerification(verification)) {
    const next = statusFromAuthorization(verification?.status);
    entry.status = next.status === "skipped" ? "needs-attention" : next.status;
    entry.phase = verification?.status === "revoked" ? "access-revoked" : "read-only-verification-failed";
    entry.verification = { status: verification?.status ?? "unavailable", verifiedAt: null, readOnly: false };
    entry.audit.push({ type: "slack-read-only-verification-failed", at: now, status: entry.verification.status });
    await stateStore.save(state);
    return { slack: publicView(entry, resolvedLanguage) };
  }

  entry.status = "selected-but-unfinished";
  entry.phase = "metadata-preflight";
  entry.verification = { status: "verified", verifiedAt: now, readOnly: true };
  const initialMetadata = await safeMetadataSummary(plugin);
  entry.metadata = initialMetadata;
  if (initialMetadata.unavailable) {
    entry.status = "needs-attention";
    entry.phase = "metadata-summary-unavailable";
    entry.audit.push({ type: "slack-metadata-summary-unavailable", at: now, contentBodiesRead: false });
    await stateStore.save(state);
    return { slack: publicView(entry, resolvedLanguage), metadataReviewUnavailable: true };
  }
  entry.audit.push({ type: "slack-read-only-verified", at: now, contentBodiesRead: false });
  await stateStore.save(state);

  let review;
  try {
    review = await beginSourcePermissionReview({
      message: resolvedLanguage === "es" ? "Quiero revisar Slack para mi segundo cerebro" : "I want to review Slack for my second brain",
      stateStore,
      connector: plugin,
      source: SOURCE,
      language: resolvedLanguage,
      clock,
      reviewIdFactory
    });
    if (review.permissionReview.account.id !== accountId) {
      throw new SlackLifecycleError("SLACK_ACCOUNT_MISMATCH", "The reviewed Slack workspace did not match the saved setup.");
    }
  } catch (error) {
    const failedState = await loadState(stateStore);
    const failedEntry = assertEntry(failedState, accountId);
    failedEntry.status = error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "revoked" : "needs-attention";
    failedEntry.phase = error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "access-revoked" : "metadata-review-unavailable";
    failedEntry.metadata = await safeMetadataSummary(plugin);
    failedEntry.audit.push({
      type: "slack-metadata-review-unavailable",
      at: isoNow(clock),
      reason: error?.code === "SLACK_PAGINATION_INCOMPLETE" ? "pagination-incomplete" : error?.code === "SLACK_AUTHORIZATION_REVOKED" ? "access-revoked" : "metadata-review-failed",
      contentBodiesRead: false
    });
    await stateStore.save(failedState);
    return { slack: publicView(failedEntry, languageFor(failedState, language)), metadataReviewUnavailable: true };
  }

  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "selected-but-unfinished";
  refreshedEntry.phase = "awaiting-content-grant";
  refreshedEntry.reviewId = review.permissionReview.permissionRequest.reviewId;
  const completedMetadata = await safeMetadataSummary(plugin);
  refreshedEntry.metadata = completedMetadata;
  if (completedMetadata.unavailable) {
    refreshedEntry.status = "needs-attention";
    refreshedEntry.phase = "metadata-summary-unavailable";
    refreshedEntry.audit.push({ type: "slack-metadata-summary-unavailable", at: isoNow(clock), contentBodiesRead: false });
    await stateStore.save(refreshed);
    return { slack: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview), metadataReviewUnavailable: true };
  }
  refreshedEntry.audit.push({ type: "slack-metadata-only-reviewed", at: isoNow(clock), reviewId: refreshedEntry.reviewId, contentBodiesRead: false });
  await stateStore.save(refreshed);
  return { slack: publicView(refreshedEntry, languageFor(refreshed, language), review.permissionReview) };
}

/** Starts the mandatory, one-conversation blocked-group exception review. */
export async function requestSlackBlockedGroupException({
  message,
  stateStore,
  accountId = "slack-workspace",
  reviewId,
  conversationId,
  language,
  clock,
  blockedGroupReviewIdFactory
}) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  assertOpaqueId(conversationId, "blocked Slack group");
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
  if (entry.phase !== "awaiting-content-grant" || entry.reviewId !== reviewId || current?.permissionReview?.permissionRequest?.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_REVIEW_NOT_READY", "Finish the saved metadata review before separately reviewing one blocked Slack group.");
  }
  if (!currentBlockedGroupIds(current.permissionReview).has(conversationId)) {
    throw new SlackLifecycleError("SLACK_GROUP_NOT_BLOCKED_OR_REVIEWED", "That group was not one of the blocked group conversations in this metadata review, so I kept it excluded.");
  }
  const existing = entry.blockedGroupReviews?.[conversationId];
  if (!existing) {
    const blockedGroupReviewId = assertOpaqueId(
      (blockedGroupReviewIdFactory ?? (() => `slack-blocked-group-${randomUUID()}`))(),
      "blocked Slack group review"
    );
    entry.blockedGroupReviews[conversationId] = {
      id: blockedGroupReviewId,
      conversationId,
      contentReviewId: reviewId,
      status: "awaiting-customer-confirmation",
      createdAt: isoNow(clock)
    };
    entry.audit.push({ type: "slack-blocked-group-exception-requested", at: isoNow(clock), reviewId, conversationId });
    await stateStore.save(state);
  }
  return {
    slack: publicView(entry, resolvedLanguage, current.permissionReview),
    message: copy(resolvedLanguage).groupReview
  };
}

/** Persists one explicit blocked-group exception; it never broadens another group or person. */
export async function approveSlackBlockedGroupException({
  message,
  stateStore,
  accountId = "slack-workspace",
  reviewId,
  conversationId,
  blockedGroupReviewId,
  explicitlyApproved = false,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertOpaqueId(accountId, "Slack workspace");
  assertOpaqueId(conversationId, "blocked Slack group");
  assertOpaqueId(blockedGroupReviewId, "blocked Slack group review");
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  const resolvedLanguage = languageFor(state, language);
  const current = await permissionStatus(stateStore, accountId, resolvedLanguage);
  const groupReview = entry.blockedGroupReviews?.[conversationId];
  if (!groupReview || groupReview.id !== blockedGroupReviewId || groupReview.contentReviewId !== reviewId || entry.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_REVIEW_NOT_FOUND", "I could not find that separate blocked-group review, so the group remains excluded.");
  }
  if (explicitlyApproved !== true) {
    return { slack: publicView(entry, resolvedLanguage, current?.permissionReview), message: copy(resolvedLanguage).groupReview };
  }
  groupReview.status = "approved";
  groupReview.approvedAt = isoNow(clock);
  entry.audit.push({ type: "slack-blocked-group-exception-approved", at: isoNow(clock), reviewId, conversationId, blockedGroupReviewId });
  await stateStore.save(state);
  return { slack: publicView(entry, resolvedLanguage, current?.permissionReview), message: copy(resolvedLanguage).groupApproved };
}

function assertApprovedBlockedGroupExceptions(scope, entry, reviewId) {
  const requested = Array.isArray(scope?.blockedGroupConversationExceptions)
    ? scope.blockedGroupConversationExceptions
    : [];
  for (const conversationId of requested) {
    if (typeof conversationId !== "string" || !OPAQUE_ID.test(conversationId)) {
      throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_EXCEPTION_INVALID", "I could not safely identify a requested blocked group exception, so I kept it excluded.");
    }
    const reviewed = entry.blockedGroupReviews?.[conversationId];
    if (!reviewed || reviewed.status !== "approved" || reviewed.contentReviewId !== reviewId) {
      throw new SlackLifecycleError("SLACK_BLOCKED_GROUP_SEPARATE_REVIEW_REQUIRED", "A group with a blocked person stays excluded until you complete a separate, explicit review for that one group.");
    }
  }
}

function approvedBlockedGroupConversationIds(entry, reviewId) {
  return Object.values(entry.blockedGroupReviews ?? {})
    .filter((review) => review?.status === "approved" && review.contentReviewId === reviewId)
    .map((review) => review.conversationId)
    .filter((conversationId) => typeof conversationId === "string" && OPAQUE_ID.test(conversationId))
    .sort();
}

/** Grants only the QWA-139-reviewed Slack scope after Slack's extra group guard. */
export async function grantSlackContent({
  message,
  stateStore,
  plugin,
  accountId = "slack-workspace",
  reviewId,
  scope,
  language,
  clock,
  grantIdFactory
}) {
  assertNaturalLanguage(message);
  assertPlugin(plugin);
  assertOpaqueId(accountId, "Slack workspace");
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "selected-but-unfinished" || entry.phase !== "awaiting-content-grant" || entry.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_REVIEW_NOT_READY", "Continue the saved Slack metadata review before approving any message content.");
  }
  assertApprovedBlockedGroupExceptions(scope, entry, reviewId);
  const granted = await grantSourcePermission({
    message,
    stateStore,
    connector: plugin,
    source: SOURCE,
    accountId,
    reviewId,
    scope,
    language,
    clock,
    grantIdFactory
  });
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "selected-but-unfinished";
  refreshedEntry.phase = "ready-to-process";
  refreshedEntry.audit.push({ type: "slack-content-granted", at: isoNow(clock), reviewId, grantId: granted.permissionReview.activeGrant?.grantId ?? null });
  await stateStore.save(refreshed);
  return { slack: publicView(refreshedEntry, languageFor(refreshed, language), granted.permissionReview) };
}

function safeStableReferences(references, approvedRecords, accountId) {
  if (!Array.isArray(references) || references.length !== approvedRecords.length) {
    throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack could not safely normalize the approved thread references, so none were exposed.");
  }
  const approvedIds = approvedRecords.map((record) => record.sourceRecordId);
  const seen = new Set();
  return references.map((reference) => {
    const sourceRecordId = typeof reference?.sourceRecordId === "string" && OPAQUE_ID.test(reference.sourceRecordId)
      ? reference.sourceRecordId
      : null;
    const conversationId = typeof reference?.threadContext?.conversationId === "string" && OPAQUE_ID.test(reference.threadContext.conversationId)
      ? reference.threadContext.conversationId
      : null;
    const threadId = typeof reference?.threadContext?.threadId === "string" && OPAQUE_ID.test(reference.threadContext.threadId)
      ? reference.threadContext.threadId
      : null;
    const parentThreadId = reference?.threadContext?.parentThreadId == null
      ? null
      : typeof reference.threadContext.parentThreadId === "string" && OPAQUE_ID.test(reference.threadContext.parentThreadId)
        ? reference.threadContext.parentThreadId
        : undefined;
    const type = ["channel-thread", "direct-message", "group-message"].includes(reference?.conversationType)
      ? reference.conversationType
      : null;
    if (!sourceRecordId || !conversationId || !threadId || parentThreadId === undefined || !type || !approvedIds.includes(sourceRecordId) || seen.has(sourceRecordId)) {
      throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack could not safely normalize the approved thread references, so none were exposed.");
    }
    const stableReference = `slack:${accountId}:${conversationId}:${threadId}`;
    if (reference.stableReference !== stableReference) {
      throw new SlackLifecycleError("SLACK_REFERENCE_NORMALIZATION_FAILED", "Slack returned an unsafe thread reference, so none were exposed.");
    }
    seen.add(sourceRecordId);
    return {
      source: SOURCE,
      sourceRecordId,
      processingDisposition: "untrusted-inert-reference",
      conversationType: type,
      stableReference,
      threadContext: { conversationId, threadId, parentThreadId }
    };
  });
}

async function deactivateLocalGrant({ message, stateStore, plugin, accountId, reviewId, language, clock }) {
  try {
    await revokeSourcePermission({ message, stateStore, connector: plugin, source: SOURCE, accountId, reviewId, language, clock });
  } catch {
    // Source state is already uncertain or revoked. The public Slack status
    // must still fail closed; a fresh review is safer than surfacing an error.
  }
}

async function markFetchUnavailable({ message, stateStore, plugin, accountId, reviewId, language, clock, error }) {
  const revoked = error?.code === "SLACK_AUTHORIZATION_REVOKED";
  await deactivateLocalGrant({ message, stateStore, plugin, accountId, reviewId, language, clock });
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  entry.status = revoked ? "revoked" : "needs-attention";
  entry.phase = revoked ? "access-revoked" : "approved-fetch-unavailable";
  if (revoked) entry.pluginAuthorization.status = "revoked";
  entry.audit.push({
    type: revoked ? "slack-access-revoked-during-fetch" : "slack-approved-fetch-unavailable",
    at: isoNow(clock),
    reviewId,
    reason: revoked ? "access-revoked" : "safe-reference-or-plugin-failure",
    rawContentExposed: false
  });
  await stateStore.save(state);
  const current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  return {
    slack: publicView(entry, languageFor(state, language), current?.permissionReview),
    approvedThreads: [],
    importUnavailable: true
  };
}

/**
 * Fetches the active, permission-bounded Slack records and exposes only
 * validated stable references and thread-parent ids. Source text and labels
 * never leave the injected plugin seam.
 */
export async function fetchApprovedSlackContent({
  message,
  stateStore,
  plugin,
  accountId = "slack-workspace",
  reviewId,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertPlugin(plugin);
  assertOpaqueId(accountId, "Slack workspace");
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  if (entry.status !== "selected-but-unfinished" || entry.phase !== "ready-to-process" || entry.reviewId !== reviewId) {
    throw new SlackLifecycleError("SLACK_GRANT_REQUIRED", "No Slack content was processed because the saved granular review is not ready.");
  }
  let fetched;
  let references;
  try {
    await plugin.setSlackContentPolicy({
      reviewId,
      approvedBlockedGroupConversationIds: approvedBlockedGroupConversationIds(entry, reviewId)
    });
    fetched = await fetchApprovedSourceContent({
      message,
      stateStore,
      connector: plugin,
      source: SOURCE,
      accountId,
      reviewId,
      language,
      clock
    });
    references = await plugin.normalizeStableThreadReferences({
      source: SOURCE,
      accountId,
      records: fetched.approvedRecords
    });
    references = safeStableReferences(references, fetched.approvedRecords, accountId);
  } catch (error) {
    if (error instanceof PermissionLifecycleError
      && !["CONNECTOR_BODY_BOUNDARY_INVALID"].includes(error.code)) {
      throw error;
    }
    return markFetchUnavailable({ message, stateStore, plugin, accountId, reviewId, language, clock, error });
  }
  const refreshed = await loadState(stateStore);
  const refreshedEntry = assertEntry(refreshed, accountId);
  refreshedEntry.status = "selected-but-unfinished";
  refreshedEntry.phase = "processed-simulated";
  refreshedEntry.audit.push({ type: "slack-approved-threads-processed", at: isoNow(clock), reviewId, recordCount: references.length, rawContentExposed: false });
  await stateStore.save(refreshed);
  return {
    slack: publicView(refreshedEntry, languageFor(refreshed, language), fetched.permissionReview),
    approvedThreads: references
  };
}

/** Revokes the local read-only grant and clearly marks the simulated source revoked. */
export async function revokeSlackContent({ message, stateStore, plugin, accountId = "slack-workspace", reviewId, language, clock }) {
  assertNaturalLanguage(message);
  assertPlugin(plugin);
  assertOpaqueId(accountId, "Slack workspace");
  const revoked = await revokeSourcePermission({ message, stateStore, connector: plugin, source: SOURCE, accountId, reviewId, language, clock });
  const state = await loadState(stateStore);
  const entry = assertEntry(state, accountId);
  entry.status = "revoked";
  entry.phase = "access-revoked";
  entry.pluginAuthorization.status = "revoked";
  entry.audit.push({ type: "slack-local-grant-revoked", at: isoNow(clock), reviewId });
  await stateStore.save(state);
  return { slack: publicView(entry, languageFor(state, language), revoked.permissionReview) };
}

/** Reads only saved lifecycle state; it never invokes the plugin or Slack. */
export async function getSlackConnectionStatus({ stateStore, accountId = "slack-workspace", language }) {
  assertOpaqueId(accountId, "Slack workspace");
  const state = await loadState(stateStore);
  const entry = lifecycle(state).entries[entryKey(accountId)];
  if (!entry) return null;
  const current = await permissionStatus(stateStore, accountId, languageFor(state, language));
  return { slack: publicView(entry, languageFor(state, language), current?.permissionReview) };
}
