import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { BotService } from './application/bot-service';
import { OutboxWorker } from './application/outbox-worker';
import { Scheduler } from './application/scheduler';
import { UpdateRouter } from './application/update-router';
import { TelegramClient } from './adapters/telegram/client';
import { getYdbDriver } from './adapters/ydb/connection';
import { YdbFootballStore } from './adapters/ydb/store';
import { loadConfig } from './config';
import { logError } from './logger';

const MAX_BODY_BYTES = 1024 * 1024;
const TIMER_EVENT_TYPE = 'yandex.cloud.events.serverless.triggers.TimerMessage';

interface RuntimeDependencies {
  router: { handle(update: unknown): Promise<void> };
  scheduler: { tick(): Promise<void> };
  outbox: { flush(limit?: number): Promise<{ sent: number; rescheduled: number }> };
}

interface HandlerDependencies extends RuntimeDependencies {
  webhookSecret: string;
  newCorrelationId: () => string;
}

interface LazyHandlerOptions {
  webhookSecret: string;
  resolveDependencies: () => Promise<RuntimeDependencies>;
  newCorrelationId: () => string;
}

export interface HandlerResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

type CloudHandler = (event: unknown, context: unknown) => Promise<HandlerResponse>;
type TelegramFetcher = (input: string, init: RequestInit) => Promise<Response>;

export function createRetryAfterPreservingFetcher(fetcher: TelegramFetcher): TelegramFetcher {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (response.status !== 429) return response;
    try {
      const payload = await response.clone().json() as unknown;
      if (!isRecord(payload) || !isRecord(payload.parameters)) return response;
      const retryAfter = payload.parameters.retry_after;
      if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter < 0) return response;
      const description = typeof payload.description === 'string'
        ? payload.description.replace(/\s*[;:,]?\s*retry after\s+\d+/ig, '').trim()
        : 'Too Many Requests';
      return new Response(JSON.stringify({
        ...payload,
        description: `${description}; retry after ${Math.ceil(retryAfter)}`,
      }), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
}

export function createHandler(deps: HandlerDependencies): CloudHandler {
  return createLazyHandler({
    webhookSecret: deps.webhookSecret,
    resolveDependencies: async () => deps,
    newCorrelationId: deps.newCorrelationId,
  });
}

export function createLazyHandler(options: LazyHandlerOptions): CloudHandler {
  return async (event: unknown, _context: unknown): Promise<HandlerResponse> => {
    const correlationId = options.newCorrelationId();
    if (hasHttpShape(event)) {
      const preflight = preflightHttp(event, options.webhookSecret);
      if ('response' in preflight) return preflight.response;
      const deps = await resolveDependencies(options.resolveDependencies, correlationId, true);
      if (!deps) return jsonResponse(500, { error: 'initialization_failed', correlationId });
      return handleAuthenticatedHttp(preflight.update, deps, correlationId);
    }
    if (isTimerEvent(event)) {
      const deps = await resolveDependencies(options.resolveDependencies, correlationId, false);
      if (!deps) throw new Error(`Initialization failed (${correlationId})`);
      try {
        await deps.scheduler.tick();
        await deps.outbox.flush(10);
        return response(200, 'ok');
      } catch (error) {
        logUnhandled('timer_invocation_failed', error, correlationId);
        throw error;
      }
    }
    return response(400, 'unsupported event');
  };
}

function preflightHttp(
  event: Record<string, unknown>,
  webhookSecret: string,
): { response: HandlerResponse } | { update: unknown } {
  if (typeof event.httpMethod !== 'string' || event.httpMethod.toUpperCase() !== 'POST') {
    return { response: {
      statusCode: 405,
      headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
      body: 'method not allowed',
    } };
  }

  const headers = normalizedHeaders(event.headers);
  const suppliedSecret = headers['x-telegram-bot-api-secret-token'];
  if (!secretMatches(suppliedSecret, webhookSecret)) return { response: response(403, 'forbidden') };

  if (bodyByteLength(event.body) > MAX_BODY_BYTES) return { response: response(413, 'payload too large') };
  try {
    return { update: parseBody(event.body) };
  } catch {
    return { response: response(400, 'invalid json') };
  }
}

async function handleAuthenticatedHttp(
  update: unknown,
  deps: RuntimeDependencies,
  correlationId: string,
): Promise<HandlerResponse> {
  try {
    await deps.router.handle(update);
    await deps.outbox.flush(10);
    return response(200, 'ok');
  } catch (error) {
    logUnhandled('telegram_webhook_failed', error, correlationId);
    return jsonResponse(500, { error: 'internal_error', correlationId });
  }
}

async function resolveDependencies(
  factory: () => Promise<RuntimeDependencies>,
  correlationId: string,
  isHttp: boolean,
): Promise<RuntimeDependencies | undefined> {
  try {
    return await factory();
  } catch (error) {
    logUnhandled('handler_initialization_failed', error, correlationId);
    if (!isHttp) throw error;
    return undefined;
  }
}

function response(statusCode: number, body: string): HandlerResponse {
  return { statusCode, headers: { 'content-type': 'text/plain; charset=utf-8' }, body };
}

function jsonResponse(statusCode: number, value: unknown): HandlerResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(value),
  };
}

function hasHttpShape(event: unknown): event is Record<string, unknown> {
  return isRecord(event) && Object.prototype.hasOwnProperty.call(event, 'httpMethod');
}

function isTimerEvent(event: unknown): boolean {
  if (!isRecord(event) || !Array.isArray(event.messages)) return false;
  const first = event.messages[0];
  return isRecord(first)
    && isRecord(first.event_metadata)
    && first.event_metadata.event_type === TIMER_EVENT_TYPE;
}

function normalizedHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string') normalized[key.toLowerCase()] = headerValue;
  }
  return normalized;
}

function secretMatches(supplied: string | undefined, expected: string): boolean {
  if (supplied === undefined) return false;
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function bodyByteLength(body: unknown): number {
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return MAX_BODY_BYTES + 1;
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body === 'string') return JSON.parse(body) as unknown;
  if (body !== null && typeof body === 'object') return body;
  throw new Error('request body must be JSON');
}

function logUnhandled(event: string, error: unknown, correlationId: string): void {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  logError(event, new Error(errorName), { correlationId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let productionDependenciesPromise: Promise<RuntimeDependencies> | undefined;
let productionConfigValue: ReturnType<typeof loadConfig> | undefined;

function productionConfig(): ReturnType<typeof loadConfig> {
  productionConfigValue ??= loadConfig();
  return productionConfigValue;
}

async function productionDependencies(config: ReturnType<typeof loadConfig>): Promise<RuntimeDependencies> {
  productionDependenciesPromise ??= initializeProductionDependencies(config).catch((error: unknown) => {
    productionDependenciesPromise = undefined;
    throw error;
  });
  return productionDependenciesPromise;
}

async function initializeProductionDependencies(config: ReturnType<typeof loadConfig>): Promise<RuntimeDependencies> {
  const driver = await getYdbDriver(config.ydbConnectionString);
  const store = new YdbFootballStore(driver);
  const clock = { now: () => new Date() };
  const random = { int: (maxExclusive: number) => randomInt(maxExclusive) };
  const newId = () => randomUUID();
  const telegram = new TelegramClient(config.botToken, createRetryAfterPreservingFetcher(
    (input, init) => globalThis.fetch(input, init),
  ));
  const service = new BotService(store, clock, random, config.adminIds, newId);
  const scheduler = new Scheduler(store, clock, random, newId);
  const router = new UpdateRouter(service, store, telegram, config);
  const outbox = new OutboxWorker(store, telegram, clock, newId);
  return { router, scheduler, outbox };
}

export const handler: CloudHandler = async (event: unknown, context: unknown): Promise<HandlerResponse> => {
  const correlationId = randomUUID();
  let config: ReturnType<typeof loadConfig>;
  try {
    config = productionConfig();
  } catch (error) {
    logUnhandled('handler_initialization_failed', error, correlationId);
    if (hasHttpShape(event)) return jsonResponse(500, { error: 'initialization_failed', correlationId });
    throw error;
  }
  return createLazyHandler({
    webhookSecret: config.webhookSecret,
    resolveDependencies: () => productionDependencies(config),
    newCorrelationId: () => correlationId,
  })(event, context);
};
