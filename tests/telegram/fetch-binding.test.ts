import { expect, it, vi } from 'vitest';
import { TelegramClient } from '../../src/adapters/telegram/client';

it('sends with the global fetch receiver required by the Workers runtime', async () => {
  vi.stubGlobal('fetch', function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(Response.json({ ok: true, result: { message_id: 41 } }));
  });
  try {
    const client = new TelegramClient('test-token');
    expect(await client.sendMessage('-1001', 'hello')).toEqual({ messageId: '41' });
  } finally { vi.unstubAllGlobals(); }
});
