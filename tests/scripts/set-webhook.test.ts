import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error The production utility intentionally ships as native ESM.
import { getWebhookInfo, setWebhook } from '../../scripts/set-webhook.mjs';

const input = {
  botToken: '123456789:' + 'abcdefghijklmnopqrstuvwxyzABCDEFGH_12',
  webhookSecret: 'valid_secret_1234567890',
  functionUrl: 'https://functions.yandexcloud.net/function-id?tag=stable',
};

describe('setWebhook', () => {
  it('sends the exact secure webhook configuration', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await setWebhook(fetcher, input);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe(
      `https://api.telegram.org/bot${input.botToken}/setWebhook`,
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      url: 'https://functions.yandexcloud.net/function-id?tag=stable',
      secret_token: 'valid_secret_1234567890',
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  });

  it('throws on a failed Bot API response without exposing the token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      description: `request failed for ${input.botToken}`,
    }), { status: 401 }));

    let thrown: unknown;
    try {
      await setWebhook(fetcher, input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(input.botToken);
  });
});

describe('getWebhookInfo', () => {
  it('returns a verified pending update count', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: input.functionUrl,
        pending_update_count: 3,
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).resolves.toEqual({ pendingUpdateCount: 3 });
  });

  it('rejects a webhook URL that does not match', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: 'https://functions.yandexcloud.net/other?tag=stable',
        pending_update_count: 0,
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).rejects.toThrow('Webhook verification failed');
  });

  it('rejects an invalid pending update count', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: input.functionUrl,
        pending_update_count: -1,
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).rejects.toThrow('Webhook verification failed');
  });

  it('rejects a Telegram-reported webhook error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: input.functionUrl,
        pending_update_count: 0,
        last_error_message: 'upstream failed',
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).rejects.toThrow('Webhook verification failed');
  });
});
