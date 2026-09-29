// What the welcome guide (and `confidant status`) say about each of the six
// scheduled agents. Names match schemas/task.schema.json and the automation
// names the install skill actually creates (CONTRACTS.md "Scheduled tasks"),
// so the guide always uses the same name the person sees in the ChatGPT
// Scheduled inbox. Order matches CONTRACTS.md.
import { describeRrule } from './e-rrule.mjs';
import { fill } from './i18n.mjs';

export const AGENT_KEYS = ['brain_update', 'opportunity_scanner', 'morning_brief', 'meeting_prep', 'follow_up_radar', 'weekly_review'];

// name: the literal automation name (not translated: it's what's created).
// blurb: one line, EN/ES, what the agent is for.
// defaultCadence: EN/ES sentence shown when no real task has been created yet.
export const AGENT_INFO = {
  brain_update: {
    name: 'Commitment Tracker + Brain Update',
    blurb: {
      en: 'Pulls in anything new from your connected sources and files it away.',
      es: 'Trae lo nuevo de tus fuentes conectadas y lo organiza.',
    },
    defaultCadence: { en: 'Every 3 hours, on the hour', es: 'Cada 3 horas, en punto' },
  },
  opportunity_scanner: {
    name: 'Opportunity Scanner',
    blurb: {
      en: 'Looks for new leads and openings across your messages and meetings.',
      es: 'Busca nuevas oportunidades en tus mensajes y reuniones.',
    },
    defaultCadence: { en: 'Weekdays, 15 minutes before your brief ({briefTime})', es: 'Lunes a viernes, 15 minutos antes de tu resumen ({briefTime})' },
  },
  morning_brief: {
    name: 'Morning Chief of Staff',
    blurb: {
      en: 'Your day, summarized: what is due, who is waiting on you, what is coming up.',
      es: 'Tu día resumido: qué vence, quién espera tu respuesta, qué se acerca.',
    },
    defaultCadence: { en: 'Weekdays at {briefTime}', es: 'Lunes a viernes a las {briefTime}' },
  },
  meeting_prep: {
    name: 'Meeting Prep',
    blurb: {
      en: 'Walks into every meeting already caught up: who, history, promises, talking points.',
      es: 'Entra a cada reunión ya al tanto: quién es, historial, promesas, temas a tocar.',
    },
    defaultCadence: { en: 'Weekdays, checking each half hour for meetings coming up', es: 'Lunes a viernes, revisa cada media hora si hay reuniones próximas' },
  },
  follow_up_radar: {
    name: 'Follow-Up Radar',
    blurb: {
      en: 'Flags promises and follow-ups that are at risk of slipping.',
      es: 'Marca promesas y seguimientos que podrían quedar pendientes.',
    },
    defaultCadence: { en: 'Weekdays at 16:00', es: 'Lunes a viernes a las 16:00' },
  },
  weekly_review: {
    name: 'Weekly CEO Review',
    blurb: {
      en: 'A weekly look back: decisions made, deals moved, what is stalled.',
      es: 'Un repaso semanal: decisiones tomadas, negocios que avanzaron, qué está estancado.',
    },
    defaultCadence: { en: 'Fridays at 15:00', es: 'Viernes a las 15:00' },
  },
};

// One row per agent for the guide: the real created task when state has it
// (so the time shown is the actual schedule, not an assumption), or the
// default description when it hasn't been created yet.
export function agentRows(config, state, lang = 'en') {
  const briefTime = config?.briefTime ?? '06:45';
  const tasks = new Map((state?.tasks ?? []).map((t) => [t.key, t]));
  return AGENT_KEYS.map((key) => {
    const info = AGENT_INFO[key];
    const task = tasks.get(key);
    return {
      key,
      name: task?.name ?? info.name,
      blurb: info.blurb[lang] ?? info.blurb.en,
      scheduled: !!task,
      cadence: task ? describeRrule(task.rrule, lang) : fill(info.defaultCadence[lang] ?? info.defaultCadence.en, { briefTime }),
    };
  });
}
