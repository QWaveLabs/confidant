// The golden scenario: a founder, a client (Acme), an investor, a group chat,
// a recorded meeting, a dictated idea, and automated noise. All fictional.
import { msg, email, meeting, contact, NOW } from './b-fixture.mjs';

const at = (daysAgo, hour = 15) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() - daysAgo, hour));

export const ANA = 'tel:+15550102000';
export const CARLA = 'tel:+5215512345678';

export function goldenRecords() {
  return [
    contact('ana', { names: ['Ana Ruiz'], phones: ['(555) 010-2000'], emails: ['ana@acme.com'], company: 'Acme', title: 'VP Operations' }),
    contact('me', { names: ['Sam Rivera'], phones: ['+1 305 555 0100'], emails: ['sam@rivera.co'], me: true }),
    msg('a1', { thread: 'imessage:ana', ts: at(6), from: ANA, fromName: 'Ana', text: 'Can you send the revised proposal by Friday? Legal wants it before the pilot review.' }),
    msg('a2', { thread: 'imessage:ana', ts: at(6, 16), me: true, to: [ANA], text: 'Yes, I will send it Thursday.' }),
    msg('a3', { thread: 'imessage:ana', ts: at(6, 17), from: ANA, text: 'thanks!' }),
    msg('a4', { thread: 'imessage:ana', ts: at(5), from: ANA, text: 'Liked “Yes, I will send it Thursday.”' }),
    email('e1', { ts: at(9), from: 'mailto:ana@acme.com', fromName: 'Ana Ruiz', to: ['mailto:sam@rivera.co'], subject: 'Pilot data', text: 'Attached is the pilot data from the first two weeks. Usage is up 40 percent.\n\nOn Mon, Sam Rivera wrote:\n> old quoted text' }),
    email('e2', { thread: 'email:contract', ts: at(4), from: 'mailto:ben@acme.com', fromName: 'Ben Cole', to: ['mailto:sam@rivera.co'], subject: 'Contract draft', text: 'Contract draft attached. Can we sign by October 15?' }),
    email('e3', { thread: 'email:contract', ts: at(4, 18), me: true, from: 'mailto:sam@rivera.co', fromName: 'Sam Rivera', to: ['mailto:ben@acme.com'], subject: 'Re: Contract draft', text: 'I will review it and get back to you by Monday. Can you loop in your legal team?\n\nSent from my iPhone' }),
    msg('c1', { source: 'whatsapp', thread: 'whatsapp:carla', ts: at(3), from: CARLA, fromName: 'Carla Diaz', text: 'Happy to introduce you to Dan Park at Northwind Ventures. He invests in pilots like yours.' }),
    msg('c2', { source: 'whatsapp', thread: 'whatsapp:carla', ts: at(3, 16), me: true, to: [CARLA], text: 'That would be great, thank you Carla.' }),
    msg('g1', { thread: 'imessage:team', ts: at(8), from: ANA, to: ['mailto:ben@acme.com'], text: 'Procurement needs two signatures on anything over 50k, FYI.' }),
    msg('g2', { thread: 'imessage:team', ts: at(8, 16), from: 'mailto:ben@acme.com', to: [ANA], text: 'Good to know. I can be the second signer.' }),
    msg('g3', { thread: 'imessage:team', ts: at(8, 17), me: true, to: [ANA, 'mailto:ben@acme.com'], text: 'Perfect, thanks both.' }),
    meeting('m1', {
      ts: at(7),
      title: 'Pilot review',
      attendees: [{ handle: 'mailto:ana@acme.com', name: 'Ana Ruiz' }, { handle: 'mailto:ben@acme.com', name: 'Ben Cole' }, { handle: 'mailto:sam@rivera.co', name: 'Sam Rivera' }],
      transcript: 'Ana Ruiz: The pilot numbers look strong.\nBen Cole: We want to extend it through October before we sign.\nSam Rivera: That works. I will send the revised proposal.\nBen Cole: I will send the signed contract once legal reviews.',
      summary: 'Reviewed pilot results and agreed to extend the pilot through October.',
      action_items: ['Sam: send revised proposal', 'Ben: send signed contract'],
    }),
    { id: 'wispr:d1', source: 'wispr', kind: 'dictation', thread: null, ts: at(2).toISOString(), from: null, to: [], is_from_me: true, title: null, text: 'Idea: offer a discount when a pilot converts to an annual plan within thirty days.', url: null, meta: {} },
    msg('s1', { thread: 'imessage:22395', ts: at(1), from: 'tel:22395', text: 'Your verification code is 482913' }),
    email('s2', { ts: at(2), from: 'mailto:no-reply@stripe.com', to: ['mailto:sam@rivera.co'], subject: 'Your receipt', text: 'Paid 49.00' }),
  ];
}

export function updateRecords() {
  return [msg('a5', { thread: 'imessage:ana', ts: at(0, 14), from: ANA, text: 'Got the revised proposal, it looks good. Sharing with legal today.' })];
}

// Canned sorter output per batch kind, keyed by the batch's kind.
export function contributionFor(batch) {
  const id = batch.id;
  if (batch.kind === 'people') {
    return {
      batch_id: id,
      people: [
        {
          name: 'Ana Ruiz',
          kind: 'client',
          company: 'Acme',
          role: 'VP Operations',
          relationship: 'Runs the Acme pilot and owns the budget.',
          topics: ['pilot', 'proposal'],
          bullets: [
            { date: '2026-09-22', text: 'Asked for the revised proposal by Friday so legal can review it before the pilot review', source_refs: ['imessage:a1'] },
            { date: '2026-09-19', text: 'Shared pilot data: usage up 40 percent in the first two weeks', source_refs: ['email:e1'] },
          ],
        },
        {
          name: 'Ben Cole',
          kind: 'client',
          company: 'Acme',
          bullets: [{ date: '2026-09-24', text: 'Sent the contract draft and asked to sign by October 15', source_refs: ['email:e2'] }],
        },
        {
          name: 'Carla Diaz',
          kind: 'investor',
          relationship: 'Investor who offers warm introductions — mostly to funds.',
          bullets: [{ date: '2026-09-25', text: 'Offered to introduce Sam to Dan Park at Northwind Ventures', source_refs: ['whatsapp:c1'] }],
        },
        { name: 'Invented Person', bullets: [{ date: '2026-09-25', text: 'This came from nowhere', source_refs: ['imessage:not-in-batch'] }] },
      ],
      companies: [{ name: 'Acme', kind: 'client', summary: 'Enterprise client running a paid pilot.', people: ['Ana Ruiz', 'Ben Cole'] }],
      projects: [{ name: 'Acme pilot', status: 'active', goal: 'Convert the Acme pilot into an annual contract.', company: 'Acme', people: ['Ana Ruiz', 'Ben Cole'] }],
      commitments: [
        { text: 'Send Ana the revised proposal', direction: 'i_owe', counterpart: 'Ana Ruiz', company: 'Acme', project: 'Acme pilot', due: '2026-09-24', date: '2026-09-22', source_refs: ['imessage:a1', 'imessage:a2'] },
        { text: 'Review the contract draft and reply to Ben', direction: 'i_owe', counterpart: 'Ben Cole', company: 'Acme', due: '2026-09-28', date: '2026-09-24', source_refs: ['email:e3'] },
        { text: 'Loop in Acme legal on the contract', direction: 'delegated', counterpart: 'Ben Cole', company: 'Acme', date: '2026-09-24', source_refs: ['email:e3'] },
        { text: 'Introduce Sam to Dan Park at Northwind Ventures', direction: 'owed_to_me', counterpart: 'Carla Diaz', date: '2026-09-25', source_refs: ['whatsapp:c1', 'whatsapp:c2'] },
        { text: 'A promise with no real source', direction: 'i_owe', counterpart: 'Ana Ruiz', date: '2026-09-25', source_refs: ['imessage:made-up'] },
      ],
      opportunities: [{ title: 'Intro to Northwind Ventures', type: 'introduction', counterpart: 'Carla Diaz', company: 'Northwind Ventures', next_step: 'Wait for the intro email from Carla', date: '2026-09-25', source_refs: ['whatsapp:c1'] }],
    };
  }
  if (batch.kind === 'meetings') {
    return {
      batch_id: id,
      meetings: [
        {
          title: 'Pilot review',
          date: '2026-09-21',
          people: ['Ana Ruiz', 'Ben Cole', 'Sam Rivera'],
          company: 'Acme',
          project: 'Acme pilot',
          summary: 'Reviewed the pilot results with Acme. The numbers are strong and Acme wants to extend the pilot through October before signing.',
          key_points: ['Pilot numbers look strong', 'Acme wants an October extension before signing'],
          action_items: [
            { text: 'Send the revised proposal', owner: 'Sam Rivera' },
            { text: 'Send the signed contract after legal review', owner: 'Ben Cole' },
          ],
          source_refs: ['fathom:m1'],
        },
      ],
      decisions: [{ title: 'Extend the Acme pilot through October', date: '2026-09-21', decided_by: ['Sam Rivera', 'Ben Cole'], rationale: 'Acme wants more data before signing an annual contract', against: 'It delays revenue by a month', project: 'Acme pilot', company: 'Acme', source_refs: ['fathom:m1'] }],
      people: [{ name: 'Ben Cole', bullets: [{ date: '2026-09-21', text: 'Wants to extend the pilot through October before signing', source_refs: ['fathom:m1'] }] }],
      commitments: [{ text: 'Send the signed contract after legal review', direction: 'owed_to_me', counterpart: 'Ben Cole', company: 'Acme', project: 'Acme pilot', date: '2026-09-21', source_refs: ['fathom:m1'] }],
    };
  }
  if (batch.kind === 'threads') {
    return {
      batch_id: id,
      ideas: [{ title: 'Pilot to annual discount', text: 'Offer a discount when a pilot converts to an annual plan within thirty days.', date: '2026-09-26', project: 'Acme pilot', source_refs: ['wispr:d1'] }],
      knowledge: [{ title: 'Acme procurement signatures', text: 'Acme procurement needs two signatures on anything over 50k. Ben Cole can be the second signer.', tags: ['acme', 'procurement'], date: '2026-09-20', source_refs: ['imessage:g1', 'imessage:g2'] }],
    };
  }
  if (batch.kind === 'update') {
    return {
      batch_id: id,
      people: [{ name: 'Ana Ruiz', bullets: [{ date: '2026-09-28', text: 'Confirmed the revised proposal looks good and is sharing it with legal', source_refs: ['imessage:a5'] }] }],
      commitments: [{ text: 'Send Ana the revised proposal', direction: 'i_owe', counterpart: 'Ana Ruiz', status: 'done', date: '2026-09-28', source_refs: ['imessage:a5'] }],
    };
  }
  return { batch_id: id };
}

// Second phase for cleanup: Ben writes from a second number, a near copy of
// Ana appears, an old website project goes quiet, and a card number slipped
// into a bullet before privacy scrubbing existed.
export const BEN_WA = 'tel:+15557771234';
export function cleanupRecords() {
  return [
    msg('bw1', { source: 'whatsapp', thread: 'whatsapp:ben', ts: at(0, 13), from: BEN_WA, fromName: 'Ben', text: 'Sent the signed contract this morning, legal approved it.' }),
    email('g1', { ts: at(1), from: 'mailto:ana.gomez@acmecorp.example', fromName: 'Ana Ruiz Gomez', to: ['mailto:sam@rivera.co'], subject: 'Procurement', text: 'I am joining the Acme procurement team next week and will own vendor renewals.' }),
    email('old1', { ts: at(58), from: 'mailto:maya@studio.example', fromName: 'Maya Lin', to: ['mailto:sam@rivera.co'], subject: 'Website refresh', text: 'The website refresh draft is ready. Use card 4111 1111 1111 1111 for the hosting invoice.' }),
  ];
}

export function cleanupContribution(batch, identity) {
  const id = (h) => identity.byHandle(h)?.id;
  if (batch.kind === 'identity_review') {
    return { batch_id: batch.id, identity: [{ action: 'merge', person_ids: [id('mailto:ben@acme.com'), id(BEN_WA)] }] };
  }
  return {
    batch_id: batch.id,
    people: [
      { person_id: id(BEN_WA), name: 'Ben Cole', bullets: [{ date: '2026-09-28', text: 'Said legal approved the contract and he sent it signed', source_refs: ['whatsapp:bw1'] }] },
      { person_id: id('mailto:ana.gomez@acmecorp.example'), name: 'Ana Ruiz Gomez', company: 'Acme', bullets: [{ date: '2026-09-27', text: 'Joining the Acme procurement team to own vendor renewals', source_refs: ['email:g1'] }] },
      { person_id: id('mailto:maya@studio.example'), name: 'Maya Lin', kind: 'vendor', bullets: [{ date: '2026-07-31', text: 'Shared the website refresh draft and card 4111 1111 1111 1111 for hosting', source_refs: ['email:old1'] }] },
    ],
    companies: [{ name: 'Acme Inc', people: ['Ana Ruiz Gomez'] }],
    projects: [{ name: 'Website refresh', status: 'active', goal: 'Refresh the marketing site.', people: ['Maya Lin'], bullets: [{ date: '2026-07-31', text: 'Draft is ready for review', source_refs: ['email:old1'] }] }],
  };
}
