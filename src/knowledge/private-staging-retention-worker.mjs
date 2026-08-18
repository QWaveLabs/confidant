/**
 * Private local retention worker for QWA-146 staging.
 *
 * It accepts only a dedicated staging directory, an opaque batch ID, and an
 * expiry timestamp. It never reads, returns, logs, or forwards staged records.
 * The parent launches it detached so a compiler-process exit cannot leave the
 * scheduled deletion dependent on an in-memory timer.
 */

import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const STAGING_DIRECTORY_NAME = ".qwave-second-brain-staging";
const STAGING_FILE_PREFIX = "batch-";
const STAGING_FILE_SUFFIX = ".json";
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function safeArguments(argv) {
  const [rootInput, batchId, expiresAt] = argv;
  if (
    typeof rootInput !== "string"
    || !isAbsolute(rootInput)
    || basename(resolve(rootInput)) !== STAGING_DIRECTORY_NAME
    || typeof batchId !== "string"
    || !BATCH_ID.test(batchId)
    || typeof expiresAt !== "string"
    || !Number.isFinite(Date.parse(expiresAt))
  ) {
    return null;
  }
  return {
    root: resolve(rootInput),
    batchId,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

async function safeDeleteAtExpiry({ root, batchId }) {
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return;
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal || rootReal !== root) return;

  const filePath = resolve(root, `${STAGING_FILE_PREFIX}${batchId}${STAGING_FILE_SUFFIX}`);
  if (dirname(filePath) !== root) return;
  const stats = await lstat(filePath).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return;

  // The trusted parent armed this exact opaque filename before it wrote the
  // batch. Never inspect its records: after that independently scheduled
  // deadline, removing this one file is safer than retaining any malformed or
  // tampered private staging beyond the maximum retention window.
  await unlink(filePath).catch(() => undefined);
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
  await safeDeleteAtExpiry(job);
}

await main();
