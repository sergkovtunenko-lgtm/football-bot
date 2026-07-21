import { TelegramError, type InlineKeyboard, type SentMessage, type TelegramPort } from '../../ports/telegram';
import { telegramId, type TelegramApiResponse } from './types';

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

export class TelegramApiError extends TelegramError {
  constructor(
    method: string,
    status: number | undefined,
    description: string,
    retryAfterSeconds?: number,
  ) {
    super(method, status, description, retryAfterSeconds);
    this.name = 'TelegramApiError';
  }
}

export class TelegramClient implements TelegramPort {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly sleep: Sleeper = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async sendMessage(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<SentMessage> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId, text: html, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return { messageId: telegramId(result.message_id) };
  }

  async editMessage(chatId: string, messageId: string, html: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async answerCallback(callbackQueryId: string, text: string, showAlert?: boolean): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId, text, ...(showAlert === undefined ? {} : { show_alert: showAlert }),
    });
  }

  async pinMessage(chatId: string, messageId: string): Promise<void> {
    await this.call('pinChatMessage', { chat_id: chatId, message_id: messageId });
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const delays = [250, 500];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
        });
      } catch {
        if (attempt < delays.length) {
          await this.sleep(delays[attempt]!);
          continue;
        }
        throw new TelegramApiError(method, undefined, 'network request failed');
      }

      let payload: TelegramApiResponse<T>;
      try {
        payload = await response.json() as TelegramApiResponse<T>;
      } catch {
        payload = { ok: false, description: 'invalid Telegram response' };
      }

      if (payload.ok && payload.result !== undefined) return payload.result;
      const status = response.status;
      const description = this.safeDescription(payload.description ?? 'Telegram rejected the request');
      const retryAfter = payload.parameters?.retry_after;
      if (status === 429 && Number.isFinite(retryAfter) && retryAfter !== undefined && attempt < delays.length) {
        await this.sleep(retryAfter * 1000);
        continue;
      }
      if (status >= 500 && status <= 599 && attempt < delays.length) {
        await this.sleep(delays[attempt]!);
        continue;
      }
      throw new TelegramApiError(method, status, description, retryAfter);
    }
    throw new TelegramApiError(method, undefined, 'network request failed');
  }

  private safeDescription(description: string): string {
    return this.token === '' ? description : description.replaceAll(this.token, '[redacted]');
  }
}
