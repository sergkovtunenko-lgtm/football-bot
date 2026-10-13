import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { D1FootballStore, type FootballDatabase } from '../../src/adapters/d1/store';
import { BotService } from '../../src/application/bot-service';
import { Scheduler } from '../../src/application/scheduler';
import { OutboxWorker } from '../../src/application/outbox-worker';
import { UpdateRouter } from '../../src/application/update-router';
import type { TeamMember } from '../../src/domain/model';

let mf: Miniflare;
let db: FootballDatabase;
let store: D1FootballStore;
const now = '2026-10-13T07:15:00.000Z';
let currentIso = now;
let id = 0;
const newId = () => `id-${++id}`;
const clock = { now: () => new Date(currentIso) };

beforeEach(async () => {
  currentIso = now; id = 0;
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'], compatibilityDate: '2026-07-27' });
  db = await mf.getD1Database('DB') as unknown as FootballDatabase;
  const schema = readFileSync(resolve('migrations/d1/0001.sql'), 'utf8');
  await db.batch(schema.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  store = new D1FootballStore(db);
});
afterEach(async () => { await mf?.dispose(); });

describe('D1 persistence contracts', () => {
  it.each(['finish', 'win', 'cancel'] as const)('delivers %s with accumulated history within the Free query budget', async (action) => {
    currentIso = '2026-10-16T18:00:00.000Z';
    const members = (sessionId: string): TeamMember[] => Array.from({ length: 7 }, (_, index) => ({
      sessionId, participantId: `p-${index}`, ownerUserId: String(index), telegramUserId: String(index),
      displayName: `P${index}`, kind: 'player', queuePosition: BigInt(index + 1), rosterStatus: 'active',
      teamNumber: index < 5 ? 1 : 2, role: 'starter',
    }));
    await store.transact(async (tx) => {
      await tx.saveSettings({ groupChatId: '-1001' });
      for (let index = 0; index < 20; index++) {
        const sessionId = `2026-06-${String(index + 1).padStart(2, '0')}`;
        await tx.saveSession({ sessionId, status: 'finished', nextQueuePosition: 8n, nextWinOrdinal: 1n });
        await tx.replaceTeams(sessionId, [{ sessionId, teamNumber: 1 }, { sessionId, teamNumber: 2 }], members(sessionId));
      }
      await tx.saveSession({ sessionId: '2026-10-16', status: 'playing', nextQueuePosition: 8n,
        nextWinOrdinal: 1n, scoreMessageId: '42' });
      await tx.replaceTeams('2026-10-16', [{ sessionId: '2026-10-16', teamNumber: 1 },
        { sessionId: '2026-10-16', teamNumber: 2 }], members('2026-10-16'));
    });
    let queries = 0;
    const measuredDb: FootballDatabase = {
      prepare: (sql) => { queries++; return db.prepare(sql); }, batch: (stmts) => db.batch(stmts), exec: (sql) => db.exec(sql),
    };
    const measuredStore = new D1FootballStore(measuredDb);
    const messages: string[] = [];
    const telegram = { sendMessage: async (_chat: string, html: string) => { messages.push(html); return { messageId: '100' }; },
      editMessage: async (_chat: string, _id: string, html: string) => { messages.push(html); },
      answerCallback: async () => {}, pinMessage: async () => {} };
    const service = new BotService(measuredStore, clock, { int: () => 0 }, new Set(['900']), newId);
    const router = new UpdateRouter(service, measuredStore, telegram, {
      botToken: 'test', webhookSecret: 'test_webhook_secret', adminIds: new Set(['900']),
      ydbConnectionString: 'd1', telegramApiBaseUrl: 'https://api.telegram.org', timeZone: 'Europe/Moscow', maxActiveParticipants: 20,
    });
    await new Scheduler(measuredStore, clock, { int: () => 0 }, newId).tick();
    await router.handle({ update_id: 900, callback_query: { id: 'callback', from: { id: 900, is_bot: false, first_name: 'Admin' },
      data: action === 'finish' ? 'v1:w:confirm_finish' : action === 'win' ? 'v1:w:1' : 'v1:c:2026-10-16',
      message: { message_id: 42, chat: { id: -1001, type: 'supergroup' } } } });
    await new OutboxWorker(measuredStore, telegram, clock, newId).flush(1);
    expect(messages.length).toBeGreaterThan(0);
    if (action === 'finish') expect(messages.some((message) => message.includes('РЕЙТИНГ'))).toBe(true);
    expect(queries).toBeLessThanOrEqual(50);
    expect((await store.transact((tx) => tx.getSession('2026-10-16')))?.status)
      .toBe(action === 'finish' ? 'finished' : action === 'win' ? 'playing' : 'cancelled');
    if (action === 'win') expect(await store.transact((tx) => tx.listWinAwards('2026-10-16'))).toHaveLength(5);
  }, 20_000);

  it('rolls back failed work, including Telegram deduplication', async () => {
    await expect(store.transactUpdate('u', now, async (tx) => {
      await tx.saveSettings({ groupChatId: '-1001' }); throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await store.transact((tx) => tx.getSettings())).toEqual({});
    expect((await store.transactUpdate('u', now, (tx) => tx.saveSettings({ groupChatId: '-1001' }))).duplicate).toBe(false);
    expect((await store.transactUpdate('u', now, () => { throw new Error('duplicate ran'); })).duplicate).toBe(true);
  });

  it('does not lose either concurrent registration or duplicate a queue position', async () => {
    const service = new BotService(store, clock, { int: () => 0 }, new Set(['900']), newId);
    await service.setup('setup', '900', '-1001'); await service.openNow('open', '900');
    const other = new BotService(new D1FootballStore(db), clock, { int: () => 0 }, new Set(['900']), newId);
    await Promise.all([
      service.setParty('1', { telegramUserId: '1', displayName: 'One' }, 1),
      other.setParty('2', { telegramUserId: '2', displayName: 'Two' }, 1),
    ]);
    const participants = await store.transact((tx) => tx.listParticipants('2026-10-16'));
    expect(participants.map((p) => p.telegramUserId).sort()).toEqual(['1', '2']);
    expect(new Set(participants.map((p) => p.queuePosition)).size).toBe(2);
    expect(await new D1FootballStore(db).transact((tx) => tx.listParticipants('2026-10-16'))).toEqual(participants);
  });

  it('catches up opening once even when both timers execute concurrently', async () => {
    const one = new Scheduler(store, clock, { int: () => 0 }, newId);
    const two = new Scheduler(new D1FootballStore(db), clock, { int: () => 0 }, newId);
    await Promise.all([one.tick(), two.tick()]);
    expect((await store.getOperationalStatus()).pendingEffectCount).toBe(1);
    expect((await store.transact((tx) => tx.getSession('2026-10-16')))?.status).toBe('registration_open');
  });

  it('leases a message to only one worker and makes it retryable after lease expiry', async () => {
    await store.transact((tx) => tx.enqueue('effect', { kind: 'teams', sessionId: '2026-10-16' }, now));
    const claims = await Promise.all([store.claimDueEffects(now, 1, 'one'),
      new D1FootballStore(db).claimDueEffects(now, 1, 'two')]);
    expect(claims.flat()).toHaveLength(1);
    expect(await store.claimDueEffects(now, 1, 'three')).toHaveLength(0);
    expect(await store.claimDueEffects('2026-10-13T07:15:30.000Z', 1, 'three')).toHaveLength(1);
    await store.rescheduleEffectWithNotice('effect', 4, now, 'safe', 'notice',
      { kind: 'admin_error', correlationId: 'effect', summary: 'error' }, now);
    await store.rescheduleEffectWithNotice('effect', 4, now, 'safe', 'notice',
      { kind: 'admin_error', correlationId: 'effect', summary: 'error' }, now);
    expect((await store.getOperationalStatus()).pendingEffectCount).toBe(2);
    await store.markEffectSent('effect', now);
    await store.markEffectPermanentlyFailed('notice', now, 'safe');
    expect((await store.getOperationalStatus()).pendingEffectCount).toBe(0);
  });

  it('preserves incomplete teams and recalculates finished statistics after an absence', async () => {
    const service = new BotService(store, clock, { int: () => 0 }, new Set(['900']), newId);
    await service.setup('setup', '900', '-1001'); await service.openNow('open', '900');
    for (let n = 1; n <= 7; n++) await service.setParty(`r-${n}`, { telegramUserId: String(n), displayName: `P${n}` }, 1);
    currentIso = '2026-10-16T17:55:00.000Z';
    expect((await service.closeNow('close', '900')).value?.teamCount).toBe(2);
    await service.recordWin('win', '900', 2);
    expect((await service.finish('finish', '900')).value?.leaderboard).toHaveLength(7);
    const participants = await store.transact((tx) => tx.listParticipants('2026-10-16'));
    await store.transact((tx) => tx.removeCompletedParticipant('2026-10-16', participants[0]!.participantId));
    expect(await store.transact((tx) => tx.listParticipants('2026-10-16'))).toHaveLength(6);
    await service.cancelCurrentSession('cancel', '900');
    expect((await store.transact((tx) => tx.getSession('2026-10-16')))?.status).toBe('cancelled');
    expect(await store.transact((tx) => tx.listWinEvents('2026-10-16'))).toEqual([]);
    expect(await store.transact((tx) => tx.listWinAwards('2026-10-16'))).toEqual([]);
    expect((await store.transact((tx) => tx.listCompletedSessionIds())).size).toBe(0);
  }, 20_000);
});
