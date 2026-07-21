export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface SentMessage { messageId: string; }

export interface TelegramPort {
  sendMessage(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, html: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallback(callbackQueryId: string, text: string, showAlert?: boolean): Promise<void>;
  pinMessage(chatId: string, messageId: string): Promise<void>;
}
