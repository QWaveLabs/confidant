// Must be the first import of the end-to-end test: engine/lib/paths.mjs
// reads the home folder once, when it loads, so HOME has to point at a temp
// folder before any engine module is imported. Imports nothing from engine/.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_HOME = mkdtempSync(join(tmpdir(), 'cf-b-e2e-home-'));
process.env.HOME = FAKE_HOME;
