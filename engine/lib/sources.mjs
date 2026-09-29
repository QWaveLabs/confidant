// Every source Confidant knows. method:
//   local  - deterministic code reads a database or files on the Mac
//   api    - deterministic code calls the service with a key from Keychain
//   app    - Codex reads it through a connected app and hands records to `confidant ingest`
//   export - the person drops an export file into .confidant/exports/<source>/
//   derived- built from records already in the store (e.g. notetaker recap emails)
// needs: 'fda' (Full Disk Access for the ChatGPT app), 'key:<name>', 'app:<name>'.
// module paths are relative to engine/.
export const SOURCES = [
  { id: 'imessage', method: 'local', module: './extract/imessage.mjs', needs: ['fda'], label: { en: 'iMessage and SMS', es: 'iMessage y SMS' } },
  { id: 'whatsapp', method: 'local', module: './extract/whatsapp.mjs', needs: ['fda'], label: { en: 'WhatsApp', es: 'WhatsApp' } },
  { id: 'whatsapp_export', method: 'export', module: './extract/whatsapp-export.mjs', needs: [], label: { en: 'WhatsApp chat exports', es: 'Chats exportados de WhatsApp' } },
  { id: 'email', method: 'local', module: './extract/mail.mjs', needs: ['fda'], label: { en: 'Email (Mail app)', es: 'Correo (app Mail)' } },
  { id: 'calendar', method: 'local', module: './extract/calendar.mjs', needs: ['fda'], label: { en: 'Calendar', es: 'Calendario' } },
  { id: 'contacts', method: 'local', module: './extract/contacts.mjs', needs: ['fda'], label: { en: 'Contacts', es: 'Contactos' } },
  { id: 'calls', method: 'local', module: './extract/calls.mjs', needs: ['fda'], label: { en: 'Call history', es: 'Historial de llamadas' } },
  { id: 'call_recordings', method: 'local', module: './extract/call-recordings.mjs', needs: ['fda'], optional: ['key:deepgram'], label: { en: 'Phone call recordings', es: 'Grabaciones de llamadas' } },
  { id: 'voice_memos', method: 'local', module: './extract/voice-memos.mjs', needs: ['fda'], optional: ['key:deepgram'], label: { en: 'Voice Memos', es: 'Notas de voz' } },
  { id: 'wispr', method: 'local', module: './extract/wispr.mjs', needs: [], label: { en: 'Wispr Flow', es: 'Wispr Flow' } },
  { id: 'zoom_local', method: 'local', module: './extract/zoom-local.mjs', needs: [], optional: ['key:deepgram'], label: { en: 'Zoom recordings on this Mac', es: 'Grabaciones de Zoom en este Mac' } },
  { id: 'fathom', method: 'api', module: './extract/fathom.mjs', needs: ['key:fathom'], label: { en: 'Fathom', es: 'Fathom' } },
  { id: 'fireflies', method: 'api', module: './extract/fireflies.mjs', needs: ['key:fireflies'], label: { en: 'Fireflies', es: 'Fireflies' } },
  { id: 'granola', method: 'api', module: './extract/granola.mjs', needs: ['key:granola'], label: { en: 'Granola', es: 'Granola' } },
  { id: 'readai', method: 'api', module: './extract/readai.mjs', needs: ['key:readai'], label: { en: 'Read.ai', es: 'Read.ai' } },
  { id: 'grain', method: 'api', module: './extract/grain.mjs', needs: ['key:grain'], label: { en: 'Grain', es: 'Grain' } },
  { id: 'tldv', method: 'api', module: './extract/tldv.mjs', needs: ['key:tldv'], label: { en: 'tl;dv', es: 'tl;dv' } },
  { id: 'recaps', method: 'derived', module: './extract/recaps.mjs', needs: [], label: { en: 'Notetaker recap emails', es: 'Resúmenes de reuniones por correo' } },
  { id: 'gmail', method: 'app', module: null, needs: ['app:gmail'], label: { en: 'Gmail (Codex app)', es: 'Gmail (app de Codex)' } },
  { id: 'gcal', method: 'app', module: null, needs: ['app:google_calendar'], label: { en: 'Google Calendar (Codex app)', es: 'Google Calendar (app de Codex)' } },
  { id: 'drive', method: 'app', module: null, needs: ['app:google_drive'], label: { en: 'Google Drive and Meet notes', es: 'Google Drive y notas de Meet' } },
  { id: 'slack', method: 'app', module: null, needs: ['app:slack'], label: { en: 'Slack', es: 'Slack' } },
  { id: 'plaud', method: 'app', module: null, needs: ['app:plaud'], label: { en: 'Plaud', es: 'Plaud' } },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);
export const getSource = (id) => SOURCES.find((s) => s.id === id) ?? null;

// Sources the config has turned on, in registry order.
export function enabledSources(config) {
  return SOURCES.filter((s) => config?.sources?.[s.id]?.enabled);
}
