import { writeFile } from "node:fs/promises";
import path from "node:path";

const [root, batchId, , leaseId, workerId] = process.argv.slice(2);
await writeFile(path.join(root, `env-observation-${batchId}.json`), `${JSON.stringify({
  inheritedSentinel: Object.hasOwn(process.env, "QWA146_RETENTION_SENTINEL"),
  environmentKeys: Object.keys(process.env).sort()
})}\n`, { encoding: "utf8", mode: 0o600 });

await new Promise((resolveSend, rejectSend) => {
  process.send?.({ type: "qwave-retention-armed", batchId, leaseId, workerId }, (error) => {
    if (error) rejectSend(error);
    else resolveSend();
  });
});
process.disconnect?.();
