/**
 * Private local retention worker for QWA-146 staging.
 *
 * It accepts only a dedicated staging directory, an opaque batch ID, and an
 * expiry timestamp. It never reads, returns, logs, or forwards staged records.
 * The parent launches it detached so a compiler-process exit cannot leave the
 * scheduled deletion dependent on an in-memory timer.
 */

import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const STAGING_DIRECTORY_NAME = ".qwave-second-brain-staging";
const STAGING_FILE_PREFIX = "batch-";
const STAGING_FILE_SUFFIX = ".json";
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function safeArguments(argv) {
  const [rootInput, batchId, expiresAt, leaseId] = argv;
  if (
    typeof rootInput !== "string"
    || !isAbsolute(rootInput)
    || basename(resolve(rootInput)) !== STAGING_DIRECTORY_NAME
    || typeof batchId !== "string"
    || !BATCH_ID.test(batchId)
    || typeof expiresAt !== "string"
    || !Number.isFinite(Date.parse(expiresAt))
    || typeof leaseId !== "string" || !BATCH_ID.test(leaseId)
  ) {
    return null;
  }
  return {
    root: resolve(rootInput),
    batchId,
    expiresAt: new Date(expiresAt).toISOString(),
    leaseId
  };
}

async function safeDeleteAtExpiry({ root, batchId, leaseId }) {
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return;
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal || rootReal !== root) return;

  const leasePath = resolve(root, `${STAGING_FILE_PREFIX}${batchId}.lease`);
  if ((await readFile(leasePath, "utf8").catch(() => "")).trim() !== leaseId) return "superseded";
  const filePath = resolve(root, `${STAGING_FILE_PREFIX}${batchId}${STAGING_FILE_SUFFIX}`);
  if (dirname(filePath) !== root) return;
  const stats = await lstat(filePath).catch(() => null);
  if (!stats) return "deleted";
  if (stats.isSymbolicLink() || !stats.isFile()) return "superseded";

  // The trusted parent armed this exact opaque filename before it wrote the
  // batch. Never inspect its records: after that independently scheduled
  // deadline, removing this one file is safer than retaining any malformed or
  // tampered private staging beyond the maximum retention window.
  try { await unlink(filePath); } catch { return "retry"; }
  if (await lstat(filePath).catch((error) => error?.code === "ENOENT" ? null : {})) return "retry";
  if ((await readFile(leasePath, "utf8").catch(() => "")).trim() !== leaseId) return "superseded";
  await unlink(leasePath).catch(() => undefined);
  const receipt = resolve(root, `${STAGING_FILE_PREFIX}${batchId}.receipt.json`);
  const temporary = `${receipt}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, batchId, leaseId, deletedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" }).then(() => rename(temporary, receipt)).catch(() => undefined);
  return "deleted";
}

async function confirmSchedule(batchId) {
  if (typeof process.send !== "function") return false;
  try {
    await new Promise((resolveConfirmation, rejectConfirmation) => {
      process.send({ type: "qwave-retention-armed", batchId }, (error) => {
        if (error) rejectConfirmation(error);
        else resolveConfirmation();
      });
    });
    process.disconnect?.();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const job = safeArguments(process.argv.slice(2));
  if (!job) return;
  const delay = Math.max(0, Date.parse(job.expiresAt) - Date.now());
  let timer;
  const expiry = new Promise((resolveExpiry) => {
    // Create the deadline timer before acknowledging readiness so the parent
    // cannot interpret a parsed-but-not-yet-scheduled worker as armed.
    timer = setTimeout(resolveExpiry, delay);
  });
  // The parent does not write the staging file until this one-purpose worker
  // has parsed the safe arguments and confirmed that its deadline is armed.
  if (!await confirmSchedule(job.batchId)) {
    clearTimeout(timer);
    return;
  }
  await expiry;
  while (true) {
    const outcome = await safeDeleteAtExpiry(job).catch(() => "retry");
    if (outcome === "deleted" || outcome === "superseded") return;
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
  }
}

await main();
