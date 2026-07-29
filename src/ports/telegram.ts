export interface InlineKeyboard {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data: string;
    style?: 'success' | 'primary' | 'danger';
  }>>;
}

export interface SentMessage { messageId: string; }

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | undefined,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram API ${method} failed${status === undefined ? '' : ` (${status})`}: ${description}`);
    this.name = 'TelegramError';
  }
}

export interface TelegramPort {
  sendMessage(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, html: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallback(callbackQueryId: string, text: string, showAlert?: boolean): Promise<void>;
  pinMessage(chatId: string, messageId: string): Promise<void>;
}
