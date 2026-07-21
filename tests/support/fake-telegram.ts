import type { InlineKeyboard, TelegramPort } from '../../src/ports/telegram';

export type TelegramCall =
  | { kind: 'sendMessage'; chatId: string; html: string; keyboard?: InlineKeyboard }
  | { kind: 'editMessage'; chatId: string; messageId: string; html: string; keyboard?: InlineKeyboard }
  | { kind: 'answerCallback'; callbackQueryId: string; text: string; showAlert?: boolean }
  | { kind: 'pinMessage'; chatId: string; messageId: string };

export class FakeTelegram implements TelegramPort {
  readonly calls: TelegramCall[] = [];
  private nextMessageId = 1;

  async sendMessage(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<{ messageId: string }> {
    this.calls.push(keyboard ? { kind: 'sendMessage', chatId, html, keyboard } : { kind: 'sendMessage', chatId, html });
    return { messageId: String(this.nextMessageId++) };
  }

  async editMessage(chatId: string, messageId: string, html: string, keyboard?: InlineKeyboard): Promise<void> {
    this.calls.push(keyboard
      ? { kind: 'editMessage', chatId, messageId, html, keyboard }
      : { kind: 'editMessage', chatId, messageId, html });
  }

  async answerCallback(callbackQueryId: string, text: string, showAlert?: boolean): Promise<void> {
    this.calls.push(showAlert === undefined
      ? { kind: 'answerCallback', callbackQueryId, text }
      : { kind: 'answerCallback', callbackQueryId, text, showAlert });
  }

  async pinMessage(chatId: string, messageId: string): Promise<void> {
    this.calls.push({ kind: 'pinMessage', chatId, messageId });
  }
}
