import type { Clock, IdGenerator } from '../application/ports';

export const systemClock: Clock = { now: () => new Date() };

/** UUID v7: ordenado por tempo, melhor para índices. */
export const uuidV7: IdGenerator = { next: () => Bun.randomUUIDv7() };