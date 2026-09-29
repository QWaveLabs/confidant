// Shared shaping for meeting-transcript records across every API extractor
// (Fathom, Fireflies, Granola, Read.ai, Grain, tl;dv) and the derived recap
// extractor: one record per meeting, transcript as "Speaker: line" rows.
import { emailHandle, nameHandle } from './handles.mjs';

// utterances: [{speaker, text}] -> "Speaker: text" rows, blank lines and
// speakerless empty turns dropped.
export function transcriptText(utterances) {
  return (utterances ?? [])
    .map((u) => ({ speaker: (u?.speaker ?? '').trim() || 'Unknown', text: (u?.text ?? '').trim() }))
    .filter((u) => u.text)
    .map((u) => `${u.speaker}: ${u.text}`)
    .join('\n');
}

// A raw {name, email} style participant -> a record party, or null when
// neither is present. Prefers an email handle; falls back to a name handle
// so unaddressed speakers still identity-match by name.
export function party(p) {
  if (!p) return null;
  const name = p.name ?? null;
  const handle = (p.email && emailHandle(p.email)) ?? (name ? nameHandle(name) : null);
  return handle ? { handle, name } : null;
}

export function parties(list) {
  return (list ?? []).map(party).filter(Boolean);
}
