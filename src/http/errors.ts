import { z } from 'zod';
import { UUID_PATTERN } from './schemas';

export class RequestValidationError extends Error {
  readonly code = 'INVALID_PAYLOAD';
}

export class ResourceNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new RequestValidationError(issues.join('; '));
  }
  return result.data;
}

export function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new RequestValidationError(`${name} must be a UUID`);
  }
}