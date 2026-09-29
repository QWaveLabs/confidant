// Install progress shared by the commands that record it (`config phase`)
// and the ones that must wait for it (`extract`, `ingest`).

// The last finished step, in order. `exclusions` sits between connecting
// the sources and reading them: the person reviews their group chats and
// people (`confidant chats`) and chooses what to leave out first.
export const PHASES = ['start', 'setup', 'connect', 'exclusions', 'extract', 'sort', 'tasks', 'finish', 'done'];

const BEFORE_EXCLUSIONS = new Set(['start', 'setup', 'connect']);

// True while an install has not yet recorded the exclusions review. Nothing
// is extracted or ingested until it has, so a person's excluded chats and
// people are never read in the first place. A vault that has already run a
// Brain Update (an older install that never recorded its phases) is past
// the install and is never held back.
export function exclusionsPending(state) {
  return !!state && BEFORE_EXCLUSIONS.has(state.phase) && !state.lastUpdate;
}

export const EXCLUSIONS_FIRST = 'Before anything is read, the person chooses what to leave out: run `confidant chats`, add exclusions with `confidant init --resume --exclude-chat/--exclude-person/--exclude-handle ...`, then record it with `confidant config phase exclusions`.';
