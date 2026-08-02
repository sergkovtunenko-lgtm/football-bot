import { describe, expect, it, vi } from 'vitest';
import { TelegramApiError, TelegramClient } from '../../src/adapters/telegram/client';
import { TelegramError } from '../../src/ports/telegram';

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

describe('TelegramClient', () => {
  it('uses the configured gateway without putting the bot token in its URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ message_id: 7 }));
    const client = new TelegramClient(
      'secret-token',
      fetcher,
      vi.fn().mockResolvedValue(undefined),
      'https://worker.example/telegram-api',
      'gateway_secret_123456',
    );

    await client.sendMessage('-100', 'text');

    expect(fetcher.mock.calls[0]![0]).toBe('https://worker.example/telegram-api/sendMessage');
    expect(fetcher.mock.calls[0]![0]).not.toContain('secret-token');
    expect(fetcher.mock.calls[0]![1].headers).toMatchObject({
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'gateway_secret_123456',
    });
  });

  it('sends HTML messages as POST JSON and converts the numeric message ID to a string', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ message_id: 7 }));
    const client = new TelegramClient('secret-token', fetcher, vi.fn().mockResolvedValue(undefined));

    await expect(client.sendMessage('-100', '<b>text</b>')).resolves.toEqual({ messageId: '7' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.telegram.org/botsecret-token/sendMessage',
      expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json' } }),
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({ chat_id: '-100', text: '<b>text</b>', parse_mode: 'HTML' });
  });

  it('honors Telegram retry_after', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 }))
      .mockResolvedValueOnce(ok({ message_id: 7 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new TelegramClient('secret-token', fetcher, sleep);

    await expect(client.sendMessage('-100', 'text')).resolves.toEqual({ messageId: '7' });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries a 5xx with bounded exponential backoff', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'bad gateway' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(ok({ message_id: 7 }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await new TelegramClient('secret-token', fetcher, sleep).sendMessage('-100', 'text');
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('does not retry a non-rate-limit 4xx and never includes the token in its error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new TelegramClient('secret-token', fetcher, sleep);

    const request = client.sendMessage('-100', 'text');
    await expect(request).rejects.toMatchObject({ method: 'sendMessage', status: 400 } satisfies Partial<TelegramApiError>);
    await request.catch((error: unknown) => expect(String(error)).not.toContain('secret-token'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports delivery failures through the Telegram port error contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, description: 'chat not found',
    }), { status: 400 }));
    const request = new TelegramClient('secret-token', fetcher, vi.fn()).sendMessage('-100', 'text');
    await expect(request).rejects.toBeInstanceOf(TelegramError);
  });

  it('does not treat a malformed 4xx response as a retryable network error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('not json', { status: 400 }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(new TelegramClient('secret-token', fetcher, sleep).sendMessage('-100', 'text'))
      .rejects.toMatchObject({ method: 'sendMessage', status: 400 } satisfies Partial<TelegramApiError>);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('redacts the token even when Telegram returns it in an error description', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, description: 'request for secret-token was rejected',
    }), { status: 400 }));
    const client = new TelegramClient('secret-token', fetcher, vi.fn().mockResolvedValue(undefined));

    await client.sendMessage('-100', 'text').catch((error: unknown) => expect(String(error)).not.toContain('secret-token'));
  });

  it('passes an eight-second abort signal to fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ message_id: 7 }));
    await new TelegramClient('secret-token', fetcher, vi.fn().mockResolvedValue(undefined)).sendMessage('-100', 'text');
    const request = fetcher.mock.calls[0]![1];
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('pins without notifying group members', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(true));
    await new TelegramClient('secret-token', fetcher, vi.fn().mockResolvedValue(undefined))
      .pinMessage('-100', '7');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({
      chat_id: '-100',
      message_id: '7',
      disable_notification: true,
    });
  });
});
