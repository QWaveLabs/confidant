/**
 * QWA-146 approved-record compiler.
 *
 * This is deliberately a simulation/contract boundary. It accepts only
 * bounded, already-approved normalized references from the QWA-139 grant
 * lifecycle. It neither connects to a source nor accepts source bodies. The
 * only filesystem persistence in this slice is a short-lived, private staging
 * batch; derived canonical projections are returned to the caller and may be
 * saved by that caller's already-private state store.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";
import { SENSITIVE_CATEGORIES, withSourcePermissionStateLock } from "../permissions/setup-source-permissions.mjs";

const STATE_KEY = "knowledgeCompilationLifecycle";
const STAGING_DIRECTORY_NAME = ".qwave-second-brain-staging";
const STAGING_FILE_PREFIX = "batch-";
const STAGING_FILE_SUFFIX = ".json";
const STAGING_LEASE_SUFFIX = ".lease";
const STAGING_RECEIPT_SUFFIX = ".receipt.json";
const STAGING_VERSION = 1;
const MAX_STAGING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_RECORDS = 100;
const MAX_STAGING_BYTES = 256 * 1024;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RETENTION_WORKER_PATH = fileURLToPath(new URL("./private-staging-retention-worker.mjs", import.meta.url));
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CONFIDENCE_LEVELS = new Set(["confirmed", "likely", "uncertain"]);
const PRIVACY_RESTRICTIONS = new Set([
  "private",
  "restricted",
  "owner-only",
  "no-external-sharing",
  "sensitive",
  "generated-only"
]);
const SUBJECT_TYPES = Object.freeze({
  people: { directory: "People", en: "People", es: "Personas" },
  organizations: { directory: "Organizations", en: "Organizations", es: "Organizaciones" },
  projects: { directory: "Projects", en: "Projects", es: "Proyectos" },
  decisions: { directory: "Decisions", en: "Decisions", es: "Decisiones" },
  priorities: { directory: "Priorities", en: "Priorities", es: "Prioridades" },
  areas: { directory: "Areas", en: "Areas", es: "Áreas" },
  meetings: { directory: "Meetings", en: "Meetings", es: "Reuniones" },
  knowledge: { directory: "Knowledge", en: "Knowledge", es: "Conocimiento" }
});
const RECORD_FIELDS = new Set([
  "source",
  "accountId",
  "sourceRecordId",
  "reviewId",
  "grantId",
  "processingDisposition",
  "sourceTimestamp",
  "approvedParticipantRefs",
  "sourceLabel",
  "stableLink",
  "observedAt",
  "verifiedAt",
  "privacyRestrictions",
  "assertions"
]);
const ASSERTION_FIELDS = new Set([
  "subjectType",
  "subjectId",
  "subjectLabel",
  "assertion",
  "confidence",
  "privacyRestrictions"
]);
const RAW_STAGING_FIELDS = /^(?:body|html|text|content|snippet|raw|payload|headers?|attachments?|config(?:uration)?|secrets?|tokens?|passwords?)$/i;
const DANGEROUS_TEXT = /\b(?:ignore\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|developer\s+message|reveal\s+(?:a\s+)?secret|grant\s+access|run\s+(?:a\s+)?command|execute\s+(?:a\s+)?command|curl\s+https?:|powershell|bash\s+-c)\b/i;
const SENSITIVE_TEXT = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d[ -]?){9,}\b|\b(?:api[ _-]?key|password|passcode|secret|access[ _-]?token|bearer)\b)/i;

export class KnowledgeCompilationError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "KnowledgeCompilationError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

function clone(value) {
  return structuredClone(value);
}

function isoNow(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function addHours(iso, hours) {
  return new Date(Date.parse(iso) + (hours * 60 * 60 * 1000)).toISOString();
}

function assertStateStore(stateStore) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent private stateStore with load() and save() is required.");
  }
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new KnowledgeCompilationError(
      "COMPILATION_MESSAGE_REQUIRED",
      "Tell me in normal language that you want to compile your approved notes."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new KnowledgeCompilationError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Tell me in normal language that you want to compile the approved notes."
    );
  }
  if (!/(compile|canonical|notes?|resume|continue|compila|can[oó]nic|notas?|contin[uú]a)/i.test(message)) {
    throw new KnowledgeCompilationError(
      "UNRECOGNIZED_COMPILATION_REQUEST",
      "Tell me you would like to compile or continue your approved notes, and I will keep the source boundary private."
    );
  }
}

function languageFor(state, language) {
  return language === "es" || state?.safeDecisions?.language === "es" ? "es" : "en";
}

function wording(language) {
  if (language === "es") {
    return {
      ready: "Las notas canónicas se compilaron solo a partir de referencias normalizadas aprobadas. No se conservó ningún lote de fuente después de la compilación.",
      interrupted: "La compilación se interrumpió antes de producir notas. El lote temporal protegido sigue disponible para reanudarlo durante un máximo de 24 horas.",
      expired: "El lote temporal venció y se eliminó. Para proteger tu privacidad, necesitarás aprobar un lote nuevo antes de continuar.",
      generatedHeading: "Afirmaciones canónicas generadas",
      yourNotesHeading: "Tus notas",
      generatedBoundary: "Este bloque es generado por QWave a partir de evidencia aprobada. No es una fuente original.",
      yourNotesBoundary: "Escribe tus notas aquí. Este bloque pertenece a la persona usuaria y no se sobrescribe.",
      sourceHeading: "Referencias de fuente",
      sourceIndexHeading: "Índice de fuentes",
      sourceIndexBoundary: "Navegación generada solamente. Las afirmaciones autorizadas permanecen en las notas canónicas enlazadas.",
      unknown: "Desconocido (sin evidencia aprobada)",
      observed: "Observado",
      verified: "Verificado",
      notVerified: "Aún no verificado",
      confidence: "Confianza",
      privacy: "Restricciones de privacidad",
      claim: "Afirmación",
      claimIds: "IDs de afirmación",
      sourceReference: "Referencia de fuente",
      review: "revisión",
      grant: "concesión",
      sourceTimestamp: "Fecha de la fuente",
      participants: "Referencias de participantes aprobadas",
      sourceLabel: "Etiqueta de fuente aprobada",
      stableLink: "Enlace estable",
      noStableLink: "Sin enlace estable aprobado",
      processed: "Procesado",
      simulated: "Simulación local; no se leyó ninguna fuente real."
    };
  }
  return {
    ready: "Canonical notes were compiled only from approved normalized references. No source batch was retained after compilation.",
    interrupted: "Compilation stopped before notes were produced. The protected temporary batch remains available to resume for no more than 24 hours.",
    expired: "The temporary batch expired and was deleted. To protect your privacy, approve a new batch before continuing.",
    generatedHeading: "Generated canonical claims",
    yourNotesHeading: "Your notes",
    generatedBoundary: "This block is generated by QWave from approved evidence. It is not an original source.",
    yourNotesBoundary: "Write your notes here. This block is user-owned and is never overwritten.",
    sourceHeading: "Source references",
    sourceIndexHeading: "Source index",
    sourceIndexBoundary: "Generated navigation only. Authoritative claims remain in the linked canonical notes.",
    unknown: "Unknown (no approved evidence)",
    observed: "Observed",
    verified: "Verified",
    notVerified: "Not yet verified",
    confidence: "Confidence",
    privacy: "Privacy restrictions",
    claim: "Claim",
    claimIds: "Claim IDs",
    sourceReference: "Source reference",
    review: "review",
    grant: "grant",
    sourceTimestamp: "Source timestamp",
    participants: "Approved participant references",
    sourceLabel: "Approved source label",
    stableLink: "Stable link",
    noStableLink: "No approved stable link",
    processed: "Processed",
    simulated: "Local simulation; no real source was read."
  };
}

function isWithin(candidate, root) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function assertDedicatedStagingRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new KnowledgeCompilationError(
      "STAGING_ROOT_INVALID",
      "Temporary staging must use one dedicated absolute local directory."
    );
  }
  const normalized = resolve(root);
  if (normalized === resolve(sep) || basename(normalized) !== STAGING_DIRECTORY_NAME) {
    throw new KnowledgeCompilationError(
      "STAGING_ROOT_TOO_BROAD",
      "Temporary staging must use only the dedicated .qwave-second-brain-staging directory, never a broad filesystem root."
    );
  }
  if (isWithin(normalized, REPOSITORY_ROOT)) {
    throw new KnowledgeCompilationError(
      "STAGING_PUBLIC_REPOSITORY_BLOCKED",
      "Temporary source staging cannot be placed in this repository. Choose a private local temporary directory."
    );
  }
  return normalized;
}

async function repositoryRealRoot() {
  try {
    return await realpath(REPOSITORY_ROOT);
  } catch {
    return REPOSITORY_ROOT;
  }
}

async function hasGitRepositoryAncestor(start) {
  let current = start;
  while (true) {
    try {
      // A worktree may use a .git file while a conventional clone uses a
      // directory. Either means staging here would put private material in a
      // repository, including a public installer repository.
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new KnowledgeCompilationError(
          "STAGING_PARENT_INVALID",
          "I could not safely inspect the temporary staging parent, so no source batch was staged."
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertBatchId(batchId) {
  if (typeof batchId !== "string" || !BATCH_ID.test(batchId)) {
    throw new KnowledgeCompilationError(
      "BATCH_ID_INVALID",
      "Use a short opaque batch ID with letters, numbers, dots, underscores, or hyphens."
    );
  }
  return batchId;
}

function stagingFileName(batchId) {
  return `${STAGING_FILE_PREFIX}${assertBatchId(batchId)}${STAGING_FILE_SUFFIX}`;
}

function stagingLeaseFileName(batchId) { return `${STAGING_FILE_PREFIX}${assertBatchId(batchId)}${STAGING_LEASE_SUFFIX}`; }
function stagingReceiptFileName(batchId) { return `${STAGING_FILE_PREFIX}${assertBatchId(batchId)}${STAGING_RECEIPT_SUFFIX}`; }

function parseBatchFileName(name) {
  if (typeof name === "string" && name.endsWith(STAGING_RECEIPT_SUFFIX)) return null;
  if (typeof name !== "string" || !name.startsWith(STAGING_FILE_PREFIX) || !name.endsWith(STAGING_FILE_SUFFIX)) return null;
  const batchId = name.slice(STAGING_FILE_PREFIX.length, -STAGING_FILE_SUFFIX.length);
  return BATCH_ID.test(batchId) ? batchId : null;
}

function assertNoRawStagingMaterial(value, depth = 0) {
  if (depth > 16) {
    throw new KnowledgeCompilationError("STAGING_PAYLOAD_TOO_DEEP", "The temporary batch is too deeply nested to inspect safely.");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoRawStagingMaterial(item, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (RAW_STAGING_FIELDS.test(key)) {
      throw new KnowledgeCompilationError(
        "RAW_SOURCE_FIELD_BLOCKED",
        "Temporary staging never accepts raw source bodies, headers, attachments, configuration, or secrets."
      );
    }
    assertNoRawStagingMaterial(nested, depth + 1);
  }
}

function validatedStagingPayload(payload, batchId, maxRecords) {
  if (
    !payload
    || payload.version !== STAGING_VERSION
    || payload.batchId !== batchId
    || !Array.isArray(payload.records)
    || payload.records.length === 0
    || payload.records.length > maxRecords
  ) {
    throw new KnowledgeCompilationError(
      "STAGING_BATCH_INVALID",
      "The protected temporary batch was not valid, so it was not compiled."
    );
  }
  assertNoRawStagingMaterial(payload.records);
  const records = normalizeInertStagingRecords(payload.records, { maxRecords });
  const leaseId = assertOpaqueId(payload.leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
  const createdAt = canonicalTimestamp(payload.createdAt, "STAGING_TIMESTAMP_INVALID");
  const expiresAt = canonicalTimestamp(payload.expiresAt, "STAGING_TIMESTAMP_INVALID");
  if (expiresAt !== addHours(createdAt, 24)) {
    throw new KnowledgeCompilationError(
      "STAGING_TIMESTAMP_INVALID",
      "The protected temporary batch did not preserve its fixed 24-hour expiry, so it was not compiled."
    );
  }
  return { batchId, leaseId, createdAt, expiresAt, records };
}

function retentionWorkerKey(root, batchId) {
  return `${root}\u0000${batchId}`;
}

/**
 * Arms one detached, local-only expiry worker before a staging file is
 * created. The worker receives only the staging root, opaque batch ID, and
 * fixed deadline — never records, source bodies, credentials, or logging
 * destinations — and remains alive if the creating compiler process exits.
 */
export class DetachedLocalRetentionService {
  constructor({ workerPath = RETENTION_WORKER_PATH } = {}) {
    this.workerPath = workerPath;
    this.workers = new Map();
  }

  async arm({ root, batchId, expiresAt, leaseId = batchId }) {
    const safeRoot = assertDedicatedStagingRoot(root);
    const safeBatchId = assertBatchId(batchId);
    const safeExpiresAt = canonicalTimestamp(expiresAt, "STAGING_TIMESTAMP_INVALID");
    const safeLeaseId = assertOpaqueId(leaseId, "STAGING_LEASE_INVALID", "staging lease identity");
    const key = retentionWorkerKey(safeRoot, safeBatchId);
    await this.disarm({ root: safeRoot, batchId: safeBatchId });

    return new Promise((resolveArm, rejectArm) => {
      let settled = false;
      let child;
      const cleanupPreArmListeners = () => {
        child?.removeListener("error", failBeforeArm);
        child?.removeListener("exit", exitBeforeArm);
        child?.removeListener("message", confirmArm);
      };
      const failBeforeArm = () => {
        if (settled) return;
        settled = true;
        cleanupPreArmListeners();
        try {
          child?.kill("SIGTERM");
        } catch {
          // The child already exited before confirming its schedule.
        }
        rejectArm(new KnowledgeCompilationError(
          "RETENTION_SERVICE_UNAVAILABLE",
          "I could not arm the private 24-hour cleanup service, so no temporary batch was staged."
        ));
      };
      const exitBeforeArm = () => failBeforeArm();
      const confirmArm = (message) => {
        if (message?.type !== "qwave-retention-armed" || message?.batchId !== safeBatchId || settled) return;
        settled = true;
        cleanupPreArmListeners();
        child.once("exit", () => {
          if (this.workers.get(key) === child) this.workers.delete(key);
        });
        child.unref();
        this.workers.set(key, child);
        resolveArm({ armed: true });
      };
      try {
        child = spawn(process.execPath, [this.workerPath, safeRoot, safeBatchId, safeExpiresAt, safeLeaseId], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          // Do not carry caller secrets or ambient process configuration into
          // a detached deletion worker.
          env: { PATH: process.env.PATH ?? "" }
        });
      } catch {
        failBeforeArm();
        return;
      }
      child.once("error", failBeforeArm);
      child.once("exit", exitBeforeArm);
      child.on("message", confirmArm);
    });
  }

  async disarm({ root, batchId }) {
    const key = retentionWorkerKey(assertDedicatedStagingRoot(root), assertBatchId(batchId));
    const child = this.workers.get(key);
    this.workers.delete(key);
    if (!child || child.exitCode !== null || child.killed) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The worker never holds source data. If it has already detached beyond
      // this process, it safely exits when the named batch no longer exists.
    }
  }
}

/**
 * A concrete private local staging adapter. It is intentionally narrow:
 * files are limited to a dedicated root, never follow a staging symlink, and
 * use opaque batch IDs so callers cannot select arbitrary paths.
 */
export class LocalTemporaryStaging {
  constructor({
    root,
    maxRecords = MAX_BATCH_RECORDS,
    maxBytes = MAX_STAGING_BYTES,
    retentionService = new DetachedLocalRetentionService()
  } = {}) {
    this.root = assertDedicatedStagingRoot(root);
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    if (!retentionService || typeof retentionService.arm !== "function" || typeof retentionService.disarm !== "function") {
      throw new TypeError("A private retentionService with arm() and disarm() is required for temporary staging.");
    }
    this.retentionService = retentionService;
    this.realRoot = null;
    this.initialization = null;
    this.expiryTimers = new Map();
    this.startupRemovedBatchIds = new Set();
    this.workerCompletionReceiptBatchIds = new Set();
    this.retentionCoverageUnavailableBatchIds = new Set();
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#initialize();
    return this.initialization;
  }

  async #initialize() {
    const parent = dirname(this.root);
    let parentStats;
    try {
      parentStats = await lstat(parent);
    } catch {
      throw new KnowledgeCompilationError(
        "STAGING_PARENT_INVALID",
        "The private temporary staging parent is unavailable, so no source batch was staged."
      );
    }
    if (!parentStats.isDirectory()) {
      throw new KnowledgeCompilationError(
        "STAGING_PARENT_INVALID",
        "The private temporary staging parent is not a directory, so no source batch was staged."
      );
    }
    const parentReal = await realpath(parent);
    if (await hasGitRepositoryAncestor(parentReal)) {
      throw new KnowledgeCompilationError(
        "STAGING_PUBLIC_REPOSITORY_BLOCKED",
        "Temporary source staging cannot be created inside a repository. Choose a private local temporary directory."
      );
    }

    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new KnowledgeCompilationError(
          "STAGING_ROOT_UNAVAILABLE",
          "I could not create the protected temporary staging directory, so no source batch was staged."
        );
      }
    }

    const rootStats = await lstat(this.root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new KnowledgeCompilationError(
        "STAGING_SYMLINK_BLOCKED",
        "Temporary staging cannot use a symbolic link or non-directory path."
      );
    }
    try {
      await chmod(this.root, 0o700);
    } catch {
      throw new KnowledgeCompilationError(
        "STAGING_PERMISSIONS_UNSAFE",
        "I could not protect the temporary staging directory, so no source batch was staged."
      );
    }

    const [rootReal, repositoryReal] = await Promise.all([realpath(this.root), repositoryRealRoot()]);
    if (!isWithin(rootReal, parentReal) || isWithin(rootReal, repositoryReal)) {
      throw new KnowledgeCompilationError(
        "STAGING_PUBLIC_REPOSITORY_BLOCKED",
        "Temporary source staging cannot resolve inside this repository."
      );
    }
    this.realRoot = rootReal;
    // The expiry is durable in each staged file. Re-check it whenever this
    // adapter starts so a restart does not depend on an old in-memory timer.
    const startupCleanup = await this.#cleanupExpiredInRoot(rootReal, isoNow());
    startupCleanup.removedBatchIds.forEach((batchId) => this.startupRemovedBatchIds.add(batchId));
    return rootReal;
  }

  async #filePath(batchId) {
    const root = await this.#trustedRoot();
    const candidate = resolve(root, stagingFileName(batchId));
    if (dirname(candidate) !== root || !isWithin(candidate, root)) {
      throw new KnowledgeCompilationError(
        "STAGING_PATH_ESCAPE_BLOCKED",
        "Temporary staging refused a path outside its dedicated directory."
      );
    }
    return candidate;
  }

  async #trustedRoot() {
    const root = await this.initialize();
    let stats;
    try {
      stats = await lstat(root);
    } catch {
      throw new KnowledgeCompilationError("STAGING_ROOT_UNAVAILABLE", "The protected temporary staging directory is unavailable.");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new KnowledgeCompilationError("STAGING_SYMLINK_BLOCKED", "Temporary staging cannot use a symbolic link or non-directory path.");
    }
    const [resolved, repositoryReal] = await Promise.all([realpath(root), repositoryRealRoot()]);
    if (resolved !== root || isWithin(resolved, repositoryReal) || await hasGitRepositoryAncestor(resolved)) {
      throw new KnowledgeCompilationError("STAGING_PUBLIC_REPOSITORY_BLOCKED", "Temporary staging no longer resolves to its dedicated private directory.");
    }
    return root;
  }

  #scheduleExpiry(batchId, expiresAt) {
    const existing = this.expiryTimers.get(batchId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timer = setTimeout(async () => {
      this.expiryTimers.delete(batchId);
      try {
        const staged = await this.read({ batchId });
        if (Date.parse(staged.expiresAt) <= Date.now() && await this.delete({ batchId })) {
          // Carry a path-free expiry signal into the next lifecycle cleanup so
          // an in-process timer cannot turn an expired batch into a generic
          // missing-file interruption.
          this.startupRemovedBatchIds.add(batchId);
        }
      } catch {
        // Keep retrying on a running host. A refusal to unlink must never
        // silently disarm the only local cleanup coverage.
        this.#scheduleExpiry(batchId, new Date(Date.now() + 250).toISOString());
      }
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(batchId, timer);
  }

  async #armRetention(batchId, expiresAt, leaseId, knownTrustedRoot = null) {
    const root = knownTrustedRoot ?? await this.#trustedRoot();
    try {
      await this.retentionService.arm({ root, batchId, expiresAt, leaseId });
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      throw new KnowledgeCompilationError(
        "RETENTION_SERVICE_UNAVAILABLE",
        "I could not arm the private 24-hour cleanup service, so no temporary batch was staged."
      );
    }
  }

  async #disarmRetention(batchId, knownTrustedRoot = null) {
    try {
      const root = knownTrustedRoot ?? await this.#trustedRoot();
      await this.retentionService.disarm({ root, batchId });
    } catch {
      // A completed filesystem deletion remains authoritative. An independently
      // detached worker has no records to expose and exits when its filename is
      // absent, so cancellation failure cannot revive staging.
    }
  }

  async stage({ batchId, records, createdAt }) {
    const safeBatchId = assertBatchId(batchId);
    if (!Array.isArray(records) || records.length === 0 || records.length > this.maxRecords) {
      throw new KnowledgeCompilationError(
        "STAGING_RECORD_LIMIT",
        `A temporary batch must contain between 1 and ${this.maxRecords} approved records.`
      );
    }
    assertNoRawStagingMaterial(records);
    const normalizedRecords = normalizeInertStagingRecords(records, { maxRecords: this.maxRecords });
    const normalizedCreatedAt = canonicalTimestamp(createdAt, "STAGING_TIMESTAMP_INVALID");
    const leaseId = `lease-${randomUUID()}`;
    const payload = {
      version: STAGING_VERSION,
      batchId: safeBatchId,
      leaseId,
      createdAt: normalizedCreatedAt,
      expiresAt: addHours(normalizedCreatedAt, 24),
      records: normalizedRecords
    };
    const serialized = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) {
      throw new KnowledgeCompilationError(
        "STAGING_SIZE_LIMIT",
        "The approved batch is too large for protected temporary staging. Split it into a smaller approved batch."
      );
    }

    const filePath = await this.#filePath(safeBatchId);
    try {
      await lstat(filePath);
      throw new KnowledgeCompilationError(
        "STAGING_BATCH_EXISTS",
        "A protected temporary batch with that ID already exists. Resume it instead of replacing it."
      );
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      if (error?.code !== "ENOENT") {
        throw new KnowledgeCompilationError("STAGING_WRITE_FAILED", "I could not safely inspect the protected temporary batch path.");
      }
    }
    // Arm the independent worker before the file is created. If this process
    // exits during the write or immediately after it, the named private batch
    // remains covered by the already-scheduled 24-hour deletion.
    await this.#armRetention(safeBatchId, payload.expiresAt, leaseId);
    let handle;
    try {
      handle = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      // A sidecar contains only the generation identity. The detached worker
      // checks it before deletion, so an old worker cannot remove a reused ID.
      await writeFile(join(await this.#trustedRoot(), stagingLeaseFileName(safeBatchId)), `${leaseId}\n`, { mode: 0o600, flag: "wx" });
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (error?.code === "EEXIST") {
        await this.#disarmRetention(safeBatchId);
        throw new KnowledgeCompilationError(
          "STAGING_BATCH_EXISTS",
          "A protected temporary batch with that ID already exists. Resume it instead of replacing it."
        );
      }
      // Never disarm before verified absence. A partial create/write/fsync/close
      // failure may have left a private file behind, and the independent worker
      // must remain armed until deletion is confirmed.
      await this.#deleteWithVerification(safeBatchId).catch(() => undefined);
      throw error instanceof KnowledgeCompilationError
        ? error
        : new KnowledgeCompilationError("STAGING_WRITE_FAILED", "I could not save the protected temporary batch, so no compilation started.");
    } finally {
      if (handle) {
        try { await handle.close(); } catch {
          await this.#deleteWithVerification(safeBatchId).catch(() => undefined);
          throw new KnowledgeCompilationError("STAGING_WRITE_FAILED", "I could not close the protected temporary batch. Cleanup remains armed and can be retried.");
        }
      }
    }
    const receipt = {
      batchId: safeBatchId,
      leaseId,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
      retention: "delete-after-compilation-or-within-24-hours"
    };
    this.#scheduleExpiry(safeBatchId, payload.expiresAt);
    return receipt;
  }

  async read({ batchId }) {
    const filePath = await this.#filePath(batchId);
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new KnowledgeCompilationError(
          "STAGING_BATCH_MISSING",
          "The protected temporary batch is no longer available. Approve a new batch before continuing."
        );
      }
      throw new KnowledgeCompilationError("STAGING_READ_FAILED", "I could not safely read the protected temporary batch.");
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new KnowledgeCompilationError(
        "STAGING_SYMLINK_BLOCKED",
        "Temporary staging refused a symbolic link or non-file batch."
      );
    }
    if (stats.size > this.maxBytes) {
      throw new KnowledgeCompilationError(
        "STAGING_SIZE_LIMIT",
        "The protected temporary batch exceeded its safe size limit and was not compiled."
      );
    }

    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const serialized = await handle.readFile({ encoding: "utf8" });
      const payload = JSON.parse(serialized);
      return validatedStagingPayload(payload, batchId, this.maxRecords);
    } catch (error) {
      if (error instanceof KnowledgeCompilationError) throw error;
      throw new KnowledgeCompilationError("STAGING_READ_FAILED", "I could not safely read the protected temporary batch.");
    } finally {
      await handle?.close();
    }
  }

  async #writeCompletionReceipt(batchId, leaseId) {
    const root = await this.#trustedRoot();
    const receipt = JSON.stringify({ version: 1, batchId, leaseId, deletedAt: new Date().toISOString() });
    const target = join(root, stagingReceiptFileName(batchId));
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${receipt}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }

  async #deleteWithVerification(batchId, knownRoot = null) {
    const root = knownRoot ?? await this.#trustedRoot();
    const filePath = resolve(root, stagingFileName(batchId));
    let leaseId = null;
    try { leaseId = (await readFile(join(root, stagingLeaseFileName(batchId)), "utf8")).trim(); } catch {}
    try { await unlink(filePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    // unlink success alone is not a receipt. Confirm the exact path has gone
    // before clearing local timers or disarming the independent worker.
    try {
      await lstat(filePath);
      throw new KnowledgeCompilationError("STAGING_DELETE_FAILED", "The protected temporary batch still exists; cleanup remains armed and can be retried.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await unlink(join(root, stagingLeaseFileName(batchId))).catch(() => undefined);
    // The detached worker writes the crash-recovery completion receipt. The
    // foreground transaction already has the verified absence in hand and
    // records its own receipt in the private lifecycle state.
    const timer = this.expiryTimers.get(batchId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(batchId);
    if (!knownRoot) await this.#disarmRetention(batchId);
    return true;
  }

  async delete({ batchId }) {
    try {
      return await this.#deleteWithVerification(batchId);
    } catch {
      throw new KnowledgeCompilationError("STAGING_DELETE_FAILED", "I could not confirm removal of the protected temporary batch. Cleanup remains armed and will retry.");
    }
  }

  async #cleanupExpiredInRoot(root, now) {
    const current = Date.parse(canonicalTimestamp(now, "STAGING_TIMESTAMP_INVALID"));
    const removedBatchIds = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(STAGING_RECEIPT_SUFFIX)) continue;
      const batchId = entry.name.slice(STAGING_FILE_PREFIX.length, -STAGING_RECEIPT_SUFFIX.length);
      if (!BATCH_ID.test(batchId)) continue;
      try {
        const receipt = JSON.parse(await readFile(join(root, entry.name), "utf8"));
        if (receipt?.batchId === batchId && typeof receipt?.leaseId === "string" && OPAQUE_ID.test(receipt.leaseId)) {
          this.workerCompletionReceiptBatchIds.add(batchId);
          await unlink(join(root, entry.name));
        }
      } catch { /* leave an untrusted receipt inert for later owner cleanup */ }
    }
    for (const entry of entries) {
      const batchId = parseBatchFileName(entry.name);
      if (!batchId) continue;
      const filePath = resolve(root, entry.name);
      if (dirname(filePath) !== root) continue;
      let payload;
      let validated;
      try {
        const stats = await lstat(filePath);
        if (stats.isSymbolicLink() || !stats.isFile() || stats.size > this.maxBytes) {
          await this.#deleteWithVerification(batchId, root);
          removedBatchIds.push(batchId);
          continue;
        }
        const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          payload = JSON.parse(await handle.readFile({ encoding: "utf8" }));
        } finally {
          await handle.close();
        }
        validated = validatedStagingPayload(payload, batchId, this.maxRecords);
      } catch {
        // A malformed file in this dedicated root is never compiled. Remove
        // only this filename-shaped batch, without traversing anything else.
        try {
          await this.#deleteWithVerification(batchId, root);
          removedBatchIds.push(batchId);
        } catch {
          // The next cleanup attempt can retry; no caller-visible path leaks.
        }
        continue;
      }
      const expiresAt = Date.parse(validated.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= current) {
        await this.#deleteWithVerification(batchId, root);
        removedBatchIds.push(batchId);
      } else {
        this.#scheduleExpiry(batchId, validated.expiresAt);
        // A newly created adapter must re-arm its independent worker for any
        // durable batch it discovers. This closes the restart/crash gap even
        // if an earlier worker was interrupted outside the compiler process.
        try {
          await this.#armRetention(batchId, validated.expiresAt, validated.leaseId, root);
        } catch {
          // If a restarted process cannot restore independent expiry coverage,
          // delete this private batch early rather than retain it without the
          // promised crash-safe cleanup path.
          try {
            await this.#deleteWithVerification(batchId, root);
            this.retentionCoverageUnavailableBatchIds.add(batchId);
            removedBatchIds.push(batchId);
          } catch {
            // A later owner-only cleanup can retry; no content is exposed.
          }
        }
      }
    }
    return { removedBatchIds: [...new Set(removedBatchIds)].sort() };
  }

  async cleanupExpired({ now }) {
    const root = await this.#trustedRoot();
    const cleaned = await this.#cleanupExpiredInRoot(root, now);
    const removedBatchIds = [...this.startupRemovedBatchIds, ...cleaned.removedBatchIds];
    const retentionCoverageUnavailableBatchIds = [...this.retentionCoverageUnavailableBatchIds];
    const workerCompletionReceiptBatchIds = [...this.workerCompletionReceiptBatchIds];
    this.startupRemovedBatchIds.clear();
    this.retentionCoverageUnavailableBatchIds.clear();
    this.workerCompletionReceiptBatchIds.clear();
    return {
      removedBatchIds: [...new Set(removedBatchIds)].sort(),
      retentionCoverageUnavailableBatchIds: [...new Set(retentionCoverageUnavailableBatchIds)].sort(),
      workerCompletionReceiptBatchIds: [...new Set(workerCompletionReceiptBatchIds)].sort()
    };
  }
}

function canonicalTimestamp(value, errorCode = "TIMESTAMP_INVALID") {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new KnowledgeCompilationError(errorCode, "A valid observed or verified timestamp is required for each approved record.");
  }
  return new Date(value).toISOString();
}

function canonicalOptionalTimestamp(value) {
  return value == null ? null : canonicalTimestamp(value);
}

function assertOpaqueId(value, code, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new KnowledgeCompilationError(code, `${field} must be a short opaque identifier without spaces or sensitive account details.`);
  }
  return value;
}

function assertNoUnexpectedFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeCompilationError("NORMALIZED_RECORD_INVALID", `Each ${label} must be a plain normalized object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new KnowledgeCompilationError(
      "RAW_SOURCE_FIELD_BLOCKED",
      `The ${label} included an unsupported field. Raw source bodies, headers, attachments, and configuration are never accepted here.`
    );
  }
}

function safeNormalizedText(value, { allowNull = false, field, maxLength = 360 } = {}) {
  if (allowNull && value == null) return null;
  if (typeof value !== "string") {
    throw new KnowledgeCompilationError("NORMALIZED_TEXT_INVALID", `${field} must be normalized short text, not a source body.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(normalized) || DANGEROUS_TEXT.test(normalized) || SENSITIVE_TEXT.test(normalized)) {
    throw new KnowledgeCompilationError(
      "NORMALIZED_TEXT_UNSAFE",
      `${field} must be a short, non-sensitive normalized assertion. Source text and embedded instructions are not accepted.`
    );
  }
  return normalized;
}

function normalizedStableLink(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new KnowledgeCompilationError("SOURCE_PROVENANCE_INVALID", "A stable source link must be an approved HTTPS reference or omitted.");
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.hostname === "localhost"
      || url.hostname.endsWith(".localhost")
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
      || url.hostname.includes(":")
    ) {
      throw new Error("unsafe host");
    }
    const stable = `${url.origin}${url.pathname}`;
    if (stable.length > 512 || SENSITIVE_TEXT.test(decodeURIComponent(url.pathname))) {
      throw new Error("sensitive path");
    }
    return stable;
  } catch {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "A stable source link must be a short, approved HTTPS reference without credentials, parameters, or sensitive details."
    );
  }
}

function normalizedPrivacy(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRIVACY_RESTRICTIONS.size) {
    throw new KnowledgeCompilationError("PRIVACY_RESTRICTION_REQUIRED", `${field} must include at least one recognized privacy restriction.`);
  }
  const normalized = [...new Set(value.map((restriction) => typeof restriction === "string" ? restriction.trim() : ""))].sort();
  if (normalized.some((restriction) => !PRIVACY_RESTRICTIONS.has(restriction))) {
    throw new KnowledgeCompilationError(
      "PRIVACY_RESTRICTION_INVALID",
      `${field} contains an unsupported privacy restriction. Keep the restriction explicit and bounded.`
    );
  }
  return normalized;
}

function normalizedOpaqueReferences(value, field, maxLength = 64) {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new KnowledgeCompilationError("SOURCE_PROVENANCE_INVALID", `${field} must be a bounded list of approved opaque references.`);
  }
  return [...new Set(value.map((reference) => assertOpaqueId(reference, "SOURCE_PROVENANCE_INVALID", field)))].sort();
}

function sourceEntryKey(source, accountId) {
  return `${source}:${encodeURIComponent(accountId)}`;
}

function recordFitsGrantMetadata(item, scope) {
  const containsOrEmpty = (value, allowed) => value == null || (Array.isArray(allowed) && allowed.includes(value));
  if (!containsOrEmpty(item.area, scope.areas)) return false;
  if (!containsOrEmpty(item.folder, scope.folders)) return false;
  if (!containsOrEmpty(item.channel, scope.channels)) return false;
  const conversation = item.kind === "conversation" ? item.id : (item.conversation ?? null);
  if (!containsOrEmpty(conversation, scope.conversations)) return false;
  if (!containsOrEmpty(item.category, scope.categories)) return false;

  const timestamp = item.timestamp ? Date.parse(item.timestamp) : null;
  if (scope.dateRange?.kind !== "selected-folders-only" && Number.isFinite(timestamp)) {
    if (timestamp < Date.parse(scope.dateRange.from) || timestamp > Date.parse(scope.dateRange.to)) return false;
    if ((scope.exclusions?.dateRanges ?? []).some((range) => timestamp >= Date.parse(range.from) && timestamp <= Date.parse(range.to))) return false;
  }

  if (!Array.isArray(item.participantIds)) return false;
  const participantIds = item.participantIds;
  const allowedPeople = new Set(Array.isArray(scope.people?.allowed) ? scope.people.allowed : []);
  const blockedPeople = new Set(Array.isArray(scope.people?.blocked) ? scope.people.blocked : []);
  const excludedPeople = participantIds.filter((personId) => scope.exclusions?.people?.includes(personId));
  const allowedBlockedGroupException = item.kind === "conversation"
    && item.isGroup === true
    && scope.blockedGroupConversationExceptions?.includes(item.id);
  if (allowedBlockedGroupException) {
    // A separately reviewed group can include only its explicitly selected
    // Allowed people plus the known Blocked people that justified the separate
    // exception. Restricted or unknown participants never hitchhike on it.
    if (participantIds.some((personId) => !allowedPeople.has(personId) && !blockedPeople.has(personId))) return false;
    if (excludedPeople.some((personId) => !blockedPeople.has(personId))) return false;
  } else if (excludedPeople.length > 0 || participantIds.some((personId) => !allowedPeople.has(personId))) {
    return false;
  }
  const declaredSensitive = item.sensitiveCategories == null
    ? []
    : Array.isArray(item.sensitiveCategories)
      ? item.sensitiveCategories
      : [item.sensitiveCategories];
  // Older/tampered metadata that carries an unrecognized sensitivity label
  // must never become ordinary content just because a prior normalizer dropped
  // it. Require a fresh metadata review instead.
  if (declaredSensitive.some((category) => typeof category !== "string" || !SENSITIVE_CATEGORIES.includes(category))) return false;
  if (item.uncertainSensitivity !== undefined && typeof item.uncertainSensitivity !== "boolean") return false;
  const sensitive = [...declaredSensitive, ...(item.uncertainSensitivity === true ? ["uncertain-sensitivity"] : [])];
  return !sensitive.some((category) => scope.sensitiveGroups?.excluded?.includes(category));
}

function isSubset(candidate, allowed) {
  return Array.isArray(candidate)
    && Array.isArray(allowed)
    && candidate.every((value) => allowed.includes(value));
}

function containsAll(candidate, required) {
  return Array.isArray(candidate)
    && Array.isArray(required)
    && required.every((value) => candidate.includes(value));
}

function sameDateWindow(left, right) {
  if (!left || !right) return false;
  return ["kind", "pastDays", "futureDays", "pastMonths", "from", "to", "label", "dateRangeAllowed"]
    .every((field) => (left[field] ?? null) === (right[field] ?? null));
}

function grantPreservesReviewedBoundary(grant, review) {
  const scope = grant?.scope;
  const requested = review?.requestedScope;
  if (!scope || !requested || scope.accountId !== requested.accountId || !sameDateWindow(scope.dateRange, requested.dateRange)) return false;
  for (const field of ["areas", "folders", "channels", "conversations", "categories"]) {
    if (!isSubset(scope[field], requested[field])) return false;
  }
  for (const field of ["allowed", "restricted", "blocked"]) {
    if (!isSubset(scope.people?.[field], requested.people?.[field])) return false;
  }
  for (const field of ["accounts", "areas", "folders", "channels", "people", "conversations", "categories", "dateRanges"]) {
    if (!containsAll(scope.exclusions?.[field], requested.exclusions?.[field])) return false;
  }
  if (!isSubset(scope.blockedGroupConversationExceptions, requested.blockedGroupConversationExceptions)) return false;
  if (!isSubset(scope.sensitiveGroups?.included, requested.sensitiveGroups?.included)) return false;
  if (!containsAll(scope.sensitiveGroups?.excluded, requested.sensitiveGroups?.excluded)) return false;
  return scope.acknowledgements?.modelProcessing === true && scope.acknowledgements?.untrustedSourceMaterial === true;
}

function assertActiveGrantForRecord(state, record) {
  const lifecycle = state?.sourcePermissionLifecycle;
  const entry = lifecycle?.entries?.[sourceEntryKey(record.source, record.accountId)];
  if (!entry || entry.status !== "granted" || entry.review?.id !== record.reviewId) {
    throw new KnowledgeCompilationError(
      "ACTIVE_GRANT_REQUIRED",
      "No active reviewed permission matches this record, so it was not staged or compiled."
    );
  }
  const grant = entry.grants?.find((candidate) => candidate.status === "active" && candidate.id === record.grantId);
  if (
    !grant
    || grant.source !== record.source
    || grant.accountId !== record.accountId
    || grant.reviewId !== record.reviewId
  ) {
    throw new KnowledgeCompilationError(
      "ACTIVE_GRANT_REQUIRED",
      "No active reviewed permission matches this record, so it was not staged or compiled."
    );
  }
  if (
    !grant.disclosuresAcknowledged?.modelProcessing?.acknowledged
    || !grant.disclosuresAcknowledged?.untrustedSourceMaterial?.acknowledged
    || !grantPreservesReviewedBoundary(grant, entry.review)
  ) {
    throw new KnowledgeCompilationError(
      "PERSISTED_GRANT_INVALID",
      "The saved permission no longer matches its reviewed boundary, so the record was not staged or compiled."
    );
  }
  const metadataItem = entry.review?.metadata?.items?.find((item) => item.id === record.sourceRecordId);
  if (!metadataItem || !recordFitsGrantMetadata(metadataItem, grant.scope)) {
    throw new KnowledgeCompilationError(
      "RECORD_OUTSIDE_APPROVED_SCOPE",
      "A record fell outside the saved granular permission scope, so it was not staged or compiled."
    );
  }
  return { grant, entry, metadataItem };
}

function normalizeInertStagingRecords(records, { maxRecords = MAX_BATCH_RECORDS } = {}) {
  if (!Array.isArray(records) || records.length === 0 || records.length > maxRecords) {
    throw new KnowledgeCompilationError("APPROVED_RECORDS_REQUIRED", `Provide between 1 and ${maxRecords} approved normalized records.`);
  }
  const seenRecords = new Set();
  return records.map((record) => {
    assertNoUnexpectedFields(record, RECORD_FIELDS, "approved record");
    if (typeof record.source !== "string" || !SOURCE_NAME.test(record.source)) {
      throw new KnowledgeCompilationError("SOURCE_REFERENCE_INVALID", "Each approved record must include a named source reference.");
    }
    const source = record.source;
    const accountId = assertOpaqueId(record.accountId, "ACCOUNT_REFERENCE_INVALID", "accountId");
    const sourceRecordId = assertOpaqueId(record.sourceRecordId, "SOURCE_REFERENCE_INVALID", "sourceRecordId");
    const reviewId = assertOpaqueId(record.reviewId, "REVIEW_REFERENCE_INVALID", "reviewId");
    const grantId = assertOpaqueId(record.grantId, "GRANT_REFERENCE_INVALID", "grantId");
    if (record.processingDisposition !== "untrusted-inert-reference") {
      throw new KnowledgeCompilationError(
        "UNTRUSTED_DISPOSITION_REQUIRED",
        "Approved records must remain untrusted inert references; source content is never treated as instructions."
      );
    }
    const key = `${source}\u0000${accountId}\u0000${sourceRecordId}\u0000${reviewId}\u0000${grantId}`;
    if (seenRecords.has(key)) {
      throw new KnowledgeCompilationError("DUPLICATE_SOURCE_RECORD", "Each approved source record may appear only once in a batch.");
    }
    seenRecords.add(key);

    const sourceTimestamp = canonicalTimestamp(record.sourceTimestamp, "SOURCE_TIMESTAMP_REQUIRED");
    const approvedParticipantRefs = normalizedOpaqueReferences(record.approvedParticipantRefs, "approvedParticipantRefs");
    const sourceLabel = safeNormalizedText(record.sourceLabel, { allowNull: true, field: "sourceLabel", maxLength: 160 });
    const stableLink = normalizedStableLink(record.stableLink);
    const observedAt = canonicalTimestamp(record.observedAt);
    const verifiedAt = canonicalOptionalTimestamp(record.verifiedAt);
    if (verifiedAt && Date.parse(verifiedAt) < Date.parse(observedAt)) {
      throw new KnowledgeCompilationError("VERIFICATION_DATE_INVALID", "A verified date cannot precede the observed date.");
    }
    const privacyRestrictions = normalizedPrivacy(record.privacyRestrictions, "record privacyRestrictions");
    if (!Array.isArray(record.assertions) || record.assertions.length === 0 || record.assertions.length > 32) {
      throw new KnowledgeCompilationError("ASSERTIONS_REQUIRED", "Each approved record must contain a bounded list of normalized assertions.");
    }
    const assertions = record.assertions.map((assertion) => {
      assertNoUnexpectedFields(assertion, ASSERTION_FIELDS, "normalized assertion");
      const subjectType = assertion.subjectType;
      if (!Object.hasOwn(SUBJECT_TYPES, subjectType)) {
        throw new KnowledgeCompilationError("SUBJECT_TYPE_INVALID", "A canonical assertion must use a supported people, organization, project, decision, priority, area, meeting, or knowledge subject.");
      }
      const subjectId = assertOpaqueId(assertion.subjectId, "SUBJECT_ID_INVALID", "subjectId");
      const subjectLabel = safeNormalizedText(assertion.subjectLabel, { field: "subjectLabel", maxLength: 120 });
      const text = safeNormalizedText(assertion.assertion, { allowNull: true, field: "assertion" });
      const confidence = assertion.confidence;
      if (!CONFIDENCE_LEVELS.has(confidence)) {
        throw new KnowledgeCompilationError("CONFIDENCE_INVALID", "Each assertion must state confirmed, likely, or uncertain confidence.");
      }
      if (text === null && confidence !== "uncertain") {
        throw new KnowledgeCompilationError("UNKNOWN_CONFIDENCE_INVALID", "An unknown assertion must remain uncertain instead of receiving invented confidence.");
      }
      const assertionPrivacy = assertion.privacyRestrictions == null
        ? privacyRestrictions
        : normalizedPrivacy(assertion.privacyRestrictions, "assertion privacyRestrictions");
      return {
        subjectType,
        subjectId,
        subjectLabel,
        assertion: text,
        confidence,
        privacyRestrictions: [...new Set([...privacyRestrictions, ...assertionPrivacy])].sort()
      };
    });
    return {
      source,
      accountId,
      sourceRecordId,
      reviewId,
      grantId,
      processingDisposition: "untrusted-inert-reference",
      sourceTimestamp,
      approvedParticipantRefs,
      sourceLabel,
      stableLink,
      observedAt,
      verifiedAt,
      privacyRestrictions,
      assertions
    };
  });
}

function neutralSourceLabel(source) {
  return `Approved ${source} reference`;
}

function approvedParticipantRefsForMetadata(metadataItem) {
  return normalizedOpaqueReferences(metadataItem.participantIds ?? [], "approved participant metadata");
}

function validateApprovedProvenance(record, metadataItem) {
  const sourceTimestamp = canonicalTimestamp(metadataItem.timestamp, "SOURCE_TIMESTAMP_REQUIRED");
  if (record.sourceTimestamp !== sourceTimestamp) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The source timestamp no longer matches the reviewed metadata, so the record was not compiled."
    );
  }
  const approvedParticipantRefs = approvedParticipantRefsForMetadata(metadataItem);
  if (JSON.stringify(record.approvedParticipantRefs) !== JSON.stringify(approvedParticipantRefs)) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The participant references do not exactly match the reviewed metadata, so the record was not compiled."
    );
  }

  let reviewedLabel = null;
  try {
    reviewedLabel = safeNormalizedText(metadataItem.label, { field: "reviewed sourceLabel", maxLength: 160 });
  } catch {
    // The caller can still use a neutral label if a reviewed metadata label is
    // not safe enough to retain in a generated note.
    reviewedLabel = null;
  }
  const neutralLabel = neutralSourceLabel(record.source);
  const usesNeutralLabel = record.sourceLabel === null || record.sourceLabel === neutralLabel;
  const sourceLabel = usesNeutralLabel ? neutralLabel : record.sourceLabel;
  if (!usesNeutralLabel && (!reviewedLabel || record.sourceLabel !== reviewedLabel)) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The source label does not exactly match a safe reviewed metadata label, so it was not compiled."
    );
  }

  const approvedStableLink = normalizedStableLink(metadataItem.stableLink);
  if (record.stableLink !== approvedStableLink) {
    throw new KnowledgeCompilationError(
      "SOURCE_PROVENANCE_INVALID",
      "The stable link does not exactly match the safe reviewed metadata reference, so it was not compiled."
    );
  }
  return { sourceTimestamp, approvedParticipantRefs, sourceLabel, stableLink: approvedStableLink };
}

function normalizeApprovedRecords(records, state) {
  return normalizeInertStagingRecords(records).map((record) => {
    const { metadataItem } = assertActiveGrantForRecord(state, record);
    return { ...record, ...validateApprovedProvenance(record, metadataItem) };
  });
}

function claimIdFor({ subjectType, subjectId, assertion, confidence }) {
  const fingerprint = JSON.stringify({ version: 1, subjectType, subjectId, assertion, confidence });
  return `claim-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 20)}`;
}

function minTimestamp(current, candidate) {
  return !current || Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function maxTimestamp(current, candidate) {
  if (!candidate) return current ?? null;
  return !current || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function sourceReferenceId(source) {
  return `${source.source}:${source.accountId}:${source.sourceRecordId}`;
}

function compileProjections(records, language, processedAt) {
  const claims = new Map();
  const noteLabels = new Map();
  for (const record of records) {
    for (const assertion of record.assertions) {
      const noteKey = `${assertion.subjectType}\u0000${assertion.subjectId}`;
      const knownLabel = noteLabels.get(noteKey);
      if (knownLabel && knownLabel !== assertion.subjectLabel) {
        throw new KnowledgeCompilationError(
          "SUBJECT_LABEL_CONFLICT",
          "Two approved records used different labels for the same canonical subject, so I stopped instead of inventing a merge."
        );
      }
      noteLabels.set(noteKey, assertion.subjectLabel);
      const id = claimIdFor(assertion);
      let claim = claims.get(id);
      if (!claim) {
        claim = {
          id,
          subjectType: assertion.subjectType,
          subjectId: assertion.subjectId,
          subjectLabel: assertion.subjectLabel,
          assertion: assertion.assertion,
          confidence: assertion.confidence,
          observedAt: record.observedAt,
          verifiedAt: record.verifiedAt,
          privacyRestrictions: [...assertion.privacyRestrictions],
          sourceReferences: []
        };
        claims.set(id, claim);
      } else {
        claim.observedAt = minTimestamp(claim.observedAt, record.observedAt);
        claim.verifiedAt = maxTimestamp(claim.verifiedAt, record.verifiedAt);
        claim.privacyRestrictions = [...new Set([...claim.privacyRestrictions, ...assertion.privacyRestrictions])].sort();
      }
      const source = {
        source: record.source,
        accountId: record.accountId,
        sourceRecordId: record.sourceRecordId,
        reviewId: record.reviewId,
        grantId: record.grantId,
        sourceTimestamp: record.sourceTimestamp,
        approvedParticipantRefs: [...record.approvedParticipantRefs],
        sourceLabel: record.sourceLabel,
        stableLink: record.stableLink,
        processedAt
      };
      if (!claim.sourceReferences.some((reference) => sourceReferenceId(reference) === sourceReferenceId(source) && reference.reviewId === source.reviewId && reference.grantId === source.grantId)) {
        claim.sourceReferences.push(source);
      }
    }
  }
  const orderedClaims = [...claims.values()]
    .map((claim) => ({
      ...claim,
      sourceReferences: claim.sourceReferences.sort((left, right) => sourceReferenceId(left).localeCompare(sourceReferenceId(right)))
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonicalNotes = buildCanonicalNotes(orderedClaims, language);
  const sourceIndexes = buildSourceIndexes(orderedClaims, canonicalNotes, language);
  return { claims: orderedClaims, canonicalNotes, sourceIndexes };
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_{}\[\]<>()#+|])/g, "\\$1");
}

function canonicalNotePath(subjectType, subjectId) {
  return `${SUBJECT_TYPES[subjectType].directory}/${subjectId}.md`;
}

function noteLink(notePath) {
  return `[[${notePath.slice(0, -3)}]]`;
}

function renderSourceReference(source, text) {
  const participantRefs = source.approvedParticipantRefs.length > 0
    ? source.approvedParticipantRefs.map((reference) => `\`${escapeMarkdown(reference)}\``).join(", ")
    : "—";
  const stableLink = source.stableLink
    ? `[${text.stableLink}](<${source.stableLink}>)`
    : text.noStableLink;
  return [
    `${text.sourceReference}: \`${escapeMarkdown(sourceReferenceId(source))}\` (${text.review} \`${escapeMarkdown(source.reviewId)}\`, ${text.grant} \`${escapeMarkdown(source.grantId)}\`)`,
    `${text.sourceTimestamp}: ${source.sourceTimestamp}`,
    `${text.participants}: ${participantRefs}`,
    `${text.sourceLabel}: ${escapeMarkdown(source.sourceLabel)}`,
    `${text.stableLink}: ${stableLink}`,
    `${text.processed}: ${source.processedAt}`
  ].join(" · ");
}

function buildCanonicalNotes(claims, language) {
  const text = wording(language);
  const notes = new Map();
  for (const claim of claims) {
    const key = `${claim.subjectType}\u0000${claim.subjectId}`;
    if (!notes.has(key)) {
      notes.set(key, {
        type: "canonical-subject-note",
        path: canonicalNotePath(claim.subjectType, claim.subjectId),
        subject: {
          type: claim.subjectType,
          id: claim.subjectId,
          label: claim.subjectLabel
        },
        ownership: {
          generatedSection: "qwave-generated-canonical-claims",
          userOwnedSection: "user-owned-notes"
        },
        claims: []
      });
    }
    notes.get(key).claims.push(claim);
  }
  return [...notes.values()]
    .map((note) => {
      note.claims.sort((left, right) => left.id.localeCompare(right.id));
      const typeLabel = SUBJECT_TYPES[note.subject.type][language];
      const generated = note.claims.map((claim) => {
        const value = claim.assertion === null ? text.unknown : escapeMarkdown(claim.assertion);
        const sourceRows = claim.sourceReferences
          .map((source) => `  - ${renderSourceReference(source, text)}`)
          .join("\n");
        return [
          `### ${text.claim} \`${claim.id}\``,
          "",
          value,
          "",
          `- ${text.confidence}: \`${claim.confidence}\``,
          `- ${text.observed}: ${claim.observedAt}`,
          `- ${text.verified}: ${claim.verifiedAt ?? text.notVerified}`,
          `- ${text.privacy}: ${claim.privacyRestrictions.map((restriction) => `\`${restriction}\``).join(", ")}`,
          `- ${text.sourceHeading}:`,
          sourceRows
        ].join("\n");
      }).join("\n\n");
      return {
        ...note,
        claimIds: note.claims.map((claim) => claim.id),
        content: [
          "---",
          "qwave_generated: true",
          "projection: canonical-subject-note",
          `subject_type: ${note.subject.type}`,
          `subject_id: ${note.subject.id}`,
          "---",
          "",
          `# ${escapeMarkdown(note.subject.label)}`,
          "",
          `${typeLabel} · ${text.simulated}`,
          "",
          `## ${text.generatedHeading}`,
          "",
          `> ${text.generatedBoundary}`,
          "",
          generated,
          "",
          `## ${text.yourNotesHeading}`,
          "",
          `> ${text.yourNotesBoundary}`,
          ""
        ].join("\n")
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildSourceIndexes(claims, canonicalNotes, language) {
  const text = wording(language);
  const noteBySubject = new Map(canonicalNotes.map((note) => [`${note.subject.type}\u0000${note.subject.id}`, note]));
  const indexes = new Map();
  for (const claim of claims) {
    const note = noteBySubject.get(`${claim.subjectType}\u0000${claim.subjectId}`);
    for (const source of claim.sourceReferences) {
      const key = `${source.source}\u0000${source.accountId}`;
      if (!indexes.has(key)) {
        indexes.set(key, {
          type: "source-index",
          path: `Sources/${source.source}--${source.accountId}.md`,
          source: source.source,
          accountId: source.accountId,
          entries: new Map()
        });
      }
      const index = indexes.get(key);
      const sourceKey = `${sourceReferenceId(source)}\u0000${source.reviewId}\u0000${source.grantId}`;
      if (!index.entries.has(sourceKey)) {
        index.entries.set(sourceKey, {
          sourceReferenceId: sourceReferenceId(source),
          reviewId: source.reviewId,
          grantId: source.grantId,
          sourceTimestamp: source.sourceTimestamp,
          approvedParticipantRefs: [...source.approvedParticipantRefs],
          sourceLabel: source.sourceLabel,
          stableLink: source.stableLink,
          processedAt: source.processedAt,
          canonicalNotePaths: new Set(),
          claimIds: new Set()
        });
      }
      const entry = index.entries.get(sourceKey);
      entry.canonicalNotePaths.add(note.path);
      entry.claimIds.add(claim.id);
    }
  }
  return [...indexes.values()]
    .map((index) => {
      const entries = [...index.entries.values()]
        .map((entry) => ({
          sourceReferenceId: entry.sourceReferenceId,
          reviewId: entry.reviewId,
          grantId: entry.grantId,
          sourceTimestamp: entry.sourceTimestamp,
          approvedParticipantRefs: entry.approvedParticipantRefs,
          sourceLabel: entry.sourceLabel,
          stableLink: entry.stableLink,
          processedAt: entry.processedAt,
          canonicalNotePaths: [...entry.canonicalNotePaths].sort(),
          claimIds: [...entry.claimIds].sort()
        }))
        .sort((left, right) => left.sourceReferenceId.localeCompare(right.sourceReferenceId));
      const rows = entries.map((entry) => [
        `- \`${escapeMarkdown(entry.sourceReferenceId)}\``,
        `  - ${entry.canonicalNotePaths.map(noteLink).join(", ")}`,
        `  - ${text.claimIds}: ${entry.claimIds.map((id) => `\`${id}\``).join(", ")}`,
        `  - ${text.sourceTimestamp}: ${entry.sourceTimestamp}`,
        `  - ${text.participants}: ${entry.approvedParticipantRefs.length > 0 ? entry.approvedParticipantRefs.map((reference) => `\`${escapeMarkdown(reference)}\``).join(", ") : "—"}`,
        `  - ${text.sourceLabel}: ${escapeMarkdown(entry.sourceLabel)}`,
        `  - ${text.stableLink}: ${entry.stableLink ? `[${text.stableLink}](<${entry.stableLink}>)` : text.noStableLink}`,
        `  - ${text.processed}: ${entry.processedAt}`
      ].join("\n")).join("\n");
      return {
        type: index.type,
        path: index.path,
        source: index.source,
        accountId: index.accountId,
        entries,
        content: [
          "---",
          "qwave_generated: true",
          "projection: source-index",
          `source: ${index.source}`,
          `account_id: ${index.accountId}`,
          "---",
          "",
          `# ${text.sourceIndexHeading}: ${escapeMarkdown(index.source)}`,
          "",
          `> ${text.sourceIndexBoundary}`,
          "",
          rows,
          ""
        ].join("\n")
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function compilationState(state) {
  if (!state[STATE_KEY]) state[STATE_KEY] = { version: 1, batches: {}, audit: [] };
  return state[STATE_KEY];
}

async function loadState(stateStore) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state) {
    throw new KnowledgeCompilationError(
      "SETUP_SESSION_NOT_FOUND",
      "Start your private second-brain setup and approve a source scope before compiling notes."
    );
  }
  return state;
}

function publicBatch(entry, language) {
  const text = wording(language);
  const base = {
    batchId: entry.batchId,
    status: entry.status,
    simulated: true,
    live: false,
    rawSourceBodiesRetained: false,
    staging: entry.staging ? {
      createdAt: entry.staging.createdAt,
      expiresAt: entry.staging.expiresAt,
      retention: entry.staging.retention,
      status: entry.staging.status ?? "available",
      deletedAt: entry.staging.deletedAt ?? null
    } : null
  };
  if (entry.status === "compiled") {
    return {
      ...base,
      retryable: false,
      message: text.ready,
      completedAt: entry.completedAt,
      canonicalNoteCount: entry.result.canonicalNotes.length,
      sourceIndexCount: entry.result.sourceIndexes.length,
      claimCount: entry.result.claims.length
    };
  }
  if (entry.status === "expired") {
    return { ...base, retryable: false, message: text.expired };
  }
  if (entry.status === "discarded") {
    return {
      ...base,
      retryable: entry.staging?.status === "discarded-pending-deletion",
      message: entry.staging?.status === "discarded-pending-deletion"
        ? "The approved permission is no longer valid. The private batch is queued for confirmed deletion; retry this cleanup receipt on this host."
        : "The temporary batch was discarded because its approved permission was no longer valid."
    };
  }
  return { ...base, retryable: true, message: text.interrupted };
}

function compiledResponse(entry, language) {
  return {
    compilation: publicBatch(entry, language),
    claims: clone(entry.result.claims),
    canonicalNotes: clone(entry.result.canonicalNotes),
    sourceIndexes: clone(entry.result.sourceIndexes),
    limitation: wording(language).simulated
  };
}

function safeFailureCode(error) {
  return error instanceof KnowledgeCompilationError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "TEMPORARY_STAGING_UNAVAILABLE";
}

function shouldDiscardAfterFailure(error) {
  return new Set([
    "ACTIVE_GRANT_REQUIRED",
    "PERSISTED_GRANT_INVALID",
    "RECORD_OUTSIDE_APPROVED_SCOPE",
    "STAGING_BATCH_INVALID",
    "STAGING_BATCH_MISSING",
    "STAGING_TIMESTAMP_INVALID",
    "STAGING_PAYLOAD_TOO_DEEP",
    "STAGING_SIZE_LIMIT",
    "STAGING_SYMLINK_BLOCKED",
    "RAW_SOURCE_FIELD_BLOCKED",
    "NORMALIZED_RECORD_INVALID",
    "NORMALIZED_TEXT_INVALID",
    "NORMALIZED_TEXT_UNSAFE",
    "SOURCE_REFERENCE_INVALID",
    "ACCOUNT_REFERENCE_INVALID",
    "REVIEW_REFERENCE_INVALID",
    "GRANT_REFERENCE_INVALID",
    "UNTRUSTED_DISPOSITION_REQUIRED",
    "SOURCE_TIMESTAMP_REQUIRED",
    "SOURCE_PROVENANCE_INVALID",
    "DUPLICATE_SOURCE_RECORD",
    "VERIFICATION_DATE_INVALID",
    "ASSERTIONS_REQUIRED",
    "SUBJECT_TYPE_INVALID",
    "SUBJECT_ID_INVALID",
    "CONFIDENCE_INVALID",
    "UNKNOWN_CONFIDENCE_INVALID",
    "PRIVACY_RESTRICTION_REQUIRED",
    "PRIVACY_RESTRICTION_INVALID",
    "SUBJECT_LABEL_CONFLICT"
  ]).has(safeFailureCode(error));
}

function stagingReceiptFromBatch(staged) {
  return {
    batchId: staged.batchId,
    createdAt: staged.createdAt,
    expiresAt: staged.expiresAt,
    retention: "delete-after-compilation-or-within-24-hours"
  };
}

function expiredBatchEntry({ batchId, now, language, staged = null }) {
  return {
    batchId,
    status: "expired",
    language,
    createdAt: staged?.createdAt ?? null,
    staging: {
      ...(staged ? stagingReceiptFromBatch(staged) : {}),
      status: "expired-deleted",
      deletedAt: now
    },
    audit: [{ type: "temporary-staging-expired", at: now, recoveredWithoutPersistedState: staged !== null }]
  };
}

function discardedBatchEntry({ batchId, now, language, staged = null, reason }) {
  return {
    batchId,
    status: "discarded",
    language,
    createdAt: staged?.createdAt ?? null,
    staging: {
      ...(staged ? stagingReceiptFromBatch(staged) : {}),
      status: "discarded",
      deletedAt: now
    },
    audit: [{ type: "temporary-batch-discarded", at: now, reason, recoveredWithoutPersistedState: staged !== null }]
  };
}

async function recoverUntrackedStagedBatch({ staging, batchId, state, expectedRecords, now }) {
  let staged;
  try {
    staged = await staging.read({ batchId });
  } catch (error) {
    if (error instanceof KnowledgeCompilationError && error.code === "STAGING_BATCH_MISSING") return null;
    throw error;
  }
  if (Date.parse(staged.expiresAt) <= Date.parse(now)) {
    await staging.delete({ batchId });
    return { expired: true, staged };
  }
  let records;
  try {
    records = normalizeApprovedRecords(staged.records, state);
  } catch (error) {
    if (!shouldDiscardAfterFailure(error)) throw error;
    try {
      await staging.delete({ batchId });
    } catch {
      // The lifecycle tombstone below prevents reuse, while later cleanup can
      // retry a filesystem deletion that was interrupted.
    }
    return { discarded: true, staged, error };
  }
  if (expectedRecords && JSON.stringify(records) !== JSON.stringify(expectedRecords)) {
    throw new KnowledgeCompilationError(
      "STAGING_BATCH_COLLISION",
      "That protected batch ID already belongs to different approved references. Choose a new opaque batch ID instead of replacing it."
    );
  }
  return { expired: false, staged, records, receipt: stagingReceiptFromBatch(staged) };
}

async function markExpiredBatches({ lifecycle, staging, now }) {
  const cleaned = await staging.cleanupExpired({ now });
  const retentionCoverageUnavailable = new Set(cleaned.retentionCoverageUnavailableBatchIds ?? []);
  const workerReceipts = new Set(cleaned.workerCompletionReceiptBatchIds ?? []);
  let changed = false;
  for (const batchId of workerReceipts) {
    const entry = lifecycle.batches[batchId];
    if (entry?.status === "compiled" && entry.staging?.status === "result-persisted-pending-deletion") {
      entry.staging = { ...entry.staging, status: "deleted-after-compilation", deletedAt: now };
      entry.audit.push({ type: "temporary-staging-deletion-receipt-consumed", at: now, by: "retention-worker" });
      lifecycle.audit.push({ type: "temporary-staging-deletion-receipt-consumed", at: now, batchId, by: "retention-worker" });
      changed = true;
    } else if (entry?.status === "discarded" && entry.staging?.status === "discarded-pending-deletion") {
      entry.staging = { ...entry.staging, status: "discarded", deletedAt: now };
      changed = true;
    }
  }
  for (const batchId of cleaned.removedBatchIds) {
    const entry = lifecycle.batches[batchId];
    if (retentionCoverageUnavailable.has(batchId) && entry?.status === "staged") {
      entry.status = "discarded";
      entry.staging = entry.staging ? { ...entry.staging, status: "discarded-retention-unavailable", deletedAt: now } : null;
      entry.audit.push({ type: "temporary-batch-discarded", at: now, reason: "RETENTION_SERVICE_UNAVAILABLE" });
      lifecycle.audit.push({ type: "temporary-batch-discarded", at: now, batchId, reason: "RETENTION_SERVICE_UNAVAILABLE" });
      changed = true;
    } else if (entry?.status === "staged") {
      entry.status = "expired";
      entry.staging = entry.staging ? { ...entry.staging, status: "expired-deleted", deletedAt: now } : null;
      entry.audit.push({ type: "temporary-staging-expired", at: now });
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId });
      changed = true;
    } else if (entry?.status === "compiled" && entry.staging?.status === "result-persisted-pending-deletion") {
      // The compiled projection was already durable before the retention
      // service removed its input. Preserve that result and accurately record
      // cleanup rather than misclassifying it as an expired compilation.
      entry.staging = { ...entry.staging, status: "deleted-after-compilation", deletedAt: now };
      entry.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, by: "retention-service" });
      lifecycle.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, batchId, by: "retention-service" });
      changed = true;
    } else if (!entry && retentionCoverageUnavailable.has(batchId)) {
      lifecycle.batches[batchId] = discardedBatchEntry({
        batchId,
        now,
        language: "en",
        reason: "RETENTION_SERVICE_UNAVAILABLE"
      });
      lifecycle.audit.push({ type: "temporary-batch-discarded", at: now, batchId, reason: "RETENTION_SERVICE_UNAVAILABLE", recoveredWithoutPersistedState: true });
      changed = true;
    } else if (!entry) {
      // A process may have staged the file successfully but crashed before its
      // state save. Keep a path-free tombstone so the same batch ID cannot be
      // revived after durable startup cleanup.
      lifecycle.batches[batchId] = expiredBatchEntry({ batchId, now, language: "en" });
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId, recoveredWithoutPersistedState: true });
      changed = true;
    }
  }
  return changed;
}

function resultFingerprint(result) {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function compiledResultWasPersisted(entry, expectedFingerprint) {
  return entry?.status === "compiled"
    && entry?.result
    && resultFingerprint(entry.result) === expectedFingerprint;
}

async function finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId, now }) {
  if (entry?.status !== "compiled" || entry.staging?.status !== "result-persisted-pending-deletion") return false;
  try {
    await staging.delete({ batchId });
  } catch {
    // The result is already durable. Keep the private staging receipt marked
    // pending so a later resume or the independently armed expiry worker can
    // complete deletion without losing the compiled projection.
    return false;
  }

  const previousStaging = clone(entry.staging);
  const previousAuditLength = entry.audit.length;
  const previousLifecycleAuditLength = lifecycle.audit.length;
  entry.staging = { ...entry.staging, status: "deleted-after-compilation", deletedAt: now };
  entry.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, by: "compiler" });
  lifecycle.audit.push({ type: "temporary-staging-deleted-after-result-persistence", at: now, batchId, by: "compiler" });
  try {
    await stateStore.save(state);
    return true;
  } catch {
    // Do not report a deletion receipt that was not durably recorded. The
    // source batch is already gone, and the prior durable compiled result will
    // reattempt this bookkeeping safely on a later read or resume.
    entry.staging = previousStaging;
    entry.audit.length = previousAuditLength;
    lifecycle.audit.length = previousLifecycleAuditLength;
    return false;
  }
}

async function persistCompiledResultBeforeDeleting({ stateStore, state, lifecycle, entry, batchId, result, now }) {
  const stagedEntry = clone(entry);
  const fingerprint = resultFingerprint(result);
  entry.status = "compiled";
  entry.completedAt = now;
  entry.staging = entry.staging ? {
    ...entry.staging,
    status: "result-persisted-pending-deletion",
    resultPersistedAt: now
  } : null;
  entry.result = result;
  entry.audit.push({
    type: "canonical-result-persisted",
    at: now,
    claimCount: result.claims.length,
    canonicalNoteCount: result.canonicalNotes.length,
    sourceIndexCount: result.sourceIndexes.length,
    temporaryBatchDeleted: false
  });
  lifecycle.audit.push({ type: "canonical-result-persisted", at: now, batchId, claimCount: result.claims.length });

  try {
    await stateStore.save(state);
  } catch {
    const persistedState = await stateStore.load().catch(() => null);
    const persistedEntry = persistedState?.[STATE_KEY]?.batches?.[batchId];
    if (compiledResultWasPersisted(persistedEntry, fingerprint)) {
      return {
        persisted: true,
        state: persistedState,
        lifecycle: persistedState[STATE_KEY],
        entry: persistedEntry
      };
    }
    return { persisted: false, stagedEntry };
  }

  const persistedState = await stateStore.load().catch(() => null);
  const persistedEntry = persistedState?.[STATE_KEY]?.batches?.[batchId];
  if (!compiledResultWasPersisted(persistedEntry, fingerprint)) {
    return { persisted: false, stagedEntry };
  }
  return {
    persisted: true,
    state: persistedState,
    lifecycle: persistedState[STATE_KEY],
    entry: persistedEntry
  };
}

function assertStagingAdapter(staging) {
  if (
    !staging
    || typeof staging.stage !== "function"
    || typeof staging.read !== "function"
    || typeof staging.delete !== "function"
    || typeof staging.cleanupExpired !== "function"
  ) {
    throw new TypeError("A bounded temporary staging adapter with stage(), read(), delete(), and cleanupExpired() is required.");
  }
}

/**
 * Compile one approved, bounded batch. First use stages the normalized records;
 * a later call with the same batch ID and no records safely resumes after a
 * temporary failure. The caller never receives a staging path or raw batch.
 */
export async function compileApprovedRecords(input) {
  return withSourcePermissionStateLock(input?.stateStore, () => compileApprovedRecordsLocked(input));
}

async function compileApprovedRecordsLocked({
  message,
  stateStore,
  staging,
  batchId,
  approvedRecords,
  language,
  clock
}) {
  assertNaturalLanguage(message);
  assertStagingAdapter(staging);
  const safeBatchId = assertBatchId(batchId);
  const now = isoNow(clock);
  let state = await loadState(stateStore);
  let lifecycle = compilationState(state);
  if (await markExpiredBatches({ lifecycle, staging, now })) await stateStore.save(state);

  let entry = lifecycle.batches[safeBatchId];
  const resolvedLanguage = languageFor(state, language);
  if (entry?.status === "compiled") {
    await finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
    return compiledResponse(entry, resolvedLanguage);
  }
  if (entry?.status === "expired" || entry?.status === "discarded") {
    throw new KnowledgeCompilationError("STAGING_EXPIRED", wording(resolvedLanguage).expired);
  }

  if (!entry) {
    let records = approvedRecords === undefined ? null : normalizeApprovedRecords(approvedRecords, state);
    let receipt;
    let reconciliation = null;
    if (records === null) {
      reconciliation = await recoverUntrackedStagedBatch({
        staging,
        batchId: safeBatchId,
        state,
        expectedRecords: null,
        now
      });
      if (!reconciliation) {
        // Keep the normal customer path explicit: a new batch must arrive as
        // approved normalized records, while an interrupted batch can resume
        // without resubmitting any source material.
        records = normalizeApprovedRecords(approvedRecords, state);
      }
    }
    if (reconciliation?.expired) {
      entry = expiredBatchEntry({ batchId: safeBatchId, now, language: resolvedLanguage, staged: reconciliation.staged });
      lifecycle.batches[safeBatchId] = entry;
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId: safeBatchId, recoveredWithoutPersistedState: true });
      await stateStore.save(state);
      throw new KnowledgeCompilationError("STAGING_EXPIRED", wording(resolvedLanguage).expired);
    }
    if (reconciliation?.discarded) {
      entry = discardedBatchEntry({
        batchId: safeBatchId,
        now,
        language: resolvedLanguage,
        staged: reconciliation.staged,
        reason: safeFailureCode(reconciliation.error)
      });
      lifecycle.batches[safeBatchId] = entry;
      lifecycle.audit.push({
        type: "temporary-batch-discarded",
        at: now,
        batchId: safeBatchId,
        reason: safeFailureCode(reconciliation.error),
        recoveredWithoutPersistedState: true
      });
      await stateStore.save(state);
      throw reconciliation.error;
    }
    if (reconciliation) {
      records = reconciliation.records;
      receipt = reconciliation.receipt;
    } else {
      try {
        receipt = await staging.stage({ batchId: safeBatchId, records, createdAt: now });
      } catch (error) {
        if (!(error instanceof KnowledgeCompilationError) || error.code !== "STAGING_BATCH_EXISTS") throw error;
        reconciliation = await recoverUntrackedStagedBatch({
          staging,
          batchId: safeBatchId,
          state,
          expectedRecords: records,
          now
        });
        if (!reconciliation?.expired) {
          records = reconciliation?.records ?? records;
          receipt = reconciliation?.receipt ?? receipt;
        }
      }
      if (reconciliation?.expired) {
        entry = expiredBatchEntry({ batchId: safeBatchId, now, language: resolvedLanguage, staged: reconciliation.staged });
        lifecycle.batches[safeBatchId] = entry;
        lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId: safeBatchId, recoveredWithoutPersistedState: true });
        await stateStore.save(state);
        throw new KnowledgeCompilationError("STAGING_EXPIRED", wording(resolvedLanguage).expired);
      }
      if (reconciliation?.discarded) {
        entry = discardedBatchEntry({
          batchId: safeBatchId,
          now,
          language: resolvedLanguage,
          staged: reconciliation.staged,
          reason: safeFailureCode(reconciliation.error)
        });
        lifecycle.batches[safeBatchId] = entry;
        lifecycle.audit.push({
          type: "temporary-batch-discarded",
          at: now,
          batchId: safeBatchId,
          reason: safeFailureCode(reconciliation.error),
          recoveredWithoutPersistedState: true
        });
        await stateStore.save(state);
        throw reconciliation.error;
      }
      if (!receipt) {
        throw new KnowledgeCompilationError("STAGING_BATCH_MISSING", "The protected temporary batch could not be safely reconciled. Approve a new batch before continuing.");
      }
    }
    entry = {
      batchId: safeBatchId,
      status: "staged",
      language: resolvedLanguage,
      createdAt: receipt.createdAt,
      staging: receipt,
      audit: [{
        type: reconciliation ? "approved-normalized-records-reconciled-after-state-save-interruption" : "approved-normalized-records-staged",
        at: now,
        recordCount: records.length
      }]
    };
    lifecycle.batches[safeBatchId] = entry;
    lifecycle.audit.push({
      type: reconciliation ? "approved-normalized-records-reconciled-after-state-save-interruption" : "approved-normalized-records-staged",
      at: now,
      batchId: safeBatchId,
      recordCount: records.length
    });
    await stateStore.save(state);
  } else if (approvedRecords !== undefined) {
    throw new KnowledgeCompilationError(
      "BATCH_ALREADY_STAGED",
      "This protected batch is already staged. Resume it without resubmitting records so it cannot be replaced."
    );
  }

  try {
    const staged = await staging.read({ batchId: safeBatchId });
    if (Date.parse(staged.expiresAt) <= Date.parse(now)) {
      await staging.delete({ batchId: safeBatchId });
      entry.status = "expired";
      entry.staging = entry.staging ? { ...entry.staging, status: "expired-deleted", deletedAt: now } : null;
      entry.audit.push({ type: "temporary-staging-expired", at: now });
      lifecycle.audit.push({ type: "temporary-staging-expired", at: now, batchId: safeBatchId });
      await stateStore.save(state);
      throw new KnowledgeCompilationError("STAGING_EXPIRED", wording(resolvedLanguage).expired);
    }

    // Re-load while holding the shared in-process lifecycle lock immediately
    // before producing a durable result. This catches a revocation completed
    // before this transaction and prevents same-process stale-root saves.
    state = await loadState(stateStore);
    lifecycle = compilationState(state);
    entry = lifecycle.batches[safeBatchId];
    if (entry?.status === "compiled") {
      await finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
      return compiledResponse(entry, resolvedLanguage);
    }
    if (!entry || entry.status !== "staged") {
      throw new KnowledgeCompilationError(
        "COMPILATION_STATE_CONFLICT",
        "The protected batch changed while it was being compiled, so no canonical result was written. Resume from the current private state."
      );
    }
    const records = normalizeApprovedRecords(staged.records, state);
    const result = compileProjections(records, resolvedLanguage, now);
    const persisted = await persistCompiledResultBeforeDeleting({
      stateStore,
      state,
      lifecycle,
      entry,
      batchId: safeBatchId,
      result,
      now
    });
    if (!persisted.persisted) {
      // Never delete the staged batch when the derived result is not known to
      // be durably saved. A normal-language resume will re-read this same
      // bounded stage instead of losing or inventing a result.
      return {
        compilation: publicBatch(persisted.stagedEntry, resolvedLanguage),
        interruption: { code: "RESULT_STATE_SAVE_FAILED", retryable: true },
        limitation: wording(resolvedLanguage).simulated
      };
    }
    state = persisted.state;
    lifecycle = persisted.lifecycle;
    entry = persisted.entry;
    await finalizePersistedCompilationCleanup({ state, lifecycle, entry, stateStore, staging, batchId: safeBatchId, now });
    return compiledResponse(entry, resolvedLanguage);
  } catch (error) {
    if (error instanceof KnowledgeCompilationError && error.code === "STAGING_EXPIRED") throw error;
    if (error instanceof KnowledgeCompilationError && error.code === "COMPILATION_STATE_CONFLICT") throw error;
    if (shouldDiscardAfterFailure(error)) {
      let deleted = false;
      try { deleted = await staging.delete({ batchId: safeBatchId }); } catch {}
      entry.status = "discarded";
      entry.staging = entry.staging ? {
        ...entry.staging,
        status: deleted ? "discarded" : "discarded-pending-deletion",
        deletedAt: deleted ? now : null
      } : null;
      entry.audit.push({ type: "temporary-batch-discarded", at: now, reason: safeFailureCode(error) });
      lifecycle.audit.push({ type: "temporary-batch-discarded", at: now, batchId: safeBatchId, reason: safeFailureCode(error) });
      await stateStore.save(state);
      throw error;
    }
    entry.audit.push({ type: "canonical-compilation-interrupted", at: now, reason: safeFailureCode(error) });
    lifecycle.audit.push({ type: "canonical-compilation-interrupted", at: now, batchId: safeBatchId, reason: safeFailureCode(error) });
    await stateStore.save(state);
    return {
      compilation: publicBatch(entry, resolvedLanguage),
      interruption: { code: safeFailureCode(error), retryable: true },
      limitation: wording(resolvedLanguage).simulated
    };
  }
}

/** Removes any expired temporary staging batch and makes its private state fail closed. */
export async function cleanupExpiredKnowledgeStaging(input) {
  return withSourcePermissionStateLock(input?.stateStore, () => cleanupExpiredKnowledgeStagingLocked(input));
}

async function cleanupExpiredKnowledgeStagingLocked({ stateStore, staging, clock }) {
  assertStateStore(stateStore);
  assertStagingAdapter(staging);
  const now = isoNow(clock);
  const state = await loadState(stateStore);
  const lifecycle = compilationState(state);
  const changed = await markExpiredBatches({ lifecycle, staging, now });
  if (changed) await stateStore.save(state);
  return {
    cleanup: {
      simulated: true,
      rawSourceBodiesRetained: false,
      expiredBatchIds: Object.values(lifecycle.batches)
        .filter((entry) => entry.status === "expired")
        .map((entry) => entry.batchId)
        .sort()
    }
  };
}

/** Read-only status. It never accesses source connectors or temporary batch contents. */
export async function getKnowledgeCompilationStatus(input) {
  return withSourcePermissionStateLock(input?.stateStore, () => getKnowledgeCompilationStatusLocked(input));
}

async function getKnowledgeCompilationStatusLocked({ stateStore, batchId, language }) {
  assertStateStore(stateStore);
  const state = await stateStore.load();
  if (!state?.[STATE_KEY]) return null;
  const entry = state[STATE_KEY].batches[assertBatchId(batchId)];
  if (!entry) return null;
  const resolvedLanguage = languageFor(state, language);
  return {
    compilation: publicBatch(entry, resolvedLanguage),
    result: entry.status === "compiled" ? {
      claimCount: entry.result.claims.length,
      canonicalNoteCount: entry.result.canonicalNotes.length,
      sourceIndexCount: entry.result.sourceIndexes.length
    } : null
  };
}

export const CANONICAL_SUBJECT_TYPES = Object.freeze(Object.keys(SUBJECT_TYPES));
export const TEMPORARY_STAGING_POLICY = Object.freeze({
  directoryName: STAGING_DIRECTORY_NAME,
  maxAgeHours: 24,
  maxRecords: MAX_BATCH_RECORDS,
  maxBytes: MAX_STAGING_BYTES,
  rawSourceBodiesAccepted: false
});
