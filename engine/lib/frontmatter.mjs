// Note frontmatter: a small YAML subset that Obsidian reads natively.
// Supported values: strings, numbers, booleans, null, and lists of those
// (block "- item" or inline "[a, b]"). Wikilinks stay quoted strings.
const NEEDS_QUOTES = /^$|^[\s\-?:,[\]{}#&*!|>'"%@`]|: |:$|[\r\n]|\s#|^(true|false|null|yes|no|~)$|^[\d.+-]+$|\s$/i;

function scalarOut(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return NEEDS_QUOTES.test(s) || s.includes('[[') ? JSON.stringify(s) : s;
}

function scalarIn(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function splitInline(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === ']') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(scalarIn);
}

// Returns { data, body }. Notes without frontmatter give data = {}.
export function parseNote(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(scalarIn(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (rest.trim() === '') {
      data[key] = [];
      listKey = key;
    } else if (rest.trim().startsWith('[') && rest.trim().endsWith(']')) {
      data[key] = splitInline(rest.trim().slice(1, -1));
      listKey = null;
    } else {
      data[key] = scalarIn(rest);
      listKey = null;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

export function stringifyFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const v of value) lines.push(`  - ${scalarOut(v)}`);
      }
    } else lines.push(`${key}: ${scalarOut(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

export function composeNote(data, body) {
  return `${stringifyFrontmatter(data)}${body.startsWith('\n') ? body.slice(1) : body}`;
}
