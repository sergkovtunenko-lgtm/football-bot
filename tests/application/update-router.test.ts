import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, InvalidStateError } from '../../src/application/bot-service';
import { UpdateRouter } from '../../src/application/update-router';
import type { AppConfig } from '../../src/config';
import type { FootballStore } from '../../src/ports/store';
import type { TelegramPort } from '../../src/ports/telegram';

const config: AppConfig = {
  botToken: 'token', webhookSecret: '1234567890abcdef', adminIds: new Set(['900']),
  ydbConnectionString: 'grpc://local', telegramApiBaseUrl: 'https://worker.example/telegram-api',
  timeZone: 'Europe/Moscow', maxActiveParticipants: 20,
};

function fixture() {
  const session = {
    sessionId: '2026-07-24', status: 'registration_open' as const, nextQueuePosition: 1n, nextWinOrdinal: 1n,
    registrationMessageId: '5', scoreMessageId: '5',
  };
  const service = {
    setup: vi.fn().mockResolvedValue({ duplicate: false }),
    openNow: vi.fn().mockResolvedValue({ duplicate: false }),
    setParty: vi.fn().mockResolvedValue({ duplicate: false }),
    closeNow: vi.fn().mockResolvedValue({ duplicate: false }),
    recordWin: vi.fn().mockResolvedValue({ duplicate: false }),
    undoLastWin: vi.fn().mockResolvedValue({ duplicate: false }),
    finish: vi.fn().mockResolvedValue({ duplicate: false }),
    getPartySize: vi.fn().mockResolvedValue(3),
    registrationView: vi.fn().mockResolvedValue({
      sessionId: '2026-07-24', active: [{ displayName: 'Игрок' }], waitlist: [], maxActive: 20,
    }),
    status: vi.fn().mockResolvedValue({
      sessionId: '2026-07-24', sessionStatus: 'registration_open', nextActionKind: 'close',
      nextActionAtIso: '2026-07-24T17:55:00.000Z', activeCount: 1, waitlistCount: 0,
      teamCount: 0, pendingEffectCount: 0,
    }),
  };
  const telegram: TelegramPort = {
    sendMessage: vi.fn().mockResolvedValue({ messageId: '55' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
    pinMessage: vi.fn().mockResolvedValue(undefined),
  };
  const store = {
    transact: vi.fn(async (work: (tx: {
      getSettings(): Promise<{ groupChatId: string }>;
      getSession(): Promise<typeof session>;
      saveSession(value: typeof session): Promise<void>;
    }) => Promise<unknown>) => work({
      getSettings: async () => ({ groupChatId: '-1001' }),
      getSession: async () => structuredClone(session),
      saveSession: async (value) => { Object.assign(session, structuredClone(value)); },
    })),
  } as unknown as FootballStore;
  const router = new UpdateRouter(service, store, telegram, config);
  return { router, service, session, store, telegram };
}

function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    update_id: 77,
    message: {
      message_id: 5, from: { id: 7, is_bot: false, first_name: 'Иван', username: 'ivan' },
      chat: { id: -1001, type: 'supergroup' }, date: 0, text,
    },
    ...overrides,
  };
}

function callback(data: string, actorId = 900) {
  return {
    update_id: 77,
    callback_query: {
      id: 'cq', from: { id: actorId, is_bot: false, first_name: 'Admin' }, data,
      message: { message_id: 5, chat: { id: -1001, type: 'supergroup' }, date: 0 },
    },
  };
}

describe('UpdateRouter registration text', () => {
  it.each([
    ['+', 1], ['+1', 2], ['+2', 3], ['-', 0],
  ] as const)('routes %s in the configured group to party size %i', async (text, size) => {
    const { router, service } = fixture();
    await router.handle(message(`  ${text.replace('+', '＋')}  `));
    expect(service.setParty).toHaveBeenCalledWith('77', {
      telegramUserId: '7', displayName: 'Иван', username: 'ivan',
    }, size);
  });

  it('uses the store-backed party view to remove one guest', async () => {
    const { router, service } = fixture();
    await router.handle(message('－1'));
    expect(service.getPartySize).toHaveBeenCalledWith('7');
    expect(service.setParty).toHaveBeenCalledWith('77', expect.any(Object), 2);
  });

  it('maps -2 directly to player-only', async () => {
    const { router, service } = fixture();
    await router.handle(message('－2'));
    expect(service.setParty).toHaveBeenCalledWith('77', expect.any(Object), 1);
  });

  it('clamps guest decrement at the player-only party size', async () => {
    const { router, service } = fixture();
    service.getPartySize.mockResolvedValue(0);
    await router.handle(message('-1'));
    expect(service.setParty).toHaveBeenCalledWith('77', expect.any(Object), 1);
  });

  it('uses @username when Telegram sends no usable name', async () => {
    const { router, service } = fixture();
    const update = message('+') as any;
    update.message.from.first_name = '   ';
    update.message.from.username = 'only_username';

    await router.handle(update);

    expect(service.setParty).toHaveBeenCalledWith('77', {
      telegramUserId: '7',
      displayName: '@only_username',
      username: 'only_username',
    }, 1);
  });

  it('ignores registration text outside the configured group', async () => {
    const { router, service, telegram } = fixture();
    const update = message('+') as any;
    update.message.chat.id = -2002;
    await router.handle(update);
    expect(service.setParty).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores unrelated group text, bot messages, and edited messages', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(message('привет'));
    const botUpdate = message('+') as any;
    botUpdate.message.from.is_bot = true;
    await router.handle(botUpdate);
    const edited = message('+') as any;
    edited.edited_message = edited.message;
    delete edited.message;
    await router.handle(edited);
    expect(service.setParty).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe('UpdateRouter callbacks', () => {
  it.each([
    ['v1:r:0', 0], ['v1:r:1', 1], ['v1:r:2', 2], ['v1:r:3', 3],
  ] as const)('routes %s and answers exactly once', async (data, size) => {
    const { router, service, telegram } = fixture();
    await router.handle(callback(data));
    expect(service.setParty).toHaveBeenCalledWith('77', {
      telegramUserId: '900', displayName: 'Admin',
    }, size);
    expect(telegram.answerCallback).toHaveBeenCalledTimes(1);
  });

  it('accepts a current-session registration button from the active card', async () => {
    const { router, service, telegram } = fixture();
    const registrationCard = callback('v2:r:2026-07-24:2') as any;
    registrationCard.callback_query.message.message_id = 999;
    await router.handle(registrationCard);
    expect(service.setParty).toHaveBeenCalledWith('77', {
      telegramUserId: '900', displayName: 'Admin',
    }, 2);
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Готово', undefined);
  });

  it('rejects a registration button from a previous session', async () => {
    const { router, service, telegram } = fixture();
    const oldReminder = callback('v2:r:2026-07-17:2') as any;
    oldReminder.callback_query.message.message_id = 999;
    await router.handle(oldReminder);
    expect(service.setParty).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Эта кнопка уже неактуальна', true);
  });

  it('does not publish a registration card for the removed list callback', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(callback('v1:r:list'));
    expect(service.registrationView).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Кнопка не поддерживается', undefined);
  });

  it.each([1, 2, 3, 4] as const)('routes one-tap team %i win and answers exactly once', async (team) => {
    const { router, service, telegram } = fixture();
    await router.handle(callback(`v1:w:${team}`));
    expect(service.recordWin).toHaveBeenCalledWith('77', '900', team);
    expect(telegram.answerCallback).toHaveBeenCalledTimes(1);
  });

  it('routes score undo and answers exactly once', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(callback('v1:w:undo'));
    expect(service.undoLastWin).toHaveBeenCalledWith('77', '900');
    expect(telegram.answerCallback).toHaveBeenCalledTimes(1);
  });

  it('shows confirmation without finishing and answers exactly once', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(callback('v1:w:finish'));
    expect(service.finish).not.toHaveBeenCalled();
    expect(telegram.editMessage).toHaveBeenCalledWith('-1001', '5', expect.stringContaining('Завершить'), expect.objectContaining({
      inline_keyboard: expect.any(Array),
    }));
    const keyboard = vi.mocked(telegram.editMessage).mock.calls[0]?.[3];
    expect(keyboard?.inline_keyboard.flat().map((button) => button.callback_data)).toEqual(['v1:w:confirm_finish']);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledTimes(1);
  });

  it('finishes only on confirm_finish and answers exactly once', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(callback('v1:w:confirm_finish'));
    expect(service.finish).toHaveBeenCalledWith('77', '900');
    expect(telegram.answerCallback).toHaveBeenCalledTimes(1);
  });

  it('alerts a non-admin protected callback without invoking state changes', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(callback('v1:w:2', 7));
    expect(service.recordWin).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledOnce();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Только администратор', true);
  });

  it('rejects a stale message ID before calling any mutating service', async () => {
    const { router, service, telegram } = fixture();
    const stale = callback('v1:w:2') as any;
    stale.callback_query.message.message_id = 999;
    await router.handle(stale);
    expect(service.setParty).not.toHaveBeenCalled();
    expect(service.recordWin).not.toHaveBeenCalled();
    expect(service.undoLastWin).not.toHaveBeenCalled();
    expect(service.finish).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledOnce();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Эта кнопка уже неактуальна', true);
  });

  it('maps a current-button stale domain state without exposing details', async () => {
    const { router, service, telegram } = fixture();
    service.recordWin.mockRejectedValue(new InvalidStateError('internal state details'));
    await router.handle(callback('v1:w:2'));
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Эта кнопка уже неактуальна', true);
  });

  it('maps a service authorization error without exposing its message', async () => {
    const { router, service, telegram } = fixture();
    service.recordWin.mockRejectedValue(new ForbiddenError('private details'));
    await router.handle(callback('v1:w:2'));
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Только администратор', true);
  });

  it('answers unsupported callbacks exactly once without a state change', async () => {
    const { router, service, telegram } = fixture();
    await router.handle(callback('v9:unknown'));
    expect(service.setParty).not.toHaveBeenCalled();
    expect(service.recordWin).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledOnce();
  });
});

describe('UpdateRouter recovery commands and validation', () => {
  it.each([
    ['/setup', 'setup'], ['/open', 'openNow'],
    ['/close', 'closeNow'], ['/undo', 'undoLastWin'],
  ] as const)('routes admin command %s', async (command, method) => {
    const { router, service } = fixture();
    const update = message(command) as any;
    update.message.from.id = 900;
    await router.handle(update);
    if (method === 'setup') expect(service.setup).toHaveBeenCalledWith('77', '900', '-1001');
    else expect(service[method]).toHaveBeenCalledWith('77', '900');
  });

  it('ignores the removed /remind command without publishing', async () => {
    const { router, service, telegram } = fixture();
    const update = message('/remind') as any;
    update.message.from.id = 900;
    await router.handle(update);
    expect(service.openNow).not.toHaveBeenCalled();
    expect(service.closeNow).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('routes /status through a fresh status snapshot', async () => {
    const { router, service, telegram } = fixture();
    const update = message('/status') as any;
    update.message.from.id = 900;
    await router.handle(update);
    expect(service.status).toHaveBeenCalledOnce();
    expect(telegram.sendMessage).toHaveBeenCalledWith('-1001', expect.stringContaining('Статус бота'));
  });

  it('/finish only shows a confirmation keyboard', async () => {
    const { router, service, telegram } = fixture();
    const update = message('/finish') as any;
    update.message.from.id = 900;
    await router.handle(update);
    expect(service.finish).not.toHaveBeenCalled();
    expect(telegram.editMessage).toHaveBeenCalledWith('-1001', '5', expect.stringContaining('Завершить'), expect.any(Object));
  });

  it.each(['/setup', '/status', '/open', '/close', '/undo', '/finish'])('requires admin for %s', async (command) => {
    const { router, service, telegram } = fixture();
    await router.handle(message(command));
    expect(service.setup).not.toHaveBeenCalled();
    expect(service.status).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('-1001', 'Только администратор');
  });

  it.each(['/status', '/open', '/close', '/undo', '/finish'])('ignores %s outside the configured group before admin checks', async (command) => {
    const { router, service, telegram } = fixture();
    const update = message(command) as any;
    update.message.chat.id = -2002;
    await router.handle(update);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.openNow).not.toHaveBeenCalled();
    expect(service.closeNow).not.toHaveBeenCalled();
    expect(service.undoLastWin).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.editMessage).not.toHaveBeenCalled();
  });

  it('/setup bootstraps a different group for an admin', async () => {
    const { router, service } = fixture();
    const update = message('/setup') as any;
    update.message.from.id = 900;
    update.message.chat.id = -2002;
    await router.handle(update);
    expect(service.setup).toHaveBeenCalledWith('77', '900', '-2002');
  });

  it('ignores a recovery command from a private chat', async () => {
    const { router, service, telegram } = fixture();
    const update = message('/status') as any;
    update.message.from.id = 900;
    update.message.chat.type = 'private';
    await router.handle(update);
    expect(service.status).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('does not run /setup outside a group or supergroup', async () => {
    const { router, service, telegram } = fixture();
    const update = message('/setup') as any;
    update.message.from.id = 900;
    update.message.chat.type = 'private';
    await router.handle(update);
    expect(service.setup).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['update_id', (u: any) => { u.update_id = Number.MAX_SAFE_INTEGER + 1; }],
    ['from.id', (u: any) => { u.callback_query.from.id = Number.MAX_SAFE_INTEGER + 1; }],
    ['chat.id', (u: any) => { u.callback_query.message.chat.id = Number.MAX_SAFE_INTEGER + 1; }],
    ['message_id', (u: any) => { u.callback_query.message.message_id = Number.MAX_SAFE_INTEGER + 1; }],
  ])('answers an invalid callback exactly once when %s is unsafe', async (_field, mutate) => {
    const { router, service, telegram } = fixture();
    const update = callback('v1:w:2') as any;
    mutate(update);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await router.handle(update);
    expect(service.recordWin).not.toHaveBeenCalled();
    expect(telegram.answerCallback).toHaveBeenCalledOnce();
    expect(telegram.answerCallback).toHaveBeenCalledWith('cq', 'Некорректное действие', true);
    logged.mockRestore();
  });

  it.each([
    ['update_id', (u: any) => { u.update_id = Number.MAX_SAFE_INTEGER + 1; }],
    ['user id', (u: any) => { u.message.from.id = Number.MAX_SAFE_INTEGER + 1; }],
    ['chat id', (u: any) => { u.message.chat.id = Number.MAX_SAFE_INTEGER + 1; }],
  ])('rejects an unsafe numeric %s and logs validation only', async (_name, mutate) => {
    const { router, service } = fixture();
    const update = message('+') as any;
    mutate(update);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await router.handle(update);
    expect(service.setParty).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('telegram_update_validation'));
    logged.mockRestore();
  });

  it('returns successfully for unsupported update types', async () => {
    const { router, service } = fixture();
    await expect(router.handle({ update_id: 77, poll: { id: 'p' } })).resolves.toBeUndefined();
    expect(service.setParty).not.toHaveBeenCalled();
  });
});
