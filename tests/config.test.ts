import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = {
  BOT_TOKEN: '123456:secret',
  WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwxyz_123456',
  ADMIN_IDS: '111,222',
  YDB_CONNECTION_STRING: 'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/db',
};

describe('loadConfig', () => {
  it('parses string Telegram IDs without precision loss', () => {
    expect(loadConfig(valid).adminIds).toEqual(new Set(['111', '222']));
  });

  it('accepts semicolon-separated admin IDs from the deployment environment map', () => {
    expect(loadConfig({ ...valid, ADMIN_IDS: '111;222' }).adminIds).toEqual(new Set(['111', '222']));
  });

  it.each(['BOT_TOKEN', 'WEBHOOK_SECRET', 'ADMIN_IDS', 'YDB_CONNECTION_STRING'])(
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
});
