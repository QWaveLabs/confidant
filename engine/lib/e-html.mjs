// Small HTML helpers for the welcome guide. No templating dependency: we
// build strings and always escape dynamic values before they touch markup.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Fills {{token}} placeholders in a template string. Unlike i18n's fill(),
// this is for whole HTML fragments (already escaped by the caller) rather
// than translated sentences, so it uses a distinct {{...}} syntax.
export function renderTemplate(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// The ring-C brand mark. Used both inline in the header and, via
// faviconLink(), as the page's favicon, so the two never drift apart. Pass
// `size` for the header's fixed-size version. No xmlns here: inline SVG in
// an HTML document inherits its namespace, and an xmlns value is itself a
// (never-fetched) http:// URI, which would otherwise trip a "no remote
// asset URLs" check on the page's own source.
export function brandSvg({ size } = {}) {
  const dims = size ? ` width="${size}" height="${size}"` : '';
  return (
    `<svg${dims} viewBox="0 0 512 512" role="img" aria-label="Confidant">` +
    `<rect width="512" height="512" rx="116" fill="#16181d"/>` +
    `<g transform="translate(64 64) scale(16)">` +
    `<path d="M18.39 6.25A8.6 8.6 0 1 0 18.39 17.75" fill="none" stroke="#f9fafb" stroke-width="2.4" stroke-linecap="round"/>` +
    `<circle cx="12" cy="12" r="2.5" fill="#e4512c"/>` +
    `</g></svg>`
  );
}

// A self-contained favicon <link>: the SVG mark inlined as a base64 data
// URI, so the page never issues a request for /favicon.ico. A standalone
// SVG document (unlike one inline in HTML) needs its own xmlns to be
// valid; it is added only here, inside the encoded copy, so it never shows
// up as literal page text.
export function faviconLink(svg) {
  const standalone = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const base64 = Buffer.from(standalone, 'utf8').toString('base64');
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${base64}">`;
}
