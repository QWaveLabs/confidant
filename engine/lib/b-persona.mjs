// The person's role (personas/<role>.json, Unit D) shapes what the sorter
// looks for and which subfolders notes land in. Until a persona file exists
// the built-in default keeps everything working.
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { readJson } from './files.mjs';
import { check } from './schema.mjs';

export const DEFAULT_PERSONA = {
  id: 'founder',
  label: { en: 'Founder', es: 'Fundador' },
  focus: {
    en: 'Keep track of the people, companies and projects that move the business: promises made and owed, work handed to others, decisions and why they were made, open deals and introductions, and ideas worth coming back to.',
    es: 'Seguir a las personas, empresas y proyectos que mueven el negocio: promesas hechas y pendientes, trabajo delegado, decisiones y sus razones, oportunidades abiertas e introducciones, e ideas que vale la pena retomar.',
  },
  subfolders: [],
  personKinds: ['client', 'prospect', 'investor', 'partner', 'teammate', 'vendor', 'advisor', 'candidate', 'friend', 'family', 'other'],
  companyKinds: ['client', 'prospect', 'investor', 'partner', 'vendor', 'own', 'other'],
  opportunityFocus: ['pricing_ask', 'upsell', 'introduction', 'stalled_proposal', 'recurring_request', 'possible_product', 'renewal', 'lead'],
  bases: [],
};

// ctx.persona (tests, or a caller that already loaded one) wins.
export function loadPersona(ctx) {
  if (ctx.persona) return ctx.persona;
  const role = ctx.config?.role;
  let persona = DEFAULT_PERSONA;
  if (role) {
    let file = null;
    try {
      file = readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
    } catch (err) {
      ctx.log?.warn?.(`Persona ${role} could not be read (${err.message}). Using the default.`);
    }
    if (file) {
      const errors = check('persona', file);
      if (errors.length) ctx.log?.warn?.(`Persona ${role} has problems (${errors[0]}). Filling gaps with the default.`);
      persona = { ...DEFAULT_PERSONA, ...file };
    }
  }
  ctx.persona = persona;
  return persona;
}

export const personaText = (value, lang) => (value && typeof value === 'object' ? value[lang] ?? value.en ?? '' : String(value ?? ''));

// "kind in [portfolio, founder]" or 'status == "open"' against note fields.
function matchesRule(sf, data) {
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  if (sf.kinds?.length) return sf.kinds.map(norm).includes(norm(data.kind));
  const rule = String(sf.rule ?? '');
  const field = (name) => (name === 'type' && data.opportunity_type !== undefined ? data.opportunity_type : data[name]);
  let m = /^\s*(\w+)\s+in\s+\[([^\]]*)\]\s*$/i.exec(rule);
  if (m) {
    const values = m[2].split(',').map((v) => norm(v.replace(/["']/g, '')));
    return values.includes(norm(field(m[1])));
  }
  m = /^\s*(\w+)\s*==\s*["']?([^"']+)["']?\s*$/.exec(rule);
  if (m) return norm(field(m[1])) === norm(m[2]);
  return false;
}

// Persona subfolder name for a new note, or null for the top-level folder.
export function subfolderFor(persona, folderKey, data, lang = 'en') {
  for (const sf of persona?.subfolders ?? []) {
    if (sf.folder !== folderKey) continue;
    if (matchesRule(sf, data)) return personaText(sf.name, lang) || null;
  }
  return null;
}
