// `confidant keys set <name>`     opens a hidden macOS dialog and stores
//                                  the key in Keychain; the key is never
//                                  printed or logged.
// `confidant keys status`         which of deepgram, fathom, fireflies,
//                                  granola, readai, grain, tldv exist,
//                                  never their values.
import { getKey, promptForKey, KEY_NAMES } from './lib/c-keys.mjs';
import { t } from './lib/i18n.mjs';

const LABELS = { deepgram: 'Deepgram', fathom: 'Fathom', fireflies: 'Fireflies', granola: 'Granola', readai: 'Read.ai', grain: 'Grain', tldv: 'tl;dv' };

// ctx.getKey / ctx.promptForKey let tests inject a fake Keychain and a
// canned dialog answer (mirrors ctx.fetch / ctx.sleep in c-http.mjs); real
// runs never set them, so the defaults (the real Keychain, a real hidden
// dialog) apply.
export async function run(args, ctx) {
  const [sub, name] = args._;
  const tr = t('keys', ctx.lang);
  const readKey = ctx.getKey ?? getKey;
  const ask = ctx.promptForKey ?? promptForKey;

  if (sub === 'status') {
    const status = KEY_NAMES.map((n) => ({ name: n, label: LABELS[n] ?? n, set: !!readKey(n) }));
    ctx.log.out({ status }, () => status.map((s) => `${s.set ? tr('set') : tr('missing')}  ${s.label}`).join('\n'));
    return 0;
  }

  if (sub === 'set') {
    if (!name || !KEY_NAMES.includes(name)) {
      ctx.log.error(tr('unknownKey', { name: name ?? '', list: KEY_NAMES.join(', ') }));
      return 2;
    }
    if (ctx.dryRun) {
      ctx.log.out({ ok: true, dryRun: true }, tr('dryRun'));
      return 0;
    }
    const ok = await ask(name, LABELS[name] ?? name, { lang: ctx.lang });
    ctx.log.out({ ok }, ok ? tr('saved', { label: LABELS[name] ?? name }) : tr('cancelled'));
    return ok ? 0 : 1;
  }

  ctx.log.error(tr('usage'));
  return 2;
}
