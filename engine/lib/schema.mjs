// A small JSON Schema subset validator (zero dependencies). Supports: type,
// enum, const, required, properties, additionalProperties, items, minItems,
// maxItems, minLength, maxLength, minimum, maximum, pattern, format
// (date, date-time, time), anyOf, and local $ref ("#/$defs/name").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const cache = new Map();

export function loadSchema(name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(REPO_ROOT, 'schemas', `${name}.schema.json`), 'utf8')));
  return cache.get(name);
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (want, v) => {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
};

const FORMATS = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^([01]\d|2[0-3]):[0-5]\d$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/,
};

export function validate(schema, value, root = schema, path = '$', errors = []) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = root.$defs?.[name];
    if (!target) errors.push(`${path}: unknown $ref ${schema.$ref}`);
    else validate(target, value, root, path, errors);
    return errors;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value, root, path, []).length === 0);
    if (!ok) errors.push(`${path}: does not match any allowed shape`);
    return errors;
  }
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) errors.push(`${path}: not a valid ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, root, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: required`);
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) validate(props[key], v, root, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, root, `${path}.${key}`, errors);
    }
  }
  return errors;
}

export function check(name, value) {
  const schema = loadSchema(name);
  return validate(schema, value, schema);
}

export function assertValid(name, value) {
  const errors = check(name, value);
  if (errors.length) {
    const err = new Error(`Invalid ${name}:\n  ${errors.slice(0, 20).join('\n  ')}${errors.length > 20 ? `\n  ...and ${errors.length - 20} more` : ''}`);
    err.errors = errors;
    throw err;
  }
  return value;
}
