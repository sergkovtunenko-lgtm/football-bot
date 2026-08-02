import { describe, expect, it, vi } from 'vitest';
import { OutboxWorker } from '../../src/application/outbox-worker';
import { TelegramApiError } from '../../src/adapters/telegram/client';
import type { Session } from '../../src/domain/model';
import type { StoredEffect, TelegramEffect } from '../../src/ports/store';
import { TelegramError, type TelegramPort } from '../../src/ports/telegram';
import { InMemoryFootballStore } from '../support/in-memory-store';

const NOW = '2026-07-21T08:00:00.000Z';
const SESSION_ID = '2026-07-24';

function fixture() {
  const store = new InMemoryFootballStore();
  const telegram: TelegramPort = {
    sendMessage: vi.fn().mockResolvedValue({ messageId: '501' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
    pinMessage: vi.fn().mockResolvedValue(undefined),
  };
  let id = 0;
  let now = new Date(NOW);
  const clock = { now: () => new Date(now) };
  const worker = new OutboxWorker(store, telegram, clock, () => `lease-${++id}`);
  return { store, telegram, worker, setNow: (iso: string) => { now = new Date(iso); } };
}

async function seed(
  app: ReturnType<typeof fixture>,
  effect: TelegramEffect,
  session: Session = baseSession(),
  effectId = 'effect-1',
) {
  await app.store.transact(async (tx) => {
    await tx.saveSettings({ groupChatId: '-1001' });
    await tx.saveSession(session);
    await tx.enqueue(effectId, effect, NOW);
  });
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: SESSION_ID, status: 'registration_open', nextQueuePosition: 2n, nextWinOrdinal: 1n,
    ...overrides,
  };
}

function pending(app: ReturnType<typeof fixture>): StoredEffect[] {
  return app.store.pendingEffects();
}

describe('OutboxWorker delivery and semantic snapshots', () => {
  it('marks a sent effect sent', async () => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    expect(await app.worker.flush()).toEqual({ sent: 1, rescheduled: 0 });
    expect(pending(app)).toEqual([]);
  });

  it('edits the stored registration card message', async () => {
    const app = fixture();
    await seed(app, { kind: 'registration_card', sessionId: SESSION_ID }, baseSession({ registrationMessageId: '41' }));
    await app.store.transact((tx) => tx.replaceParticipants(SESSION_ID, [{
      participantId: 'p1', sessionId: SESSION_ID, ownerUserId: '7', telegramUserId: '7',
      displayName: '<Иван>', kind: 'player', queuePosition: 1n, rosterStatus: 'active',
    }]));
    await app.worker.flush();
    expect(app.telegram.editMessage).toHaveBeenCalledWith('-1001', '41', expect.stringContaining('&lt;Иван&gt;'), expect.any(Object));
    expect(app.telegram.sendMessage).not.toHaveBeenCalled();
    expect(app.telegram.pinMessage).not.toHaveBeenCalled();
  });

  it('sends, saves, marks sent, and only then pins a new registration card', async () => {
    const app = fixture();
    await seed(app, { kind: 'registration_card', sessionId: SESSION_ID });
    const order: string[] = [];
    vi.mocked(app.telegram.sendMessage).mockImplementation(async () => { order.push('send'); return { messageId: '501' }; });
    const save = vi.spyOn(app.store, 'transact').mockImplementationOnce(async (work) => {
      order.push('snapshot');
      return InMemoryFootballStore.prototype.transact.call(app.store, work);
    });
    const sent = vi.spyOn(app.store, 'markEffectSent').mockImplementation(async (...args) => {
      order.push('mark');
      return InMemoryFootballStore.prototype.markEffectSent.call(app.store, ...args);
    });
    vi.mocked(app.telegram.pinMessage).mockImplementation(async () => { order.push('pin'); });
    await app.worker.flush();
    const session = await app.store.transact((tx) => tx.getSession(SESSION_ID));
    expect(session?.registrationMessageId).toBe('501');
    expect(order).toEqual(expect.arrayContaining(['send', 'mark', 'pin']));
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('mark'));
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('pin'));
    save.mockRestore(); sent.mockRestore();
  });

  it('edits a stored score panel from current wins', async () => {
    const app = fixture();
    await seed(app, { kind: 'score_panel', sessionId: SESSION_ID }, baseSession({
      status: 'playing', scoreMessageId: '42', nextWinOrdinal: 2n,
    }));
    await app.store.transact(async (tx) => {
      await tx.replaceTeams(SESSION_ID, [{ sessionId: SESSION_ID, teamNumber: 1 }], []);
      await tx.appendWin({
        sessionId: SESSION_ID, ordinal: 1n, teamNumber: 1, adminUserId: '900', createdAtIso: NOW,
      }, []);
    });
    await app.worker.flush();
    expect(app.telegram.editMessage).toHaveBeenCalledWith('-1001', '42', expect.stringContaining('<b>1</b>'), expect.any(Object));
  });

  it('sends and saves a missing score message ID before pinning', async () => {
    const app = fixture();
    await seed(app, { kind: 'score_panel', sessionId: SESSION_ID }, baseSession({ status: 'playing' }));
    await app.store.transact((tx) => tx.replaceTeams(SESSION_ID, [{ sessionId: SESSION_ID, teamNumber: 1 }], []));
    await app.worker.flush();
    const session = await app.store.transact((tx) => tx.getSession(SESSION_ID));
    expect(session?.scoreMessageId).toBe('501');
    expect(app.telegram.pinMessage).toHaveBeenCalledWith('-1001', '501');
  });

  it.each(['registration_card', 'score_panel'] as const)('does not reschedule a delivered %s when pinning fails', async (kind) => {
    const app = fixture();
    await seed(app, { kind, sessionId: SESSION_ID }, baseSession(kind === 'score_panel' ? { status: 'playing' } : {}));
    vi.mocked(app.telegram.pinMessage).mockRejectedValue(new TelegramApiError('pinChatMessage', 400, 'no rights'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await app.worker.flush()).toEqual({ sent: 1, rescheduled: 0 });
    expect(pending(app)).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('telegram_pin_failed'));
    logged.mockRestore();
  });

  it('renders zero teams with the current participant count', async () => {
    const app = fixture();
    await seed(app, { kind: 'teams', sessionId: SESSION_ID });
    await app.store.transact((tx) => tx.replaceParticipants(SESSION_ID, [
      { participantId: '1', sessionId: SESSION_ID, ownerUserId: '1', displayName: 'A', kind: 'guest', guestNumber: 1, queuePosition: 1n, rosterStatus: 'active' },
      { participantId: '2', sessionId: SESSION_ID, ownerUserId: '2', displayName: 'B', kind: 'guest', guestNumber: 1, queuePosition: 2n, rosterStatus: 'active' },
    ]));
    await app.worker.flush();
    expect(app.telegram.sendMessage).toHaveBeenCalledWith('-1001', expect.stringMatching(/Недостаточно для двух команд[\s\S]*2/));
  });

  it('renders promotion, final results, leaderboard, and generic admin errors from fresh state', async () => {
    const app = fixture();
    await app.store.transact(async (tx) => {
      await tx.saveSettings({ groupChatId: '-1001' });
      await tx.saveSession(baseSession({ status: 'finished' }));
      await tx.replaceParticipants(SESSION_ID, [{
        participantId: 'p', sessionId: SESSION_ID, ownerUserId: '7', telegramUserId: '7', displayName: 'Иван',
        kind: 'player', queuePosition: 1n, rosterStatus: 'active',
      }]);
      await tx.replaceTeams(SESSION_ID, [{ sessionId: SESSION_ID, teamNumber: 1 }], []);
      await tx.appendWin({ sessionId: SESSION_ID, ordinal: 1n, teamNumber: 1, adminUserId: '900', createdAtIso: NOW }, [{
        sessionId: SESSION_ID, winOrdinal: 1n, telegramUserId: '7', displayName: 'Иван',
      }]);
      await tx.enqueue('promotion', { kind: 'promotion_notice', sessionId: SESSION_ID, ownerUserId: '7' }, NOW);
      await tx.enqueue('final', { kind: 'final_results', sessionId: SESSION_ID }, NOW);
      await tx.enqueue('admin', { kind: 'admin_error', correlationId: 'corr', summary: 'raw Telegram secret must not appear' }, NOW);
    });
    await app.worker.flush(3);
    const html = vi.mocked(app.telegram.sendMessage).mock.calls.map((call) => call[1]).join('\n');
    expect(html).toContain('Иван, вы перешли');
    expect(html).toContain('Итоги вечера');
    expect(html).toContain('Рейтинг');
    expect(html).toContain('corr');
    expect(html).not.toContain('raw Telegram secret must not appear');
  });

  it.each([
    ['teams', { kind: 'teams', sessionId: SESSION_ID } as const, 'playing' as const],
    ['score panel', { kind: 'score_panel', sessionId: SESSION_ID } as const, 'playing' as const],
    ['final results', { kind: 'final_results', sessionId: SESSION_ID } as const, 'finished' as const],
  ])('delivers %s without overlapping calls in one store transaction', async (_label, effect, status) => {
    const app = fixture();
    await seed(app, effect, baseSession({ status }));
    await app.store.transact((tx) => tx.replaceTeams(SESSION_ID, [
      { sessionId: SESSION_ID, teamNumber: 1 },
      { sessionId: SESSION_ID, teamNumber: 2 },
    ], []));
    app.store.rejectConcurrentTransactionCalls();

    expect(await app.worker.flush()).toEqual({ sent: 1, rescheduled: 0 });
    expect(pending(app)).toEqual([]);
  });

  it('claims and processes at most one effect at a time in visible order', async () => {
    const app = fixture();
    await app.store.transact(async (tx) => {
      await tx.saveSettings({ groupChatId: '-1001' });
      await tx.saveSession(baseSession());
      await tx.enqueue('a', { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'a' }, NOW);
      await tx.enqueue('b', { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'b' }, NOW);
    });
    const claim = vi.spyOn(app.store, 'claimDueEffects');
    await app.worker.flush(2);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls.every((call) => call[1] === 1)).toBe(true);
    expect(vi.mocked(app.telegram.sendMessage).mock.calls).toHaveLength(2);
  });

  it('treats Telegram message-not-modified as idempotent success', async () => {
    const app = fixture();
    await seed(app, { kind: 'registration_card', sessionId: SESSION_ID }, baseSession({ registrationMessageId: '41' }));
    vi.mocked(app.telegram.editMessage).mockRejectedValue(new TelegramApiError(
      'editMessageText', 400, 'Bad Request: message is not modified',
    ));
    expect(await app.worker.flush()).toEqual({ sent: 1, rescheduled: 0 });
    expect(pending(app)).toEqual([]);
  });
});

describe('OutboxWorker retries', () => {
  it('reschedules Telegram 429 no earlier than retry_after', async () => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new TelegramApiError(
      'sendMessage', 429, 'Too Many Requests: retry after 75',
    ));
    expect(await app.worker.flush()).toEqual({ sent: 0, rescheduled: 1 });
    expect(pending(app)[0]).toMatchObject({ attempts: 1, nextAttemptAtIso: '2026-07-21T08:01:15.000Z' });
  });

  it.each([
    [0, 30], [1, 120], [2, 600], [3, 3600], [4, 3600],
  ])('uses transient delay for previous attempt %i', async (attempts, delaySeconds) => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    if (attempts > 0) await app.store.rescheduleEffect('effect-1', attempts, NOW, 'old');
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new TelegramApiError('sendMessage', 503, 'unavailable'));
    await app.worker.flush();
    expect(pending(app)[0]?.attempts).toBe(attempts + 1);
    expect(pending(app)[0]?.nextAttemptAtIso).toBe(new Date(new Date(NOW).getTime() + delaySeconds * 1000).toISOString());
  });

  it('marks a permanent Telegram 400 failed without retry', async () => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new TelegramApiError('sendMessage', 400, 'bad request'));
    expect(await app.worker.flush()).toEqual({ sent: 0, rescheduled: 0 });
    expect(pending(app)).toEqual([]);
  });

  it('classifies permanent failures through the Telegram port error contract', async () => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new TelegramError('sendMessage', 403, 'forbidden'));
    expect(await app.worker.flush()).toEqual({ sent: 0, rescheduled: 0 });
    expect(pending(app)).toEqual([]);
  });

  it('enqueues exactly one generic admin notice on the fourth transient failure and retries hourly', async () => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    await app.store.rescheduleEffect('effect-1', 3, NOW, 'old');
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new TelegramApiError('sendMessage', 500, 'private raw failure'));
    await app.worker.flush();
    expect(pending(app).find((effect) => effect.effectId === 'effect-1')).toMatchObject({
      attempts: 4, nextAttemptAtIso: '2026-07-21T09:00:00.000Z',
    });
    expect(pending(app).filter((effect) => effect.effect.kind === 'admin_error')).toEqual([expect.objectContaining({
      effectId: 'admin-error:effect-1',
      effect: { kind: 'admin_error', correlationId: 'effect-1', summary: expect.not.stringContaining('private raw failure') },
    })]);
  });

  it('retries the fourth-failure atomic transition after an injected notice write failure', async () => {
    const app = fixture();
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    await app.store.rescheduleEffect('effect-1', 3, NOW, 'old');
    app.store.failNextReschedule();
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new Error('network'));
    await expect(app.worker.flush(1)).rejects.toThrow('injected reschedule failure');
    expect(pending(app)).toEqual([expect.objectContaining({ effectId: 'effect-1', attempts: 3 })]);

    app.setNow('2026-07-21T08:00:31.000Z');
    expect(await app.worker.flush(1)).toEqual({ sent: 0, rescheduled: 1 });
    expect(pending(app).filter((effect) => effect.effectId === 'admin-error:effect-1')).toHaveLength(1);
    expect(pending(app).find((effect) => effect.effectId === 'effect-1')).toMatchObject({ attempts: 4 });
  });

  it('truncates stored error text to 500 characters and removes bot tokens', async () => {
    const app = fixture();
    const token = '1234567890:' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_12';
    await seed(app, { kind: 'reminder', sessionId: SESSION_ID, actionKey: 'thu' });
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new Error(
      `https://api.telegram.org/bot${token}/sendMessage ${'x'.repeat(700)}`,
    ));
    await app.worker.flush();
    const status = await app.store.getOperationalStatus();
    expect(status.lastSafeError?.length).toBeLessThanOrEqual(500);
    expect(status.lastSafeError).not.toContain(token);
  });

  it('does not recursively enqueue admin_error after its fourth transient failure', async () => {
    const app = fixture();
    await seed(app, { kind: 'admin_error', correlationId: 'original', summary: 'generic' });
    await app.store.rescheduleEffect('effect-1', 3, NOW, 'old');
    vi.mocked(app.telegram.sendMessage).mockRejectedValue(new Error('network'));
    await app.worker.flush();
    expect(pending(app).filter((effect) => effect.effect.kind === 'admin_error')).toHaveLength(1);
    expect(pending(app)[0]?.attempts).toBe(4);
  });
});
