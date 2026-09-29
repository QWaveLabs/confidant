// `confidant status [--json]`
// What is connected, real counts, notes per folder, backlog and the
// scheduled tasks. This is the same data the welcome guide shows, read
// straight from config.json and state.json so it's always current.
import { sourceRows, folderRows } from './lib/e-report.mjs';
import { agentRows } from './lib/e-agents.mjs';

export function buildStatus(ctx) {
  return {
    vault: ctx.vault,
    language: ctx.lang,
    sources: sourceRows(ctx),
    folders: folderRows(ctx),
    backlog: ctx.state?.backlog ?? null,
    lastUpdate: ctx.state?.lastUpdate ?? null,
    agents: agentRows(ctx.config, ctx.state, ctx.lang),
    phase: ctx.state?.phase ?? 'start',
  };
}

function humanText(s) {
  const lines = [`Vault: ${s.vault}`, `Phase: ${s.phase}`, ''];
  lines.push('Sources:');
  for (const src of s.sources) {
    if (!src.enabled && src.count === 0) continue;
    lines.push(`  ${src.label}: ${src.status}, ${src.count} records${src.lastSeen ? ` (last ${src.lastSeen})` : ''}`);
  }
  lines.push('', 'Folders:');
  for (const f of s.folders) lines.push(`  ${f.name}: ${f.count} notes`);
  lines.push('', 'Agents:');
  for (const a of s.agents) lines.push(`  ${a.name}: ${a.scheduled ? 'scheduled' : 'not scheduled yet'}, ${a.cadence}`);
  if (s.backlog) lines.push('', `Backlog: ${s.backlog.remaining_batches ?? 0} batches left, oldest sorted ${s.backlog.oldest_sorted ?? 'n/a'}, done: ${!!s.backlog.done}`);
  if (s.lastUpdate) lines.push(`Last update: ${s.lastUpdate.at} (+${s.lastUpdate.inserted ?? 0} inserted, ${s.lastUpdate.merged ?? 0} merged)`);
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const status = buildStatus(ctx);
  ctx.log.out(status, humanText);
  return 0;
}
