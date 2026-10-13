import { randomInt, randomUUID } from 'node:crypto';
import { createWorker, type IngressEnvironment, type QueueBatch } from '../cloudflare/worker.mjs';
import { D1FootballStore, type FootballDatabase } from './adapters/d1/store';
import { TelegramClient } from './adapters/telegram/client';
import { BotService } from './application/bot-service';
import { OutboxWorker } from './application/outbox-worker';
import { Scheduler } from './application/scheduler';
import { UpdateRouter } from './application/update-router';
import { loadConfig } from './config';

export interface CloudflareEnvironment extends IngressEnvironment {
  DB: FootballDatabase;
  ADMIN_IDS: string;
  BOT_ACTIVE: string;
}
interface Runtime {
  router: { handle(update: unknown): Promise<void> };
  scheduler: { tick(): Promise<void> };
  outbox: { flush(limit: number): Promise<{ sent: number; rescheduled: number }> };
}

function runtime(env: CloudflareEnvironment): Runtime {
  const config = loadConfig({ BOT_TOKEN: env.BOT_TOKEN, WEBHOOK_SECRET: env.WEBHOOK_SECRET,
    ADMIN_IDS: env.ADMIN_IDS, YDB_CONNECTION_STRING: 'cloudflare-d1', TELEGRAM_API_BASE_URL: 'https://api.telegram.org' });
  const store = new D1FootballStore(env.DB);
  const clock = { now: () => new Date() };
  const random = { int: (maxExclusive: number) => randomInt(maxExclusive) };
  const telegram = new TelegramClient(config.botToken);
  return {
    router: new UpdateRouter(new BotService(store, clock, random, config.adminIds, randomUUID), store, telegram, config),
    scheduler: new Scheduler(store, clock, random, randomUUID),
    outbox: new OutboxWorker(store, telegram, clock, randomUUID),
  };
}

export function createCloudflareWorker(resolveRuntime: (env: CloudflareEnvironment) => Runtime = runtime) {
  const ingress = createWorker(globalThis.fetch);
  return {
    async fetch(request: Request, env: CloudflareEnvironment): Promise<Response> {
      if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
        try {
          const revision = await env.DB.prepare('SELECT revision FROM bot_revision WHERE id = 1').first<{ revision: number }>();
          const settings = await new D1FootballStore(env.DB).transact((tx) => tx.getSettings());
          return Response.json({ ready: !!revision && !!settings.groupChatId, active: env.BOT_ACTIVE === 'true',
            storage: 'd1' }, { status: revision && settings.groupChatId ? 200 : 503 });
        } catch { return Response.json({ ready: false, storage: 'd1' }, { status: 503 }); }
      }
      return ingress.fetch(request, env);
    },
    async queue(batch: QueueBatch, env: CloudflareEnvironment): Promise<void> {
      if (env.BOT_ACTIVE !== 'true') {
        for (const message of batch.messages) message.retry({ delaySeconds: 60 });
        return;
      }
      for (const message of batch.messages) {
        try {
          const deps = resolveRuntime(env);
          await deps.scheduler.tick();
          await deps.router.handle(message.body);
          await deps.outbox.flush(1);
          message.ack();
        } catch {
          console.error(JSON.stringify({ event: 'cloudflare_update_failed' }));
          message.retry({ delaySeconds: Math.min(30 * 2 ** Math.min(message.attempts - 1, 5), 900) });
        }
      }
    },
    async scheduled(_event: unknown, env: CloudflareEnvironment): Promise<void> {
      if (env.BOT_ACTIVE !== 'true') return;
      try {
        const deps = resolveRuntime(env);
        await deps.scheduler.tick();
        await deps.outbox.flush(1);
      } catch {
        console.error(JSON.stringify({ event: 'cloudflare_schedule_failed' }));
        throw new Error('Scheduled processing failed');
      }
    },
  };
}

export default createCloudflareWorker();
