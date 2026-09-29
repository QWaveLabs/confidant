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
