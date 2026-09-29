// What each privacy category means, in data. engine/privacy.mjs applies it.
// Matching is accent and case insensitive (text is folded before testing), so
// the Spanish patterns below are written without accents.
//
// Business payment tools (Stripe, PayPal, Square, QuickBooks, Xero, Bill.com,
// Brex, Ramp, Mercury) are deliberately NOT banking: they carry client and
// invoice context a business owner wants in their second brain.

// Email domains. A sender matches a domain or any subdomain of it.
export const BANKING_DOMAINS = [
  // US banks and cards
  'chase.com', 'jpmorgan.com', 'jpmorganchase.com', 'bankofamerica.com', 'bofa.com', 'ml.com', 'merrilledge.com', 'wellsfargo.com', 'wf.com',
  'capitalone.com', 'citi.com', 'citibank.com', 'citicards.com', 'americanexpress.com', 'aexp.com', 'discover.com', 'discovercard.com',
  'usbank.com', 'pnc.com', 'tdbank.com', 'td.com', 'truist.com', 'regions.com', 'citizensbank.com', 'huntington.com', 'keybank.com',
  'fifththird.com', 'navyfederal.org', 'usaa.com', 'synchrony.com', 'synchronybank.com', 'barclaycardus.com', 'barclays.com',
  'marcus.com', 'goldmansachs.com', 'bmoharris.com', 'bmo.com', 'firstrepublic.com', 'svb.com',
  // brokerages and crypto
  'schwab.com', 'fidelity.com', 'fmr.com', 'vanguard.com', 'robinhood.com', 'etrade.com', 'morganstanley.com', 'wealthfront.com',
  'betterment.com', 'acorns.com', 'stash.com', 'webull.com', 'interactivebrokers.com', 'ibkr.com', 'public.com', 'coinbase.com', 'kraken.com',
  // neobanks and personal money apps
  'sofi.com', 'sofi.org', 'ally.com', 'chime.com', 'chimebank.com', 'varo.com', 'current.com', 'venmo.com', 'cash.app',
  'zellepay.com', 'wise.com', 'revolut.com', 'n26.com',
  // lenders, credit and mortgages
  'rocketmortgage.com', 'quickenloans.com', 'mrcooper.com', 'loandepot.com', 'lendingclub.com', 'upstart.com', 'prosper.com', 'affirm.com',
  'klarna.com', 'afterpay.com', 'navient.com', 'nelnet.com', 'mohela.com', 'aidvantage.com', 'experian.com', 'equifax.com', 'transunion.com',
  'creditkarma.com', 'myfico.com', 'creditone.com', 'creditonebank.com',
  // Latin America and Spain
  'bbva.com', 'bbva.mx', 'bbva.es', 'bbvanet.com.mx', 'santander.com', 'santander.com.mx', 'santander.es', 'banorte.com', 'banamex.com',
  'citibanamex.com', 'bancolombia.com', 'bancolombia.com.co', 'itau.com', 'itau.com.br', 'itau.cl', 'nubank.com.br', 'nu.com.mx', 'nu.com.co',
  'scotiabank.com', 'scotiabank.com.mx', 'hsbc.com', 'hsbc.com.mx', 'bancoazteca.com.mx', 'inbursa.com', 'banregio.com', 'bancoppel.com',
  'viabcp.com', 'interbank.pe', 'bancoestado.cl', 'bancochile.cl', 'bancodebogota.com', 'davivienda.com', 'banreservas.com', 'popular.com',
  'bancopopular.com', 'bancomer.com', 'caixabank.es', 'bankinter.com', 'sabadell.com', 'ing.es', 'bancoprovincia.com.ar', 'galicia.ar',
  'bancogalicia.com.ar', 'macro.com.ar', 'bradesco.com.br', 'bb.com.br', 'caixa.gov.br', 'mercantilbanco.com', 'banesco.com',
];

// Domain labels that almost always mean a bank or credit union.
export const BANKING_DOMAIN_WORDS = /(^|[.-])[a-z0-9]*(bank|banco|banca|creditunion|federalcu)[a-z0-9]*\./;

// Names that are unambiguous anywhere in a sender or chat name.
export const BANK_NAMES = /\b(bank of america|bofa|wells fargo|capital one|citibank|citicards|american express|amex|us bank|u\.?s\.? bank|u s bank|charles schwab|schwab|robinhood|e\*? ?trade|navy federal|usaa|synchrony|marcus by goldman|bbva|bancomer|santander|banorte|banamex|citibanamex|bancolombia|itau|nubank|scotiabank|hsbc|banco azteca|bancoppel|inbursa|banregio|davivienda|banreservas|bradesco|bankinter|caixabank|sabadell|coinbase|credit karma|experian|equifax|transunion|venmo|cash app|zelle)\b/;

// Short brand names that are also first names or words ("Chase Smith",
// "Discover the city"). They only match as the whole name or next to a bank word.
export const BANK_AMBIGUOUS = ['chase', 'citi', 'discover', 'ally', 'chime', 'fidelity', 'vanguard', 'pnc', 'sofi', 'td', 'nu', 'current', 'affirm', 'klarna', 'wise', 'marcus', 'truist', 'regions'];
export const BANK_SUFFIX = /^(bank|banco|banca|card|cards|credit|credit card|alerts?|alertas|notificaciones|mexico|mx|usa|us|online|mobile|app|investments|financial|securities|brokerage|servicios)$/;

// Banking text: statements, balances and card alerts (EN and ES).
export const BANKING_TEXT = /\b(account ending( in)?|card ending( in)?|acct ending|ending in \d{4}|available balance|your balance|current balance|direct deposit|deposit of \$|zelle (payment|transfer)|overdraft|statement is (ready|available)|minimum payment|credit limit|fraud alert|suspicious (activity|transaction)|transaction (alert|of \$)|purchase of \$|debit card|credit card (payment|statement)|cuenta terminada en|tarjeta terminada en|terminacion \d{4}|saldo disponible|tu saldo|su saldo|deposito (de|por) \$|transferencia (spei|recibida|enviada)|spei|retiro (de|por)|cargo (de|por) \$|compra (de|por) \$|estado de cuenta|pago minimo|fecha limite de pago|limite de credito|alerta de fraude|movimiento (en|de) tu (cuenta|tarjeta))\b/;

export const HEALTH_DOMAINS = [
  'mychart.com', 'mychart.org', 'mychartcentral.com', 'epic.com', 'kp.org', 'kaiserpermanente.org', 'cvs.com', 'cvshealth.com', 'caremark.com',
  'walgreens.com', 'riteaid.com', 'zocdoc.com', 'onemedical.com', 'labcorp.com', 'questdiagnostics.com', 'goodrx.com', 'express-scripts.com',
  'expressscripts.com', 'optum.com', 'optumrx.com', 'anthem.com', 'aetna.com', 'cigna.com', 'uhc.com', 'myuhc.com', 'unitedhealthcare.com',
  'bcbs.com', 'bluecrossma.com', 'bluecross.com', 'bluecrossnc.com', 'floridablue.com', 'humana.com', 'teladoc.com', 'mdlive.com',
  'amwell.com', 'healow.com', 'followmyhealth.com', 'athenahealth.com', 'patientportal.com', 'nextmd.com', 'solv.com', 'hims.com', 'hers.com',
  'ro.co', 'talkspace.com', 'betterhelp.com', 'oscarhealth.com', 'hioscar.com', 'ambetter.com', 'medicare.gov',
  'healthcare.gov', 'imss.gob.mx', 'issste.gob.mx', 'farmaciasguadalajara.com', 'fahorro.com', 'farmaciasdelahorro.com.mx', 'benavides.com.mx',
  'farmaciasanpablo.com.mx', 'sanitas.es', 'sanitas.com', 'doctoralia.com', 'doctoralia.com.mx', 'doctolib.fr', 'salud.gob.mx', 'gnp.com.mx',
];
export const HEALTH_DOMAIN_WORDS = /(^|[.-])[a-z0-9]*(dental|dentist|dentista|clinic|clinica|medical|medico|hospital|pharmacy|farmacia|orthodont|dermatolog|pediatr|urgentcare|radiolog|optometr|chiropract|physicaltherapy|fisioterapia|laboratorio)[a-z0-9]*\./;
export const HEALTH_NAMES = /\b(mychart|kaiser permanente|cvs pharmacy|walgreens|rite aid|zocdoc|one medical|labcorp|quest diagnostics|goodrx|express scripts|optumrx|teladoc|farmacia|farmacias|pharmacy|dental|dentista|dentist|clinica|clinic|hospital|laboratorio|consultorio)\b/;

// Strong phrases only: "receta" alone is also a cooking recipe, "cita" alone
// is any meeting.
export const HEALTH_TEXT = /\b(lab results|test results (are|is) (ready|available|in)|your (test )?results are ready|your prescription|prescription (is )?ready|ready for pick ?up at (the )?pharmacy|refill (request|reminder|is ready)|patient portal|appointment (with|at) (dr|doctor)\b|dr\.? \w+'?s office|explanation of benefits|medical records|health insurance claim|copay|your doctor|telehealth visit|cita medica|cita (con|en) (el|la) (dr|dra|doctor|doctora|dentista|clinica|consultorio)|cita dental|resultados de (laboratorio|tus analisis|sus analisis|estudios)|receta medica|(tu|su) receta (esta )?lista|consulta medica|historia clinica|expediente (clinico|medico)|orden medica|seguro de gastos medicos|reclamo de seguro medico|tu medico|su medico)\b/;

// Calendar titles: health appointments (not "Dr. Smith" alone, who may be a PhD client).
export const HEALTH_EVENT = /\b(dentist|dental|doctor'?s? (appointment|visit)|physical therapy|physiotherapy|therapy session|therapist|psychiatrist|psychologist|dermatologist|pediatrician|ob ?gyn|gynecologist|colonoscopy|mammogram|mri|x-ray|blood ?work|blood test|vaccine|vaccination|flu shot|annual physical|medical checkup|cita medica|dentista|medico|doctora?|terapia|psicologo|psicologa|psiquiatra|dermatologo|pediatra|ginecologo|ginecologa|analisis de sangre|vacuna|chequeo medico)\b/;

export const PASSWORD_DOMAINS = ['1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'keepersecurity.com', 'nordpass.com', 'roboform.com', 'authy.com', 'duosecurity.com',];
export const PASSWORD_NAMES = /\b(1password|lastpass|bitwarden|dashlane|keeper security|nordpass|authy)\b/;

// Codes, resets and 2FA (EN and ES). Folded text, no accents.
export const PASSWORD_TEXT = new RegExp(
  [
    String.raw`\b(verification|security|one[- ]time|login|log[- ]in|sign[- ]in|authentication|2fa|otp|mfa|auth)\s+(code|pin|passcode)\b`,
    String.raw`\byour (code|pin|passcode|otp) is\b`,
    String.raw`\b\d{4,8}\s+is your\b.{0,40}\b(code|pin|passcode)\b`,
    String.raw`\bg-\d{6}\b`,
    String.raw`\b(password reset|reset your password|forgot your password|change your password|new password|temporary password|two[- ]factor|2-step verification|two-step verification|magic link|sign[- ]in link|login link)\b`,
    String.raw`\bcodigo de (verificacion|seguridad|acceso|confirmacion|inicio de sesion|autenticacion|un solo uso)\b`,
    String.raw`\b(tu|su) codigo (es|de)\b`,
    String.raw`\bclave (dinamica|temporal|de acceso|de seguridad|token)\b`,
    String.raw`\bcontrasena temporal\b`,
    String.raw`\b(restablecer|restablece|cambiar|cambia|recuperar|recupera) (tu |su |la )?contrasena\b`,
    String.raw`\bolvidaste (tu )?contrasena\b`,
    String.raw`\bverificacion en (dos|2) pasos\b`,
    String.raw`\b(password|contrasena|(?<!palabra )clave|pwd)\s*[:=]\s*\S+`,
  ].join('|'),
);

// Relatives, as contact names or chat names ("Mom", "Mamá Rosa", "Tío Juan").
// FAMILY_WHOLE must be the entire (folded) name. FAMILY_PREFIX allows one more
// word after it, for the few words that are never business names.
export const FAMILY_WHOLE = /^(my |mi )?(mom|mommy|mother|mum|mama|mami|madre|dad|daddy|father|papa|papi|padre|grandma|grandpa|granny|nana|abuela|abuelo|abuelita|abuelito|wife|husband|hubby|wifey|esposa|esposo|marido|sister|brother|sis|bro|hermana|hermano|hermanita|hermanito|aunt|auntie|uncle|tia|tio|cousin|prima|primo|son|daughter|hijo|hija|mother in law|father in law|suegra|suegro|cunado|cunada|nieta|nieto|sobrina|sobrino|babe|bebe|amor|mi amor|my love|honey|hubby)$/;
export const FAMILY_PREFIX = /^(my |mi )?(mom|mama|mami|dad|papa|papi|grandma|grandpa|abuela|abuelo|abuelita|abuelito|aunt|auntie|uncle|tia|tio|suegra|suegro|cunado|cunada|hermana|hermano|sobrina|sobrino) [a-z]+$/;
export const FAMILY_CHAT = /\b(family|familia|fam|primos|cousins|hermanos|siblings|los \w+ family)\b/;
export const FAMILY_EVENT = /\b(mom|dad|mama|papa|abuela|abuelo|grandma|grandpa|family dinner|cena familiar|reunion familiar)\b/;
export const FAMILY_NOT = /\b(family office|family business|family offices|oficina familiar|empresa familiar)\b/;

// Consumer mail domains, for the personal-email heuristic.
export const CONSUMER_MAIL = ['gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yahoo.com.mx', 'hotmail.es', 'outlook.es'];
