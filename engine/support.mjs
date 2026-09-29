// `confidant support --kind support|feedback --message-file <path>
//     [--include-diagnostics]`
//     Prints a preview of exactly what would be sent. Nothing leaves the
//     Mac from this call alone.
// `confidant support --kind ... --message-file <path> [--include-diagnostics]
//     --send --yes`
//     Sends it, after the same preview. Codex only adds --send once the
//     person has explicitly asked to send a report, having seen the
//     preview first.
//
// Diagnostics are doctor + health + status counts only: never message
// content, contacts, source file names or API keys. doctor and health are
// loaded dynamically and their absence is tolerated (health.mjs may not
// exist yet); status is reduced to counts, dropping source notes, agent
// names and cadence sentences, since those can carry free text. Every
// string in the collected diagnostics then goes through a sanitizer that
// strips emails, phone numbers and paths under the home directory, since
// doctor's own Mail account names and vault paths are exactly that kind of
// thing.
//
// Rate limited locally (3 sends a day, 10 a month, tracked in
// state.support.sent) on top of whatever limit the server enforces. On a
// network failure, a 429, or a local rate limit, this prints a ready
// mailto:support@meetconfidant.com link with the same text instead of
// failing outright.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, HttpError } from './lib/c-http.mjs';
import { HOME, REPO_ROOT } from './lib/paths.mjs';

const REPORT_URL = 'https://meetconfidant.com/api/confidant/report';
const SUPPORT_EMAIL = 'support@meetconfidant.com';
const DAILY_LIMIT = 3;
const MONTHLY_LIMIT = 10;
const MONTH_MS = 31 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A run of 8+ digits with only phone-style punctuation between them
// (spaces, dashes, dots, parens, an optional leading +). Short digit runs
// like a version number or a port are left alone.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

function sanitizeString(s, home) {
  let out = String(s);
  if (home) out = out.split(home).join('~');
  out = out.replace(EMAIL_RE, '[redacted email]');
  out = out.replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[redacted phone]' : m));
  return out;
}

// Recursively strips emails, phone numbers and home-directory paths out of
// any diagnostics shape (doctor/health/status return plain nested
// objects/arrays of strings, numbers and booleans).
export function sanitizeDiagnostics(value, home = HOME) {
  if (typeof value === 'string') return sanitizeString(value, home);
  if (Array.isArray(value)) return value.map((v) => sanitizeDiagnostics(v, home));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDiagnostics(v, home)]));
  return value;
}

// Counts only: no source notes, no agent names, no cadence sentences, no
// folder or vault paths. Just enough to help debug without carrying any
// free text the status object otherwise includes.
export function statusCounts(status) {
  return {
    sourcesEnabled: status?.sources?.filter((s) => s.enabled).length ?? 0,
    sourcesConnected: status?.sources?.filter((s) => s.status === 'connected').length ?? 0,
    totalRecords: status?.sources?.reduce((sum, s) => sum + (s.count ?? 0), 0) ?? 0,
    notesWritten: status?.folders?.reduce((sum, f) => sum + (f.count ?? 0), 0) ?? 0,
    backlogRemaining: status?.backlog?.remaining_batches ?? null,
    backlogDone: !!status?.backlog?.done,
    lastUpdateAt: status?.lastUpdate?.at ?? null,
    lastUpdateInserted: status?.lastUpdate?.inserted ?? null,
    lastUpdateMerged: status?.lastUpdate?.merged ?? null,
    phase: status?.phase ?? null,
    agentsScheduled: status?.agents?.filter((a) => a.scheduled).length ?? 0,
  };
}

// doctor, health and status are imported dynamically so a missing module
// (health.mjs may not be built yet) never blocks a report; loaders are
// injectable so tests never touch the real Mac doctor.mjs would inspect.
export async function collectDiagnostics(ctx, {
  loadDoctor = () => import('./doctor.mjs'),
  loadHealth = () => import('./health.mjs'),
  loadStatus = () => import('./status.mjs'),
} = {}) {
  const out = { doctor: null, health: null, status: null };
  try {
    const mod = await loadDoctor();
    out.doctor = mod?.checkSystem ? await mod.checkSystem({ language: ctx.lang }) : null;
  } catch {
    // doctor not available in this build; report without it
  }
  try {
    const mod = await loadHealth();
    const build = mod?.checkHealth ?? mod?.buildHealth;
    out.health = build ? await build(ctx) : null;
  } catch {
    // health.mjs is not built yet
  }
  try {
    const mod = await loadStatus();
    out.status = mod?.buildStatus ? statusCounts(mod.buildStatus(ctx)) : null;
  } catch {
    // status not available
  }
  return sanitizeDiagnostics(out);
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function within(sent, now, ms) {
  const cutoff = now.getTime() - ms;
  return sent.filter((iso) => new Date(iso).getTime() > cutoff).length;
}

// Local rate limit, ahead of whatever the server enforces: gives a plain
// answer (and the mailto fallback) instead of a network error.
export function checkRateLimit(ctx, now = new Date()) {
  const sent = ctx.state?.support?.sent ?? [];
  const today = within(sent, now, DAY_MS);
  const month = within(sent, now, MONTH_MS);
  if (today >= DAILY_LIMIT) return { ok: false, reason: `Already sent ${DAILY_LIMIT} reports today. Try again tomorrow, or email ${SUPPORT_EMAIL} directly.` };
  if (month >= MONTHLY_LIMIT) return { ok: false, reason: `Already sent ${MONTHLY_LIMIT} reports this month. Email ${SUPPORT_EMAIL} directly if this is urgent.` };
  return { ok: true };
}

function recordSend(ctx, now = new Date()) {
  const sent = [...(ctx.state?.support?.sent ?? []), now.toISOString()].filter((iso) => new Date(iso).getTime() > now.getTime() - MONTH_MS);
  ctx.state = { ...ctx.state, support: { ...(ctx.state?.support ?? {}), sent } };
  ctx.saveState();
}

function mailtoLink(payload, lang) {
  const subject = lang === 'es' ? `Confidant: ${payload.kind === 'feedback' ? 'comentario' : 'soporte'}` : `Confidant ${payload.kind}`;
  const lines = [payload.message, ''];
  if (payload.diagnostics) {
    lines.push(lang === 'es' ? 'Diagnóstico:' : 'Diagnostics:', JSON.stringify(payload.diagnostics, null, 2), '');
  }
  lines.push(`install: ${payload.install_id ?? 'unknown'}`, `version: ${payload.version ?? 'unknown'}`, `language: ${payload.language}`);
  const body = lines.join('\n');
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function mailtoText(mailto, lang) {
  return lang === 'es' ? `Puedes enviarlo tú mismo desde tu correo:\n${mailto}\n` : `You can send it yourself from your own email:\n${mailto}\n`;
}

function previewText(preview, lang) {
  const p = preview.payload;
  const label = p.kind === 'feedback' ? (lang === 'es' ? 'comentario' : 'feedback') : lang === 'es' ? 'soporte' : 'support';
  const lines = [
    lang === 'es' ? `Vista previa (${label}):` : `Preview (${label}):`,
    '',
    p.message,
    '',
    p.diagnostics
      ? (lang === 'es' ? 'Incluye diagnóstico (usa --json para verlo completo).' : 'Includes diagnostics (use --json to see them in full).')
      : (lang === 'es' ? 'Sin diagnóstico.' : 'No diagnostics included.'),
    '',
    lang === 'es' ? 'No se ha enviado nada. Vuelve a ejecutar con --send --yes para enviarlo.' : 'Nothing has been sent. Run again with --send --yes to send it.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx, { loadDoctor, loadHealth, loadStatus } = {}) {
  const kind = args.kind;
  if (kind !== 'support' && kind !== 'feedback') {
    ctx.log.error('--kind must be "support" or "feedback".');
    return 2;
  }
  if (!args.messageFile) {
    ctx.log.error('--message-file <path> is required. Never pass message text directly on the command line.');
    return 2;
  }
  let message;
  try {
    message = readFileSync(args.messageFile, 'utf8').trim();
  } catch (err) {
    ctx.log.error(`Could not read ${args.messageFile}: ${err.message}`);
    return 2;
  }
  if (!message) {
    ctx.log.error('The message file is empty.');
    return 2;
  }

  const diagnostics = args.includeDiagnostics ? await collectDiagnostics(ctx, { loadDoctor, loadHealth, loadStatus }) : null;
  const payload = {
    install_id: ctx.config?.installId ?? null,
    kind,
    message,
    diagnostics,
    version: readVersion(),
    language: ctx.lang,
  };
  const preview = { payload };

  if (!args.send) {
    ctx.log.out(preview, () => previewText(preview, ctx.lang));
    return 0;
  }
  if (!args.yes) {
    ctx.log.error('--send needs --yes too: this leaves the Mac. Show the preview and only send once the person has explicitly agreed.');
    return 2;
  }
  if (ctx.dryRun) {
    ctx.log.out({ ...preview, sent: false, dryRun: true }, () => `${previewText(preview, ctx.lang)}\n(dry run: nothing was actually sent)\n`);
    return 0;
  }

  const limit = checkRateLimit(ctx);
  if (!limit.ok) {
    const mailto = mailtoLink(payload, ctx.lang);
    ctx.log.out({ ...preview, sent: false, reason: limit.reason, mailto }, () => `${limit.reason}\n\n${mailtoText(mailto, ctx.lang)}`);
    return 0;
  }

  try {
    await request(ctx, REPORT_URL, { method: 'POST', json: payload, retries: 1, source: 'confidant-support' });
    recordSend(ctx);
    ctx.log.out({ ...preview, sent: true }, () => (ctx.lang === 'es' ? 'Enviado. Gracias por el reporte.\n' : 'Sent. Thanks for the report.\n'));
    return 0;
  } catch (err) {
    const mailto = mailtoLink(payload, ctx.lang);
    const reason =
      err instanceof HttpError && err.status === 429
        ? ctx.lang === 'es'
          ? 'El servidor pidió esperar un poco.'
          : 'The server asked us to slow down.'
        : ctx.lang === 'es'
          ? 'No se pudo contactar al equipo de Confidant en este momento.'
          : 'Could not reach the Confidant team right now.';
    ctx.log.out({ ...preview, sent: false, reason, mailto }, () => `${reason}\n\n${mailtoText(mailto, ctx.lang)}`);
    return 0;
  }
}
