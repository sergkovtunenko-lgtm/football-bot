import { describe, expect, it } from 'vitest';
import { BotService, InvalidStateError } from '../../src/application/bot-service';
import { Scheduler } from '../../src/application/scheduler';
import { OutboxWorker } from '../../src/application/outbox-worker';
import type { InlineKeyboard } from '../../src/ports/telegram';
import { InMemoryFootballStore } from '../support/in-memory-store';

const SESSION = '2026-10-23';

async function fixture(count: number) {
  const store = new InMemoryFootballStore();
  let iso = '2026-10-20T07:00:00.000Z';
  let id = 0;
  const clock = { now: () => new Date(iso) };
  const newId = () => `id-${++id}`;
  const random = { int: () => 0 };
  const service = new BotService(store, clock, random, new Set(['900']), newId);
  const scheduler = new Scheduler(store, clock, random, newId);
  const sent: Array<{ html: string; keyboard?: InlineKeyboard }> = [];
  const edited: Array<{ html: string; keyboard?: InlineKeyboard }> = [];
  const outbox = new OutboxWorker(store, {
    sendMessage: async (_chat, html, keyboard) => {
      sent.push({ html, ...(keyboard ? { keyboard } : {}) }); return { messageId: `m-${sent.length}` };
    },
    editMessage: async (_chat, _message, html, keyboard) => {
      edited.push({ html, ...(keyboard ? { keyboard } : {}) });
    },
    answerCallback: async () => {}, pinMessage: async () => {},
  }, clock, newId);
  await service.setup('setup', '900', '-1001');
  await scheduler.tick();
  for (let n = 1; n <= count; n++) {
    await service.setParty(`r-${n}`, { telegramUserId: String(n), displayName: `P${n}` }, 1);
  }
  const drain = async () => {
    while (store.pendingEffects().length) {
      const result = await outbox.flush();
      if (result.rescheduled) throw new Error('Unexpected delivery failure');
    }
  };
  await drain();
  sent.length = 0; edited.length = 0;
  return { store, service, scheduler, outbox, sent, edited, drain, at: (value: string) => { iso = value; } };
}

describe('Friday registration cutoff and payment', () => {
  it('freezes registration at 19:00 Moscow without creating teams', async () => {
    const app = await fixture(15);
    app.at('2026-10-23T15:59:59.000Z'); await app.scheduler.tick();
    expect((await app.service.status()).sessionStatus).toBe('registration_open');
    app.at('2026-10-23T16:00:00.000Z'); await app.scheduler.tick();
    expect((await app.service.status()).sessionStatus).toBe('registration_closed');
    expect(await app.store.transact((tx) => tx.listTeams(SESSION))).toEqual([]);
    await app.drain();
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]!.html).toContain('650,00');
    expect(app.edited.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
    expect(app.edited.at(-1)?.html).toContain('ЗАКРЫТА');
  });

  it('rejects a signup at the deadline even before the timer runs', async () => {
    const app = await fixture(10);
    app.at('2026-10-23T16:00:00.000Z');
    await expect(app.service.setParty('late', { telegramUserId: '30', displayName: 'Late' }, 1))
      .rejects.toBeInstanceOf(InvalidStateError);
    expect((await app.service.registrationView()).active).toHaveLength(10);
  });

  it('keeps the fixed list until 20:55 and creates teams only once', async () => {
    const app = await fixture(19);
    app.at('2026-10-23T16:00:00.000Z'); await app.scheduler.tick(); await app.drain();
    app.at('2026-10-23T17:54:59.000Z'); await app.scheduler.tick();
    expect(await app.store.transact((tx) => tx.listTeams(SESSION))).toEqual([]);
    expect(await app.service.status()).toMatchObject({ nextActionKind: 'teams', nextActionAtIso: '2026-10-23T17:55:00.000Z' });
    app.at('2026-10-23T17:55:00.000Z');
    await Promise.all([app.scheduler.tick(), app.scheduler.tick()]);
    expect(await app.store.transact((tx) => tx.listTeams(SESSION))).toHaveLength(4);
    expect(await app.store.transact((tx) => tx.listTeamMembers(SESSION))).toHaveLength(19);
    expect(app.store.pendingEffects().filter((effect) => effect.effect.kind === 'teams')).toHaveLength(1);
    await app.drain();
    expect(app.sent.filter((message) => message.html.includes('513,16'))).toHaveLength(1);
  });

  it('catches up both stages in order after a delayed timer without duplicate charges', async () => {
    const app = await fixture(20);
    app.at('2026-10-23T18:01:00.000Z');
    await Promise.all([app.scheduler.tick(), app.scheduler.tick()]);
    expect((await app.service.status()).sessionStatus).toBe('playing');
    expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'payment_notice')).toHaveLength(1);
    await app.drain();
    expect(app.sent.findIndex((message) => message.html.includes('662,50')))
      .toBeLessThan(app.sent.findIndex((message) => message.html.includes('Составы команд')));
  });

  it.each([
    [11, '6750', '613,64', '1 час'], [12, '6750', '562,50', '1 час'],
    [13, '9750', '750,00', '1,5 часа'], [14, '9750', '696,43', '1,5 часа'],
    [15, '9750', '650,00', '1,5 часа'], [19, '9750', '513,16', '1,5 часа'],
    [20, '13250', '662,50', '2 часа'], [21, '13250', '662,50', '2 часа'],
  ])('calculates payment for %i registrations without charging the waitlist', async (count, total, share, duration) => {
    const app = await fixture(count);
    app.at('2026-10-23T16:00:00.000Z'); await app.scheduler.tick(); await app.drain();
    const payment = app.sent[0]!.html.replace(/[\s\u00a0\u202f]/g, '');
    expect(payment).toContain(total);
    expect(payment).toContain(share);
    expect(app.sent[0]!.html).toContain(duration);
    expect(app.sent).toHaveLength(1);
  });

  it('counts each guest as a paying participant', async () => {
    const app = await fixture(9);
    await app.service.setParty('with-guests', { telegramUserId: '10', displayName: 'Owner' }, 2);
    await app.drain(); app.sent.length = 0;
    app.at('2026-10-23T16:00:00.000Z'); await app.scheduler.tick(); await app.drain();
    expect(app.sent[0]?.html).toContain('613,64');
  });

  it.each([
    [0, '2026-10-23T16:00:00.000Z'],
    [10, '2026-10-23T16:00:00.000Z'],
    [10, '2026-10-23T18:01:00.000Z'],
  ])('cancels with %i players at %s without payment or teams', async (count, cutoff) => {
    const app = await fixture(count);
    app.at(cutoff);
    await Promise.all([app.scheduler.tick(), app.scheduler.tick()]);
    expect((await app.service.status()).sessionStatus).toBe('cancelled');
    app.at('2026-10-23T18:02:00.000Z'); await app.scheduler.tick(); await app.drain();
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.html).toContain('не состоится');
    expect(app.sent[0]?.html).not.toMatch(/NaN|Infinity|₽|скидываемся/i);
    expect(app.edited.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
    expect(app.edited.at(-1)?.html).toContain('СБОР ОТМЕНЁН');
    expect(await app.store.transact((tx) => tx.listTeams(SESSION))).toEqual([]);
    expect((await app.store.transact((tx) => tx.listCompletedSessionIds())).has(SESSION)).toBe(false);
    await expect(app.service.finish('finish-cancelled', '900')).rejects.toBeInstanceOf(InvalidStateError);
    app.at('2026-10-27T07:00:00.000Z'); await app.scheduler.tick();
    expect(await app.service.status()).toMatchObject({ sessionId: '2026-10-30', sessionStatus: 'registration_open' });
  });

  it('does not publish payment or teams for a cancelled session', async () => {
    const app = await fixture(10);
    await app.service.cancelCurrentSession('cancel', '900'); await app.drain(); app.sent.length = 0;
    app.at('2026-10-23T18:00:00.000Z'); await app.scheduler.tick(); await app.drain();
    expect(app.sent).toEqual([]);
    expect((await app.service.status()).sessionStatus).toBe('cancelled');
  });
});

describe('Visible participant removals', () => {
  it('announces the removed player once, even when Telegram redelivers the update', async () => {
    const app = await fixture(1);
    const player = { telegramUserId: '1', displayName: 'P1' };
    await app.service.setParty('leave', player, 0);
    await app.service.setParty('leave', player, 0);
    await app.drain();
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.html).toContain('P1');
    expect(app.sent[0]?.html).toContain('Состав обновился: P1 в этот раз пропускает игру.');
    expect(app.sent[0]?.html).not.toMatch(/удал|исключ|до встречи/i);
    expect((await app.service.registrationView()).active).toEqual([]);
  });

  it('identifies only the removed guests when reducing a party', async () => {
    const app = await fixture(0);
    const player = { telegramUserId: '1', displayName: '<Owner & friends>' };
    await app.service.setParty('add-party', player, 3); await app.drain();
    expect(app.sent).toHaveLength(0);
    await app.service.setParty('remove-guests', player, 1); await app.drain();
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.html).toContain('Гость 1 — от &lt;Owner &amp; friends&gt;');
    expect(app.sent[0]?.html).toContain('Гость 2 — от &lt;Owner &amp; friends&gt;');
    expect(app.sent[0]?.html).not.toContain('<Owner');
    expect((await app.service.registrationView()).active).toEqual([{ displayName: '<Owner & friends>' }]);
  });

  it('does not announce a removal when the list did not shrink', async () => {
    const app = await fixture(1);
    await app.service.setParty('same', { telegramUserId: '1', displayName: 'P1' }, 1); await app.drain();
    expect(app.sent).toEqual([]);
  });

  it('announces exactly the absent participant removed by the administrator', async () => {
    const app = await fixture(11);
    await app.service.closeNow('close', '900');
    await app.service.finish('finish', '900'); await app.drain(); app.sent.length = 0;
    const participant = (await app.service.latestFinishedParticipants()).participants[0]!;
    await app.service.removeAbsentParticipant('absent', '900', SESSION, participant.participantId);
    await app.drain();
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.html).toContain(participant.displayName);
    expect((await app.service.latestFinishedParticipants()).participants).toHaveLength(10);
  });
});
