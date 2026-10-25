import type { LoggerService } from '@nestjs/common';
import { currentLogContext } from './log-context';

const SENSITIVE_KEYS = /amount|balance|money|authorization|password|secret|token/i;

/** Remove valores financeiros e credenciais, mesmo se alguém logar um objeto inteiro. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitize(v, depth + 1),
    ]),
  );
}

export class JsonLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]) { this.write('info', message, params); }
  error(message: unknown, ...params: unknown[]) { this.write('error', message, params); }
  warn(message: unknown, ...params: unknown[]) { this.write('warn', message, params); }
  debug(message: unknown, ...params: unknown[]) { this.write('debug', message, params); }
  verbose(message: unknown, ...params: unknown[]) { this.write('verbose', message, params); }
  fatal(message: unknown, ...params: unknown[]) { this.write('fatal', message, params); }

  private write(level: string, message: unknown, params: unknown[]): void {
    const last = params[params.length - 1];
    const context = typeof last === 'string' ? last : undefined;
    const body =
      typeof message === 'object' && message !== null
        ? (sanitize(message) as Record<string, unknown>)
        : { msg: String(message) };

    process.stdout.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), context, ...currentLogContext(), ...body })}\n`,
    );
  }
}