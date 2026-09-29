// What the welcome guide (and `confidant status`) say about each of the six
// scheduled agents. The name and cadence always come from either the real
// created task (state.tasks) or, when it has not been created yet, from
// `confidant tasks spec`'s own builder: the exact rrule and name the install
// skill will use, so the guide can never drift from what actually gets
// created (no separate hardcoded default schedule to keep in sync). Order
// matches CONTRACTS.md.
import { describeRrule } from './e-rrule.mjs';
import { buildTaskSpec } from '../tasks.mjs';

export const AGENT_KEYS = ['brain_update', 'opportunity_scanner', 'morning_brief', 'meeting_prep', 'follow_up_radar', 'weekly_review'];

// blurb: one line, EN/ES, what the agent is for. Name and cadence are
// derived, not stored here (see agentRows).
export const AGENT_INFO = {
  brain_update: {
    blurb: {
      en: 'Tracks what you have promised and what you are owed, and pulls in anything new from your connected sources. Runs every 3 hours.',
      es: 'Rastrea lo que prometiste y lo que te deben, y trae lo nuevo de tus fuentes conectadas. Se ejecuta cada 3 horas.',
    },
  },
  opportunity_scanner: {
    blurb: {
      en: 'Looks for new leads and openings across your messages and meetings.',
      es: 'Busca nuevas oportunidades en tus mensajes y reuniones.',
    },
  },
  morning_brief: {
    blurb: {
      en: 'Your day, summarized: what is due, who is waiting on you, what is coming up.',
      es: 'Tu día resumido: qué vence, quién espera tu respuesta, qué se acerca.',
    },
  },
  meeting_prep: {
    blurb: {
      en: 'Walks into every meeting already caught up: who, history, promises, talking points.',
      es: 'Entra a cada reunión ya al tanto: quién es, historial, promesas, temas a tocar.',
    },
  },
  follow_up_radar: {
    blurb: {
      en: 'Flags promises and follow-ups that are at risk of slipping.',
      es: 'Marca promesas y seguimientos que podrían quedar pendientes.',
    },
  },
  weekly_review: {
    blurb: {
      en: 'A weekly look back: decisions made, deals moved, what is stalled.',
      es: 'Un repaso semanal: decisiones tomadas, negocios que avanzaron, qué está estancado.',
    },
  },
};

// One row per agent for the guide: the real created task's name and rrule
// when state has it, else the name and rrule `tasks spec` would create
// right now. `rrule` is included (not just the described cadence) so a
// caller can compute a next-occurrence time from it.
export function agentRows(config, state, lang = 'en') {
  const tasks = new Map((state?.tasks ?? []).map((t) => [t.key, t]));
  const spec = new Map(buildTaskSpec(config, { vault: config?.vault }).map((s) => [s.key, s]));
  return AGENT_KEYS.map((key) => {
    const info = AGENT_INFO[key];
    const task = tasks.get(key);
    const specEntry = spec.get(key);
    const rrule = task?.rrule ?? specEntry?.rrule ?? null;
    return {
      key,
      name: task?.name ?? specEntry?.name ?? key,
      blurb: info.blurb[lang] ?? info.blurb.en,
      scheduled: !!task,
      rrule,
      cadence: rrule ? describeRrule(rrule, lang) : '',
    };
  });
}
