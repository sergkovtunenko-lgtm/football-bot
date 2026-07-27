import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error The Cloudflare Worker intentionally ships as native ESM.
import { createWorker } from '../../cloudflare/worker.mjs';

const SECRET = 'cloudflare_webhook_secret_123';
const FUNCTION_URL = 'https://functions.yandexcloud.net/function123?tag=stable';

function environment(send = vi.fn()) {
  return {
    TELEGRAM_UPDATES: { send },
    WEBHOOK_SECRET: SECRET,
    YANDEX_FUNCTION_URL: FUNCTION_URL,
  };
}

function telegramRequest(input: {
  secret?: string;
  body?: string;
  method?: string;
  path?: string;
} = {}) {
  return new Request(`https://bot.example${input.path ?? '/telegram'}`, {
    method: input.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(input.secret === undefined
        ? {}
        : { 'x-telegram-bot-api-secret-token': input.secret }),
    },
    ...((input.method ?? 'POST') === 'GET'
      ? {}
      : {
          body: input.body
            ?? JSON.stringify({ update_id: 91, message: { text: '/status' } }),
        }),
  });
}

function queueMessage(body: unknown, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe('Cloudflare Telegram ingress', () => {
  it('durably enqueues a validated update before acknowledging Telegram', async () => {
    const env = environment();
    const worker = createWorker(vi.fn());

    const response = await worker.fetch(
      telegramRequest({ secret: SECRET }),
      env,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(env.TELEGRAM_UPDATES.send).toHaveBeenCalledWith({
      update_id: 91,
      message: { text: '/status' },
    });
  });

  it.each([
    ['missing secret', telegramRequest(), 403],
    ['wrong secret', telegramRequest({ secret: 'wrong' }), 403],
    ['malformed JSON', telegramRequest({ secret: SECRET, body: '{' }), 400],
    ['missing update id', telegramRequest({ secret: SECRET, body: '{}' }), 400],
    ['wrong route', telegramRequest({ secret: SECRET, path: '/wrong' }), 404],
    ['wrong method', telegramRequest({ secret: SECRET, method: 'GET' }), 405],
  ])('rejects %s without touching the queue', async (_name, request, status) => {
    const env = environment();
    const response = await createWorker(vi.fn()).fetch(request, env, {} as never);

    expect(response.status).toBe(status);
    expect(env.TELEGRAM_UPDATES.send).not.toHaveBeenCalled();
  });
});

describe('Cloudflare queue delivery', () => {
  it('forwards each durable update to the stable Yandex function and acknowledges it', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const message = queueMessage({ update_id: 92 });
    const env = environment();

    await createWorker(fetcher).queue({ messages: [message] }, env, {} as never);

    expect(fetcher).toHaveBeenCalledWith(FUNCTION_URL, expect.objectContaining({
      method: 'POST',
      redirect: 'manual',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': SECRET,
      }),
      body: JSON.stringify({ update_id: 92 }),
    }));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each([
    ['upstream status', vi.fn().mockResolvedValue(new Response('', { status: 503 }))],
    ['transport error', vi.fn().mockRejectedValue(new Error('network'))],
  ])('retries with bounded backoff after %s', async (_name, fetcher) => {
    const message = queueMessage({ update_id: 93 }, 4);

    await createWorker(fetcher).queue(
      { messages: [message] },
      environment(),
      {} as never,
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  it('acknowledges an impossible poison message without forwarding it', async () => {
    const fetcher = vi.fn();
    const message = queueMessage('not-an-update');

    await createWorker(fetcher).queue(
      { messages: [message] },
      environment(),
      {} as never,
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('refuses a lookalike Yandex destination so the webhook secret cannot leak', async () => {
    const fetcher = vi.fn();
    const message = queueMessage({ update_id: 94 });
    const env = {
      ...environment(),
      YANDEX_FUNCTION_URL: 'https://functions.yandexcloud.net.evil.example/f?tag=stable',
    };

    await createWorker(fetcher).queue({ messages: [message] }, env, {} as never);

    expect(fetcher).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
  });

  it('does not follow an upstream redirect with the webhook secret', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', {
      status: 302,
      headers: { location: 'https://attacker.example/collect' },
    }));
    const message = queueMessage({ update_id: 95 });

    await createWorker(fetcher).queue(
      { messages: [message] },
      environment(),
      {} as never,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
  });

  it('returns 503 when durable enqueueing fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const response = await createWorker(vi.fn()).fetch(
      telegramRequest({ secret: SECRET }),
      environment(send),
      {} as never,
    );

    expect(response.status).toBe(503);
  });

  it('rejects an oversized update before enqueueing it', async () => {
    const env = environment();
    const response = await createWorker(vi.fn()).fetch(
      telegramRequest({
        secret: SECRET,
        body: JSON.stringify({ update_id: 96, padding: 'x'.repeat(128_001) }),
      }),
      env,
      {} as never,
    );

    expect(response.status).toBe(413);
    expect(env.TELEGRAM_UPDATES.send).not.toHaveBeenCalled();
  });

  it('caps retry backoff at fifteen minutes', async () => {
    const message = queueMessage({ update_id: 97 }, 100);

    await createWorker(vi.fn().mockRejectedValue(new Error('network'))).queue(
      { messages: [message] },
      environment(),
      {} as never,
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 900 });
  });

  it('drains an already queued update with the secret restored by first-deploy rollback', async () => {
    const previousSecret = 'previous_webhook_secret_123';
    const fetcher = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const message = queueMessage({ update_id: 98 });
    const env = {
      ...environment(),
      WEBHOOK_SECRET: previousSecret,
    };

    await createWorker(fetcher).queue({ messages: [message] }, env, {} as never);

    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      headers: expect.objectContaining({
        'x-telegram-bot-api-secret-token': previousSecret,
      }),
    });
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
