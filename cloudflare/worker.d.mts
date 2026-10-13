export interface IngressEnvironment {
  WEBHOOK_SECRET: string;
  BOT_TOKEN: string;
  TELEGRAM_UPDATES: { send(body: unknown): Promise<void> };
  YANDEX_FUNCTION_URL?: string;
}
export interface QueueMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}
export interface QueueBatch { messages: QueueMessage[]; }
export function createWorker(fetcher: typeof fetch): {
  fetch(request: Request, env: IngressEnvironment, context?: unknown): Promise<Response>;
  queue(batch: QueueBatch, env: IngressEnvironment, context?: unknown): Promise<void>;
};
