// `confidant welcome [--open]`
// Writes <vault>/Confidant Guide.html (ES: Guía de Confidant.html): a single
// self-contained page, no remote assets, that tells the person what was
// installed, what is really connected, their folders, privacy and how to
// get help. Everything dynamic is HTML-escaped before it touches the page.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeFileAtomic } from './lib/files.mjs';
import { REPO_ROOT } from './lib/paths.mjs';
import { t, fill } from './lib/i18n.mjs';
import { escapeHtml, renderTemplate } from './lib/e-html.mjs';
import { sourceRows, folderRows } from './lib/e-report.mjs';
import { agentRows } from './lib/e-agents.mjs';

const GUIDE_FILENAME = { en: 'Confidant Guide.html', es: 'Guía de Confidant.html' };

function loadPersona(role) {
  if (!role) return null;
  return readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
}

function formatDate(iso, lang) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function section(heading, inner) {
  return `    <section>\n      <h2>${escapeHtml(heading)}</h2>\n${inner}\n    </section>`;
}

function card(inner) {
  return `      <div class="card">\n${inner}\n      </div>`;
}

function buildAgentsSection(tr, config, state, lang) {
  const rows = agentRows(config, state, lang);
  const items = rows.map((a) => card(
    `        <div class="row"><span class="label">${escapeHtml(a.name)}</span><span class="meta">${escapeHtml(a.scheduled ? a.cadence : tr('sections.whatItDoes.notScheduledYet'))}</span></div>\n` +
    (a.scheduled ? '' : `        <p class="small">${escapeHtml(fill(tr('sections.whatItDoes.planned'), { cadence: a.cadence }))}</p>\n`) +
    `        <p class="muted">${escapeHtml(a.blurb)}</p>`,
  )).join('\n');
  return section(tr('sections.whatItDoes.heading'), items);
}

function buildHowItWorks(tr) {
  const d = tr('sections.howItWorks.diagram');
  const diagram = `      <div class="diagram">\n` +
    `        <div class="box">${escapeHtml(d.sources)}</div><span class="arrow">&rarr;</span>` +
    `<div class="box">${escapeHtml(d.vault)}</div><span class="arrow">&rarr;</span>` +
    `<div class="box">${escapeHtml(d.agents)}</div>\n      </div>`;
  const body = `      <p>${escapeHtml(tr('sections.howItWorks.body'))}</p>`;
  return section(tr('sections.howItWorks.heading'), `${diagram}\n${body}`);
}

function buildHowToUse(tr, ctx, briefsFolderName) {
  const obsidianLink = `obsidian://open?path=${encodeURIComponent(ctx.vault)}`;
  const obsidian = fill(tr('sections.howToUse.obsidian'), { link: `<a href="${escapeHtml(obsidianLink)}">${escapeHtml(ctx.vault)}</a>` });
  const briefs = fill(tr('sections.howToUse.briefs'), { folder: `<code>${escapeHtml(briefsFolderName)}</code>` });
  const examples = tr('sections.howToUse.examples').map((q) => `        <li>&ldquo;${escapeHtml(q)}&rdquo;</li>`).join('\n');
  const inner = card(
    `        <p>${obsidian}</p>\n` +
    `        <p>${briefs}</p>\n` +
    `        <p>${escapeHtml(tr('sections.howToUse.scheduled'))}</p>\n` +
    `        <p>${escapeHtml(tr('sections.howToUse.ask'))}</p>\n` +
    `        <ul>\n${examples}\n        </ul>`,
  );
  return section(tr('sections.howToUse.heading'), inner);
}

function buildConnected(tr, trInstall, ctx) {
  const rows = sourceRows(ctx).filter((s) => s.enabled || s.count > 0);
  if (!rows.length) {
    return section(tr('sections.connected.heading'), card(`        <p class="muted">${escapeHtml(tr('sections.connected.empty'))}</p>`));
  }
  const items = rows.map((s) => {
    const meta = [fill(tr('sections.connected.recordsLabel'), { count: s.count })];
    if (s.lastSeen) meta.push(fill(tr('sections.connected.lastSeen'), { date: formatDate(s.lastSeen, ctx.lang) }));
    return `        <div class="row">\n` +
      `          <span class="label">${escapeHtml(s.label)} <span class="badge ${escapeHtml(s.status)}">${escapeHtml(trInstall(`sourceStatus.${s.status}`))}</span></span>\n` +
      `          <span class="meta">${escapeHtml(meta.join(', '))}</span>\n` +
      `        </div>` +
      (s.note ? `\n        <p class="small">${escapeHtml(s.note)}</p>` : '');
  }).join('\n');
  const inner = `${card(items)}\n      <p class="small">${escapeHtml(tr('sections.connected.backfilling'))}</p>`;
  return section(tr('sections.connected.heading'), inner);
}

function buildFolders(tr, ctx, persona) {
  const rows = folderRows(ctx);
  const subfoldersByFolder = new Map();
  for (const sub of persona?.subfolders ?? []) {
    const list = subfoldersByFolder.get(sub.folder) ?? [];
    list.push(sub.name?.[ctx.lang] ?? sub.name?.en ?? '');
    subfoldersByFolder.set(sub.folder, list);
  }
  const items = rows.map((f) => {
    const subs = subfoldersByFolder.get(f.key);
    const subLine = subs?.length
      ? `\n        <p class="small">${escapeHtml(tr('sections.folders.subfoldersLabel'))} ${escapeHtml(subs.join(', '))}</p>`
      : '';
    return `        <div class="row"><span class="label">${escapeHtml(f.name)}</span><span class="meta">${escapeHtml(fill(tr('sections.folders.notesLabel'), { count: f.count }))}</span></div>${subLine}`;
  }).join('\n');
  return section(tr('sections.folders.heading'), card(items));
}

function buildPrivacy(tr, trInstall, ctx) {
  const ex = ctx.config?.exclusions ?? {};
  const bits = [];
  for (const cat of ex.categories ?? []) bits.push(trInstall(`exclusionCategories.${cat}`));
  for (const name of ex.people ?? []) bits.push(name);
  for (const chat of ex.chats ?? []) bits.push(chat);
  for (const domain of ex.domains ?? []) bits.push(domain);
  for (const account of ex.emailAccounts ?? []) bits.push(account);
  const neverSees = bits.length
    ? `        <ul>\n${bits.map((b) => `          <li>${escapeHtml(b)}</li>`).join('\n')}\n        </ul>`
    : `        <p class="muted">${escapeHtml(tr('sections.privacy.neverSeesEmpty'))}</p>`;
  const inner = `${card(`        <p class="label">${escapeHtml(tr('sections.privacy.neverSees'))}</p>\n${neverSees}`)}\n` +
    `${card(`        <p class="label">${escapeHtml(tr('sections.privacy.whereItLives'))}</p>\n        <p>${escapeHtml(fill(tr('sections.privacy.whereItLivesBody'), { vault: ctx.vault }))}</p>`)}\n` +
    `${card(`        <p class="label">${escapeHtml(tr('sections.privacy.control'))}</p>\n        <p>${escapeHtml(tr('sections.privacy.controlBody'))}</p>`)}`;
  return section(tr('sections.privacy.heading'), inner);
}

function buildTroubleshooting(tr) {
  const items = tr('sections.troubleshooting.items').map((it) =>
    `        <p class="label">${escapeHtml(it.q)}</p>\n        <p class="muted">${escapeHtml(it.a)}</p>`).join('\n        <hr style="margin:14px 0">\n');
  return section(tr('sections.troubleshooting.heading'), card(items));
}

// Builds the full page. Pure aside from reading i18n/persona files and the
// store's counts, so it's easy to snapshot in tests with a fixture ctx.
export function renderGuide(ctx) {
  const lang = ctx.lang === 'es' ? 'es' : 'en';
  const tr = t('welcome', lang);
  const trInstall = t('install', lang);
  const persona = loadPersona(ctx.config?.role);
  const briefsFolderName = folderRows(ctx).find((f) => f.key === 'briefs')?.name ?? 'Briefs';

  const body = [
    buildAgentsSection(tr, ctx.config, ctx.state, lang),
    buildHowItWorks(tr),
    buildHowToUse(tr, ctx, briefsFolderName),
    buildConnected(tr, trInstall, ctx),
    buildFolders(tr, ctx, persona),
    buildPrivacy(tr, trInstall, ctx),
    buildTroubleshooting(tr),
  ].join('\n');

  const shellPath = join(REPO_ROOT, 'templates', 'welcome', 'shell.html');
  const shell = readFileSync(shellPath, 'utf8');
  const title = tr('title');
  const html = renderTemplate(shell, {
    lang,
    title: escapeHtml(title),
    tagline: escapeHtml(tr('tagline')),
    subtitle: escapeHtml(tr('subtitle')),
    body,
    supportLine: escapeHtml(fill(tr('supportLine'), { email: 'support@meetconfidant.com' })),
  });
  const filename = GUIDE_FILENAME[lang] ?? GUIDE_FILENAME.en;
  return { html, path: join(ctx.vault, filename), title };
}

export async function run(args, ctx, { exec = (cmd, a) => execFileSync(cmd, a) } = {}) {
  const { html, path } = renderGuide(ctx);
  if (!ctx.dryRun) {
    writeFileAtomic(path, html);
    ctx.saveState({ ...ctx.state, welcome: { path, at: new Date().toISOString() } });
  }
  if (args.open && !ctx.dryRun) {
    try { exec('open', [path]); } catch (err) { ctx.log.warn(`Could not open ${path}: ${err.message}`); }
  }
  ctx.log.out({ path, written: !ctx.dryRun }, () => `${ctx.dryRun ? 'Would write' : 'Wrote'} ${path}\n`);
  return 0;
}
