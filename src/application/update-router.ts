import type { AppConfig } from '../config';
import {
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  type BotService,
} from './bot-service';
import type { FootballStore } from '../ports/store';
import type { TelegramPort } from '../ports/telegram';
import { renderStatus } from '../adapters/telegram/render';
import { logError } from '../logger';

type RouterService = Pick<BotService,
  | 'setup'
  | 'openNow'
  | 'setParty'
  | 'closeNow'
  | 'recordWin'
  | 'undoLastWin'
  | 'finish'
  | 'getPartySize'
  | 'registrationView'
  | 'status'>;

interface ParsedUser {
  id: string;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
}

interface ParsedMessage {
  messageId: string;
  from?: ParsedUser;
  chatId: string;
  chatType: string;
  text?: string;
}

interface ParsedCallback {
  id: string;
  from: ParsedUser;
  data?: string;
  message?: ParsedMessage;
}

interface ParsedUpdate {
  updateId: string;
  message?: ParsedMessage;
  callback?: ParsedCallback;
}

interface RegistrationCallback {
  partySize: 0 | 1 | 2 | 3;
  sessionId?: string;
}

class UpdateValidationError extends Error {}

export class UpdateRouter {
  constructor(
    private readonly service: RouterService,
    private readonly store: FootballStore,
    private readonly telegram: TelegramPort,
    private readonly config: AppConfig,
  ) {}

  async handle(value: unknown): Promise<void> {
    let update: ParsedUpdate;
    try {
      update = parseUpdate(value);
    } catch (error) {
      logError('telegram_update_validation', error, {});
      const callbackId = rawCallbackId(value);
      if (callbackId !== undefined) {
        await this.telegram.answerCallback(callbackId, 'Некорректное действие', true);
      }
      return;
    }
    if (update.callback) {
      await this.handleCallback(update.updateId, update.callback);
      return;
    }
    if (update.message) await this.handleMessage(update.updateId, update.message);
  }

  private async handleMessage(updateId: string, message: ParsedMessage): Promise<void> {
    const actor = message.from;
    if (!actor || actor.isBot || message.text === undefined) return;
    const text = normalizeText(message.text);
    const command = commandName(text);
    if (command) {
      await this.handleCommand(updateId, actor, message, command);
      return;
    }
    const partyToken = registrationToken(text);
    if (partyToken === undefined || !await this.isConfiguredGroup(message.chatId)) return;
    const partySize = partyToken === '-1'
      ? Math.max(1, (await this.service.getPartySize(actor.id)) - 1) as 1 | 2
      : partyToken === '-2' ? 1 : partyToken;
    try {
      await this.service.setParty(updateId, playerFrom(actor), partySize);
    } catch (error) {
      if (error instanceof InvalidStateError || error instanceof NotFoundError) {
        await this.telegram.sendMessage(message.chatId, 'Запись сейчас недоступна');
        return;
      }
      throw error;
    }
  }

  private async handleCommand(
    updateId: string,
    actor: ParsedUser,
    message: ParsedMessage,
    command: RecoveryCommand,
  ): Promise<void> {
    if (message.chatType !== 'group' && message.chatType !== 'supergroup') return;
    if (command !== '/setup' && !await this.isConfiguredGroup(message.chatId)) return;
    if (!this.config.adminIds.has(actor.id)) {
      await this.telegram.sendMessage(message.chatId, 'Только администратор');
      return;
    }
    switch (command) {
      case '/setup':
        await this.service.setup(updateId, actor.id, message.chatId);
        break;
      case '/status':
        await this.telegram.sendMessage(message.chatId, renderStatus(await this.service.status()));
        break;
      case '/open':
        await this.service.openNow(updateId, actor.id);
        break;
      case '/close':
        await this.service.closeNow(updateId, actor.id);
        break;
      case '/undo':
        await this.service.undoLastWin(updateId, actor.id);
        break;
      case '/finish':
        await this.showCommandFinishConfirmation(message.chatId);
        break;
    }
  }

  private async handleCallback(updateId: string, callback: ParsedCallback): Promise<void> {
    let answer = 'Готово';
    let showAlert: boolean | undefined;
    let unexpected: unknown;
    try {
      const message = callback.message;
      if (!message || !await this.isConfiguredGroup(message.chatId)) {
        answer = 'Эта кнопка уже неактуальна';
        showAlert = true;
      } else {
        const data = callback.data;
        const registration = registrationCallback(data);
        const team = winCallback(data);
        const isScoreAction = team !== undefined || data === 'v1:w:undo'
          || data === 'v1:w:finish' || data === 'v1:w:confirm_finish';
        if (registration !== undefined) {
          const registrationSnapshot = await this.service.registrationView();
          const session = await this.store.transact((tx) => tx.getSession(registrationSnapshot.sessionId));
          const currentScopedButton = registration.sessionId === registrationSnapshot.sessionId;
          const currentLegacyButton = registration.sessionId === undefined
            && session?.registrationMessageId === message.messageId;
          if (session?.status !== 'registration_open' || (!currentScopedButton && !currentLegacyButton)) {
            answer = 'Эта кнопка уже неактуальна';
            showAlert = true;
          }
        } else if (isScoreAction) {
          const status = await this.service.status();
          const session = await this.store.transact((tx) => tx.getSession(status.sessionId));
          if (session?.scoreMessageId !== message.messageId) {
            answer = 'Эта кнопка уже неактуальна';
            showAlert = true;
          }
        }

        if (showAlert === true) {
          // Freshness failures are answered below without invoking business state changes.
        } else if (registration !== undefined) {
          await this.service.setParty(updateId, playerFrom(callback.from), registration.partySize);
        } else if (team !== undefined) {
          this.requireAdmin(callback.from.id);
          await this.service.recordWin(updateId, callback.from.id, team);
        } else if (data === 'v1:w:undo') {
          this.requireAdmin(callback.from.id);
          await this.service.undoLastWin(updateId, callback.from.id);
        } else if (data === 'v1:w:finish') {
          this.requireAdmin(callback.from.id);
          await this.showFinishConfirmation(message.chatId, message.messageId);
        } else if (data === 'v1:w:confirm_finish') {
          this.requireAdmin(callback.from.id);
          await this.service.finish(updateId, callback.from.id);
        } else {
          answer = 'Кнопка не поддерживается';
        }
      }
    } catch (error) {
      if (error instanceof ForbiddenError) {
        answer = 'Только администратор';
        showAlert = true;
      } else if (error instanceof InvalidStateError || error instanceof NotFoundError) {
        answer = 'Эта кнопка уже неактуальна';
        showAlert = true;
      } else {
        answer = 'Не удалось выполнить действие';
        showAlert = true;
        unexpected = error;
      }
    }
    await this.telegram.answerCallback(callback.id, answer, showAlert);
    if (unexpected !== undefined) throw unexpected;
  }

  private requireAdmin(userId: string): void {
    if (!this.config.adminIds.has(userId)) throw new ForbiddenError('administrator required');
  }

  private async isConfiguredGroup(chatId: string): Promise<boolean> {
    const settings = await this.store.transact((tx) => tx.getSettings());
    return settings.groupChatId === chatId;
  }

  private async showCommandFinishConfirmation(chatId: string): Promise<void> {
    const status = await this.service.status();
    const session = await this.store.transact((tx) => tx.getSession(status.sessionId));
    if (session?.scoreMessageId !== undefined) {
      await this.showFinishConfirmation(chatId, session.scoreMessageId);
      return;
    }
    const created = await this.telegram.sendMessage(chatId, 'Завершить игровой вечер?', finishConfirmationKeyboard());
    if (session !== undefined) {
      await this.store.transact(async (tx) => {
        const current = await tx.getSession(status.sessionId);
        if (current) await tx.saveSession({ ...current, scoreMessageId: created.messageId });
      });
    }
  }

  private async showFinishConfirmation(chatId: string, messageId: string): Promise<void> {
    await this.telegram.editMessage(chatId, messageId, 'Завершить игровой вечер?', finishConfirmationKeyboard());
  }
}

type RecoveryCommand = '/setup' | '/status' | '/open' | '/close' | '/undo' | '/finish';

function finishConfirmationKeyboard() {
  return { inline_keyboard: [[
    { text: '✅ Да, завершить', callback_data: 'v1:w:confirm_finish' },
  ]] };
}

function parseUpdate(value: unknown): ParsedUpdate {
  if (!isRecord(value)) throw new UpdateValidationError('update must be an object');
  const updateId = numericId(value.update_id, 'update_id');
  const result: ParsedUpdate = { updateId };
  if (value.callback_query !== undefined) result.callback = parseCallback(value.callback_query);
  else if (value.message !== undefined) result.message = parseMessage(value.message);
  return result;
}

function parseCallback(value: unknown): ParsedCallback {
  if (!isRecord(value) || typeof value.id !== 'string') throw new UpdateValidationError('invalid callback query');
  const result: ParsedCallback = { id: value.id, from: parseUser(value.from) };
  if (typeof value.data === 'string') result.data = value.data;
  if (value.message !== undefined) result.message = parseMessage(value.message);
  return result;
}

function parseMessage(value: unknown): ParsedMessage {
  if (!isRecord(value) || !isRecord(value.chat)) throw new UpdateValidationError('invalid message');
  const result: ParsedMessage = {
    messageId: numericId(value.message_id, 'message_id'),
    chatId: numericId(value.chat.id, 'chat.id'),
    chatType: typeof value.chat.type === 'string' ? value.chat.type : '',
  };
  if (value.from !== undefined) result.from = parseUser(value.from);
  if (typeof value.text === 'string') result.text = value.text;
  return result;
}

function parseUser(value: unknown): ParsedUser {
  if (!isRecord(value) || typeof value.first_name !== 'string') throw new UpdateValidationError('invalid user');
  const result: ParsedUser = {
    id: numericId(value.id, 'user.id'),
    isBot: value.is_bot === true,
    firstName: value.first_name,
  };
  if (typeof value.last_name === 'string') result.lastName = value.last_name;
  if (typeof value.username === 'string') result.username = value.username;
  return result;
}

function numericId(value: unknown, field: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new UpdateValidationError(`${field} must be a safe integer`);
  }
  return String(value);
}

function normalizeText(text: string): string {
  return text.trim().replaceAll('＋', '+').replaceAll('－', '-').replaceAll('−', '-');
}

function registrationToken(text: string): 0 | 1 | 2 | 3 | '-1' | '-2' | undefined {
  switch (text) {
    case '+': return 1;
    case '+1': return 2;
    case '+2': return 3;
    case '-': return 0;
    case '-1': return '-1';
    case '-2': return '-2';
    default: return undefined;
  }
}

function registrationCallback(data: string | undefined): RegistrationCallback | undefined {
  if (data === 'v1:r:0') return { partySize: 0 };
  if (data === 'v1:r:1') return { partySize: 1 };
  if (data === 'v1:r:2') return { partySize: 2 };
  if (data === 'v1:r:3') return { partySize: 3 };
  const scoped = /^v2:r:(\d{4}-\d{2}-\d{2}):([0-3])$/.exec(data ?? '');
  if (scoped?.[1] !== undefined && scoped[2] !== undefined) {
    return { sessionId: scoped[1], partySize: Number(scoped[2]) as 0 | 1 | 2 | 3 };
  }
  return undefined;
}

function winCallback(data: string | undefined): 1 | 2 | 3 | 4 | undefined {
  if (data === 'v1:w:1') return 1;
  if (data === 'v1:w:2') return 2;
  if (data === 'v1:w:3') return 3;
  if (data === 'v1:w:4') return 4;
  return undefined;
}

function commandName(text: string): RecoveryCommand | undefined {
  const first = text.split(/\s+/, 1)[0]?.split('@', 1)[0];
  if (first === '/setup' || first === '/status' || first === '/open'
    || first === '/close' || first === '/undo' || first === '/finish') return first;
  return undefined;
}

function playerFrom(user: ParsedUser): { telegramUserId: string; displayName: string; username?: string } {
  const displayName = user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName;
  return user.username === undefined
    ? { telegramUserId: user.id, displayName }
    : { telegramUserId: user.id, displayName, username: user.username };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawCallbackId(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.callback_query)) return undefined;
  return typeof value.callback_query.id === 'string' ? value.callback_query.id : undefined;
}
