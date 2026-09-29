// Why a source could not be read, as a stable code plus a calm sentence in
// the person's language. doctor, health and the welcome guide show `message`;
// logs keep the English `reason`.
//   needs_full_disk_access  not_installed  no_data  needs_key  unreadable  schema_changed
// Strings live in i18n/extract.<lang>.json: reasons.<code>, with optional
// per-source wording in bySource.<source id>.<code>.
import { t } from './i18n.mjs';
import { getSource } from './sources.mjs';

export const REASON_CODES = ['needs_full_disk_access', 'not_installed', 'no_data', 'needs_key', 'unreadable', 'schema_changed'];

const LOG = {
  needs_full_disk_access: 'needs Full Disk Access',
  not_installed: 'not set up on this Mac',
  no_data: 'nothing to read yet',
  needs_key: 'needs an API key',
  unreadable: 'could not be read',
  schema_changed: 'database format changed',
};

export function reasonMessage(lang, sourceId, code) {
  const language = lang === 'es' ? 'es' : 'en';
  const src = getSource(sourceId);
  const vars = { source: src?.label?.[language] ?? src?.label?.en ?? sourceId };
  const tr = t('extract', language);
  const key = `bySource.${sourceId}.${code}`;
  const specific = tr(key, vars);
  return typeof specific === 'string' && specific !== key ? specific : tr(`reasons.${code}`, vars);
}

// A failed probe result: { ok: false, reason, reason_code, message, needsFullDiskAccess?, needsKey?, ...extra }.
export function notOk(ctx, sourceId, code, reason, extra = {}) {
  return {
    ok: false,
    reason: reason ?? LOG[code],
    reason_code: code,
    message: reasonMessage(ctx?.lang, sourceId, code),
    ...(code === 'needs_full_disk_access' ? { needsFullDiskAccess: true } : {}),
    ...(code === 'needs_key' ? { needsKey: true } : {}),
    ...extra,
  };
}

export function codeForError(err) {
  if (err?.reason_code && REASON_CODES.includes(err.reason_code)) return err.reason_code;
  if (err?.needsFullDiskAccess || err?.code === 'EPERM' || err?.code === 'EACCES') return 'needs_full_disk_access';
  if (err?.needsKey) return 'needs_key';
  if (/no such (table|column)/i.test(err?.message ?? '')) return 'schema_changed';
  if (err?.code === 'ENOENT') return 'not_installed';
  return 'unreadable';
}

// Adds reason_code and a localized message (err.localized) to an error.
export function tagError(ctx, sourceId, err) {
  const code = codeForError(err);
  err.reason_code = code;
  err.localized = reasonMessage(ctx?.lang, sourceId, code);
  if (code === 'needs_full_disk_access') err.needsFullDiskAccess = true;
  return err;
}

// probe(ctx) that never throws: a failure becomes a coded result.
export function guardProbe(sourceId, fn) {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return notOk(ctx, sourceId, codeForError(err), err.message);
    }
  };
}

// extract(ctx, opts) whose errors carry reason_code and err.localized.
export function guardExtract(sourceId, fn) {
  return async (ctx, opts) => {
    try {
      return await fn(ctx, opts);
    } catch (err) {
      throw tagError(ctx, sourceId, err);
    }
  };
}
