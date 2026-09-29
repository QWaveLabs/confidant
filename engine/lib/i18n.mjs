// Strings live in i18n/<namespace>.<lang>.json. Each unit owns its own
// namespace file so parallel work never collides. Spanish falls back to
// English per key. Templates use {name} placeholders.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const cache = new Map();

function load(ns, lang) {
  const key = `${ns}.${lang}`;
  if (!cache.has(key)) {
    try {
      cache.set(key, JSON.parse(readFileSync(join(REPO_ROOT, 'i18n', `${key}.json`), 'utf8')));
    } catch {
      cache.set(key, {});
    }
  }
  return cache.get(key);
}

export function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

export function t(ns, lang = 'en') {
  const primary = load(ns, lang);
  const fallback = lang === 'en' ? primary : load(ns, 'en');
  return (key, vars) => {
    const v = key.split('.').reduce((o, k) => o?.[k], primary) ?? key.split('.').reduce((o, k) => o?.[k], fallback);
    if (v == null) return key;
    return typeof v === 'string' ? fill(v, vars) : v;
  };
}
