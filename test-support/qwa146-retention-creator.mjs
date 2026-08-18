// This fixture deliberately exits immediately after arming the independently
// supervised local cleanup worker. It passes only a private root, opaque batch
// ID, and expiry timestamp; it never creates, reads, or logs staging content.

import { DetachedLocalRetentionService } from "../src/knowledge/approved-record-compiler.mjs";

const [root, batchId, expiresAt] = process.argv.slice(2);
await new DetachedLocalRetentionService().arm({ root, batchId, expiresAt });
