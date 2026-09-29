// The nine folders every Confidant vault has, whatever the person's role.
// They match the site (content/en/install.ts). Personas add subfolders only.
export const FOLDERS = [
  { key: 'people', en: 'People', es: 'Personas' },
  { key: 'companies', en: 'Companies', es: 'Empresas' },
  { key: 'projects', en: 'Projects', es: 'Proyectos' },
  { key: 'decisions', en: 'Decisions', es: 'Decisiones' },
  { key: 'commitments', en: 'Commitments', es: 'Compromisos' },
  { key: 'ideas', en: 'Ideas', es: 'Ideas' },
  { key: 'meetings', en: 'Meetings', es: 'Reuniones' },
  { key: 'opportunities', en: 'Opportunities', es: 'Oportunidades' },
  { key: 'knowledge', en: 'Knowledge', es: 'Conocimiento' },
];

// Where the agents write: daily briefs, radar, weekly reviews.
export const BRIEFS = { key: 'briefs', en: 'Briefs', es: 'Resúmenes' };

export const FOLDER_KEYS = FOLDERS.map((f) => f.key);

export function folderName(key, lang = 'en') {
  const f = key === 'briefs' ? BRIEFS : FOLDERS.find((x) => x.key === key);
  if (!f) throw new Error(`Unknown folder key: ${key}`);
  return f[lang] ?? f.en;
}

// Vault-relative folder path, including an optional persona subfolder name.
export function folderPath(key, lang = 'en', subfolder) {
  const base = folderName(key, lang);
  return subfolder ? `${base}/${subfolder}` : base;
}
