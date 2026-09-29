// `confidant welcome [--open]`
// Writes <vault>/Confidant Guide.html (ES: Guía de Confidant.html): a single
// self-contained page, no remote assets, that tells the person what was
// installed, what is really connected, their folders, privacy and how to
// get help. Everything dynamic is HTML-escaped before it touches the page.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeFileAtomic } from './lib/files.mjs';
import { REPO_ROOT, HOME } from './lib/paths.mjs';
import { t, fill } from './lib/i18n.mjs';
import { escapeHtml, renderTemplate, brandSvg, faviconLink } from './lib/e-html.mjs';
import { sourceRows, folderRows, summaryStats } from './lib/e-report.mjs';
import { agentRows } from './lib/e-agents.mjs';
import { nextWeeklyTime } from './lib/e-rrule.mjs';

const GUIDE_FILENAME = { en: 'Confidant Guide.html', es: 'Guía de Confidant.html' };

function loadPersona(role) {
  if (!role) return null;
  return readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
}

// The vault path as shown to the person: home replaced with ~, the way
// they'd type it themselves. The Obsidian link still uses the real
// absolute path; only display text is shortened.
function displayPath(p) {
  return p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
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

function buildAgentsSection(tr, rows) {
  const items = rows.map((a) => card(
    `        <div class="row"><span class="label">${escapeHtml(a.name)}</span><span class="meta">${escapeHtml(a.scheduled ? a.cadence : tr('sections.whatItDoes.notScheduledYet'))}</span></div>\n` +
    (a.scheduled ? '' : `        <p class="small">${escapeHtml(fill(tr('sections.whatItDoes.planned'), { cadence: a.cadence }))}</p>\n`) +
    `        <p class="muted">${escapeHtml(a.blurb)}</p>`,
  )).join('\n');
  return section(tr('sections.whatItDoes.heading'), items);
}

// A compact strip of real numbers under the title: sources connected, notes
// written, when the next morning brief runs, and whether the backlog sort
// is still filling in. Every value comes from the store, state.json or the
// real (or about-to-be-real) task schedule; nothing here is a placeholder.
function buildStats(tr, ctx, rows) {
  const stats = summaryStats(ctx);
  const morningBrief = rows.find((a) => a.key === 'morning_brief');
  const nextBrief = morningBrief?.rrule ? nextWeeklyTime(morningBrief.rrule, { now: ctx.now, tz: ctx.tz, lang: ctx.lang }) : null;
  const items = [
    { value: String(stats.sourcesConnected), label: tr('stats.sourcesConnected') },
    { value: String(stats.notesWritten), label: tr('stats.notesWritten') },
    { value: nextBrief ?? tr('stats.nextBriefNone'), label: tr('stats.nextBrief') },
    { value: stats.backlogDone ? tr('stats.caughtUp') : tr('stats.stillFilling'), label: tr('stats.history') },
  ];
  const tiles = items.map((i) => `      <div class="stat"><span class="stat-value">${escapeHtml(i.value)}</span><span class="stat-label">${escapeHtml(i.label)}</span></div>`).join('\n');
  return `    <div class="stats">\n${tiles}\n    </div>`;
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
  const obsidian = fill(tr('sections.howToUse.obsidian'), { link: `<a href="${escapeHtml(obsidianLink)}">${escapeHtml(displayPath(ctx.vault))}</a>` });
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
    `${card(`        <p class="label">${escapeHtml(tr('sections.privacy.whereItLives'))}</p>\n        <p>${escapeHtml(fill(tr('sections.privacy.whereItLivesBody'), { vault: displayPath(ctx.vault) }))}</p>`)}\n` +
    `${card(`        <p class="label">${escapeHtml(tr('sections.privacy.control'))}</p>\n        <p>${escapeHtml(tr('sections.privacy.controlBody'))}</p>`)}`;
  return section(tr('sections.privacy.heading'), inner);
}

function readVersion() {
  try {
    return readJson(join(REPO_ROOT, 'package.json'), {}).version ?? null;
  } catch {
    return null;
  }
}

// Same technique doctor.mjs uses for the rest of the system report, kept
// small and local here rather than pulling in doctor's much heavier
// Mail-account and Full-Disk-Access checks just for one line of a mailto
// summary.
function readMacOSVersion() {
  try {
    const xml = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    return xml.match(/<key>ProductVersion<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function relativeAge(iso, now, lang) {
  if (!iso) return lang === 'es' ? 'nunca' : 'never';
  const hours = Math.round((now.getTime() - new Date(iso).getTime()) / 3600000);
  if (hours < 1) return lang === 'es' ? 'hace menos de una hora' : 'less than an hour ago';
  if (hours < 24) return lang === 'es' ? `hace ${hours} horas` : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return lang === 'es' ? `hace ${days} días` : `${days} days ago`;
}

// A short, sanitized (no message content, no contacts, no file paths)
// diagnostic summary for the one-click "Email the Confidant team" button:
// version, macOS, sources connected, last update age, and any source the
// person's own config already flags as blocked. Real data only.
function buildDiagnosticSummary(ctx) {
  const stats = summaryStats(ctx);
  const blocked = sourceRows(ctx).filter((s) => s.status === 'blocked').map((s) => s.label);
  const lang = ctx.lang === 'es' ? 'es' : 'en';
  return {
    version: readVersion() ?? (lang === 'es' ? 'desconocida' : 'unknown'),
    macos: readMacOSVersion() ?? (lang === 'es' ? 'desconocido' : 'unknown'),
    sourcesConnected: stats.sourcesConnected,
    lastUpdateAge: relativeAge(ctx.state?.lastUpdate?.at, ctx.now, lang),
    issues: blocked.length ? blocked.join(', ') : lang === 'es' ? 'ninguno conocido' : 'none known',
  };
}

function supportMailtoLink(tr, ctx) {
  const d = buildDiagnosticSummary(ctx);
  const lines = ctx.lang === 'es'
    ? [`Versión: ${d.version}`, `macOS: ${d.macos}`, `Fuentes conectadas: ${d.sourcesConnected}`, `Última actualización: ${d.lastUpdateAge}`, `Problemas conocidos: ${d.issues}`]
    : [`Version: ${d.version}`, `macOS: ${d.macos}`, `Sources connected: ${d.sourcesConnected}`, `Last update: ${d.lastUpdateAge}`, `Known issues: ${d.issues}`];
  const subject = tr('sections.troubleshooting.emailSubject');
  const body = `${tr('sections.troubleshooting.emailBody')}\n\n${lines.join('\n')}`;
  return `mailto:support@meetconfidant.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildTroubleshooting(tr, ctx) {
  const items = tr('sections.troubleshooting.items').map((it) =>
    `        <p class="label">${escapeHtml(it.q)}</p>\n        <p class="muted">${escapeHtml(it.a)}</p>`).join('\n        <hr style="margin:14px 0">\n');
  const mailto = supportMailtoLink(tr, ctx);
  const button = card(
    `        <p class="muted">${escapeHtml(tr('sections.troubleshooting.emailIntro'))}</p>\n` +
    `        <p><a class="button" href="${escapeHtml(mailto)}">${escapeHtml(tr('sections.troubleshooting.emailButton'))}</a></p>`,
  );
  return section(tr('sections.troubleshooting.heading'), `${card(items)}\n${button}`);
}

// Builds the full page. Pure aside from reading i18n/persona files and the
// store's counts, so it's easy to snapshot in tests with a fixture ctx.
export function renderGuide(ctx) {
  const lang = ctx.lang === 'es' ? 'es' : 'en';
  const tr = t('welcome', lang);
  const trInstall = t('install', lang);
  const persona = loadPersona(ctx.config?.role);
  const briefsFolderName = folderRows(ctx).find((f) => f.key === 'briefs')?.name ?? 'Briefs';
  const rows = agentRows(ctx.config, ctx.state, lang);

  const body = [
    buildAgentsSection(tr, rows),
    buildHowItWorks(tr),
    buildHowToUse(tr, ctx, briefsFolderName),
    buildConnected(tr, trInstall, ctx),
    buildFolders(tr, ctx, persona),
    buildPrivacy(tr, trInstall, ctx),
    buildTroubleshooting(tr, ctx),
  ].join('\n');

  const shellPath = join(REPO_ROOT, 'templates', 'welcome', 'shell.html');
  const shell = readFileSync(shellPath, 'utf8');
  const title = tr('title');
  const html = renderTemplate(shell, {
    lang,
    favicon: faviconLink(brandSvg()),
    logo: brandSvg({ size: 34 }),
    title: escapeHtml(title),
    tagline: escapeHtml(tr('tagline')),
    subtitle: escapeHtml(tr('subtitle')),
    stats: buildStats(tr, ctx, rows),
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
