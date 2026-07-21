import { EnvironCredentialsProvider } from '@ydbjs/auth/environ';
import { Driver } from '@ydbjs/core';

let cached: Promise<Driver> | undefined;

export function getYdbDriver(connectionString: string): Promise<Driver> {
  cached ??= (async () => {
    const credentials = new EnvironCredentialsProvider(connectionString);
    const driver = new Driver(connectionString, {
      credentialsProvider: credentials,
      secureOptions: credentials.secureOptions,
    });
    await driver.ready(AbortSignal.timeout(8_000));
    return driver;
  })().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
