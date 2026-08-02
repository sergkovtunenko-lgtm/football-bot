import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = {
  BOT_TOKEN: '123456:secret',
  WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwxyz_123456',
  ADMIN_IDS: '111,222',
  YDB_CONNECTION_STRING: 'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/db',
  TELEGRAM_API_BASE_URL: 'https://worker.example/telegram-api',
};

describe('loadConfig', () => {
  it('parses string Telegram IDs without precision loss', () => {
    expect(loadConfig(valid).adminIds).toEqual(new Set(['111', '222']));
  });

  it('accepts semicolon-separated admin IDs from the deployment environment map', () => {
    expect(loadConfig({ ...valid, ADMIN_IDS: '111;222' }).adminIds).toEqual(new Set(['111', '222']));
  });

  it.each(['BOT_TOKEN', 'WEBHOOK_SECRET', 'ADMIN_IDS', 'YDB_CONNECTION_STRING', 'TELEGRAM_API_BASE_URL'])(
    'rejects a missing %s',
    (key) => {
      const env = { ...valid };
      delete env[key as keyof typeof env];
      expect(() => loadConfig(env)).toThrow(`Missing ${key}`);
    },
  );

  it('rejects an invalid webhook secret', () => {
    expect(() => loadConfig({ ...valid, WEBHOOK_SECRET: 'spaces are forbidden' })).toThrow(
      'Invalid WEBHOOK_SECRET',
    );
  });

  it('rejects non-numeric administrator IDs', () => {
    expect(() => loadConfig({ ...valid, ADMIN_IDS: '111,not-a-number' })).toThrow(
      'Invalid ADMIN_IDS',
    );
  });

  it.each([
    'http://worker.example/telegram-api',
    'https://user:password@worker.example/telegram-api',
    'https://worker.example/telegram-api?secret=leak',
    'https://worker.example/telegram-api#fragment',
  ])('rejects unsafe Telegram API base URL %s', (telegramApiBaseUrl) => {
    expect(() => loadConfig({ ...valid, TELEGRAM_API_BASE_URL: telegramApiBaseUrl })).toThrow(
      'Invalid TELEGRAM_API_BASE_URL',
    );
  });
});
