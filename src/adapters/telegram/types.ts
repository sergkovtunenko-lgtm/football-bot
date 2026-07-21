export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface Chat {
  id: number;
  type: 'group' | 'supergroup';
  title?: string;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface Message {
  message_id: number;
  from?: User;
  chat: Chat;
  date: number;
  text?: string;
  entities?: MessageEntity[];
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: Message;
  data?: string;
}

export interface Update {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export function telegramId(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error('Telegram ID must be a safe integer');
  return String(value);
}
