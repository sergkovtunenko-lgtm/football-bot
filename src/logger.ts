type LogFields = Record<string, unknown>;

const sensitiveKey = /token|secret|authorization/i;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redact(nestedValue)]),
    );
  }
  return value;
};

const redactFields = (fields: LogFields): LogFields => redact(fields) as LogFields;

export function logInfo(event: string, fields: LogFields): void {
  console.log(JSON.stringify({ event, ...redactFields(fields) }));
}

export function logError(event: string, error: unknown, fields: LogFields): void {
  console.error(JSON.stringify({ event, error: redact(error), ...redactFields(fields) }));
}
