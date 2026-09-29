import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus } from '../engine/status.mjs';
import { createContext } from '../engine/lib/context.mjs';

test('buildStatus reads real source counts, folder counts, backlog and tasks from the vault', () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-status-vault-'));
  mkdirSync(join(vault, '.confidant'), { recursive: true });
  writeFileSync(join(vault, '.confidant', 'config.json'), JSON.stringify({
    version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York',
    sources: { imessage: { enabled: true, status: 'connected' } },
  }));
  writeFileSync(join(vault, '.confidant', 'state.json'), JSON.stringify({
    phase: 'done',
    history: [],
    tasks: [{ key: 'weekly_review', name: 'Weekly CEO Review', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0', automation_id: 'xyz', created_at: '2026-09-01T00:00:00Z' }],
    backlog: { remaining_batches: 4, oldest_sorted: '2025-01-01', done: false },
    lastUpdate: { at: '2026-09-28T09:00:00Z', inserted: 12, merged: 3 },
  }));
  mkdirSync(join(vault, 'Companies'), { recursive: true });
  writeFileSync(join(vault, 'Companies', 'Acme.md'), '# Acme');

  const ctx = createContext({ vault, json: true });
  ctx.store.upsertRecords([{ id: 'imessage:1', source: 'imessage', kind: 'message', ts: '2026-09-01T00:00:00Z', text: 'hi', to: [], is_from_me: false }]);
  const status = buildStatus(ctx);

  assert.equal(status.phase, 'done');
  assert.equal(status.sources.find((s) => s.id === 'imessage').count, 1);
  assert.equal(status.folders.find((f) => f.key === 'companies').count, 1);
  assert.equal(status.backlog.remaining_batches, 4);
  assert.equal(status.lastUpdate.inserted, 12);
  const weekly = status.agents.find((a) => a.key === 'weekly_review');
  assert.equal(weekly.scheduled, true);
  assert.equal(weekly.cadence, 'Fridays at 15:00');
  ctx.close();
});
