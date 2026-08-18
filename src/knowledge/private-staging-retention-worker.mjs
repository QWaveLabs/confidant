/**
 * Private local retention worker for QWA-146 staging.
 *
 * It receives only a dedicated private root, opaque batch/generation IDs, and
 * a fixed deadline. Generation-specific filenames make an old worker unable
 * to unlink a later reuse of the same batch ID. It never reads staged records,
 * logs content, or inherits the compiler's environment.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const STAGING_DIRECTORY_NAME = ".qwave-second-brain-staging";
const STAGING_FILE_PREFIX = "batch-";
const STAGING_VERSION = 1;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const POLL_MS = 250;
const HEARTBEAT_MS = 1_000;

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const canonical = new Date(value).toISOString();
  return canonical === value ? canonical : null;
}

function generationTag(leaseId) {
  return createHash("sha256").update(leaseId).digest("hex").slice(0, 24);
}

function artifactPaths(root, batchId, leaseId) {
  const base = `${STAGING_FILE_PREFIX}${batchId}.${generationTag(leaseId)}`;
  return {
    data: resolve(root, `${base}.json`),
    lease: resolve(root, `${base}.lease.json`),
    receipt: resolve(root, `${base}.receipt.json`),
    tombstone: resolve(root, `${base}.tombstone.json`),
    owner: resolve(root, `${base}.owner.json`)
  };
}

function safeArguments(argv) {
  const [rootInput, batchId, expiresAt, leaseId, workerId] = argv;
  if (
    typeof rootInput !== "string"
    || !isAbsolute(rootInput)
    || basename(resolve(rootInput)) !== STAGING_DIRECTORY_NAME
    || typeof batchId !== "string"
    || !BATCH_ID.test(batchId)
    || !canonicalTimestamp(expiresAt)
    || typeof leaseId !== "string"
    || !OPAQUE_ID.test(leaseId)
    || typeof workerId !== "string"
    || !OPAQUE_ID.test(workerId)
  ) return null;
  return { root: resolve(rootInput), batchId, expiresAt, leaseId, workerId };
}

async function pathAbsent(target) {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function durableJsonWrite(target, value, { exclusive = false } = {}) {
  const temporary = exclusive ? target : `${target}.${process.pid}.tmp`;
  let handle;
  let created = false;
  let failure = null;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    created = true;
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try { await handle.close(); } catch (error) { failure ??= error; }
  }
  if (failure) {
    if (created) try { await unlink(temporary); } catch {}
    throw failure;
  }
  if (!exclusive) {
    try {
      await rename(temporary, target);
    } catch (error) {
      try { await unlink(temporary); } catch {}
      throw error;
    }
  }
  await syncDirectory(dirname(target));
}

async function readJson(target) {
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) throw new Error("unsafe retention artifact");
  return JSON.parse(await readFile(target, "utf8"));
}

function ownerMatches(owner, job) {
  return Boolean(owner?.version === STAGING_VERSION
    && owner.batchId === job.batchId
    && owner.leaseId === job.leaseId
    && owner.expiresAt === job.expiresAt
    && owner.workerId === job.workerId
    && canonicalTimestamp(owner.startedAt)
    && canonicalTimestamp(owner.heartbeatAt));
}

async function readOwnedRecord(job) {
  const owner = await readJson(artifactPaths(job.root, job.batchId, job.leaseId).owner).catch(() => null);
  return ownerMatches(owner, job) ? owner : null;
}

async function refreshHeartbeat(job, owner) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  if (!ownerMatches(await readOwnedRecord(job), job)) return false;
  try {
    const now = new Date();
    await utimes(paths.owner, now, now);
    return true;
  } catch {
    return false;
  }
}

async function unlinkAndSync(target) {
  try {
    await unlink(target);
    await syncDirectory(dirname(target));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validTombstone(value, job) {
  return Boolean(value?.version === STAGING_VERSION
    && value.batchId === job.batchId
    && value.leaseId === job.leaseId
    && canonicalTimestamp(value.deleteStartedAt));
}

async function ensureTombstone(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const existing = await readJson(paths.tombstone).catch(() => null);
  if (existing) return validTombstone(existing, job);
  try {
    await durableJsonWrite(paths.tombstone, {
      version: STAGING_VERSION,
      batchId: job.batchId,
      leaseId: job.leaseId,
      deleteStartedAt: new Date().toISOString()
    }, { exclusive: true });
    return true;
  } catch {
    return false;
  }
}

async function removeOwnership(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  if (!await readOwnedRecord(job)) return;
  try { await unlinkAndSync(paths.owner); } catch {}
}

async function finalizeGenerationDeletion(job) {
  const rootStats = await lstat(job.root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return "superseded";
  const rootReal = await realpath(job.root).catch(() => null);
  if (!rootReal || rootReal !== job.root) return "superseded";
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  if (Object.values(paths).some((target) => dirname(target) !== job.root)) return "superseded";
  if (!await ensureTombstone(job)) return "retry";

  try { await unlinkAndSync(paths.data); } catch { return "retry"; }
  if (!await pathAbsent(paths.data).catch(() => false)) return "retry";
  try { await unlinkAndSync(paths.lease); } catch { return "retry"; }
  if (!await pathAbsent(paths.lease).catch(() => false)) return "retry";

  try {
    await durableJsonWrite(paths.receipt, {
      version: STAGING_VERSION,
      batchId: job.batchId,
      leaseId: job.leaseId,
      deletedAt: new Date().toISOString()
    });
  } catch {
    // Paths are already absent and the durable tombstone is content-free.
    // Keep ownership and retry until startup/resume acknowledges the tombstone
    // or the transient host failure clears.
    return "retry";
  }
  await removeOwnership(job);
  return "deleted";
}

async function shouldDeleteEarly(job) {
  const paths = artifactPaths(job.root, job.batchId, job.leaseId);
  const lease = await readJson(paths.lease).catch(() => null);
  const dataAbsent = await pathAbsent(paths.data).catch(() => false);
  if (!lease) return true;
  const validLease = lease.version === STAGING_VERSION
    && lease.batchId === job.batchId
    && lease.leaseId === job.leaseId
    && lease.expiresAt === job.expiresAt
    && ["prepared", "ready"].includes(lease.phase);
  if (!validLease) return Date.now() >= Date.parse(job.expiresAt);
  return lease.phase === "ready" && dataAbsent;
}

async function confirmSchedule(job) {
  if (typeof process.send !== "function") return false;
  try {
    await new Promise((resolveConfirmation, rejectConfirmation) => {
      process.send({
        type: "qwave-retention-armed",
        batchId: job.batchId,
        leaseId: job.leaseId,
        workerId: job.workerId
      }, (error) => error ? rejectConfirmation(error) : resolveConfirmation());
    });
    process.disconnect?.();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const job = safeArguments(process.argv.slice(2));
  if (!job || !await readOwnedRecord(job) || !await confirmSchedule(job)) return;
  let owner = await readOwnedRecord(job);
  let lastHeartbeat = Date.now();
  while (owner) {
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      if (!await refreshHeartbeat(job, owner)) return;
      owner = await readOwnedRecord(job);
      lastHeartbeat = Date.now();
      if (!owner) return;
    }
    if (Date.now() >= Date.parse(job.expiresAt) || await shouldDeleteEarly(job)) {
      const outcome = await finalizeGenerationDeletion(job).catch(() => "retry");
      if (outcome === "deleted" || outcome === "superseded") return;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_MS));
    owner = await readOwnedRecord(job);
  }
}

await main();
