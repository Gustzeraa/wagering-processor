import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';

/**
 * Abre uma transação num EntityManager isolado.
 * Se duas requisições com a mesma chave correrem em wallets diferentes, a segunda
 * bate numa constraint UNIQUE no commit; repetimos uma vez, e aí ela enxerga a primeira.
 */
export async function inTransaction<T>(
  em: EntityManager,
  work: (tx: EntityManager) => Promise<T>,
  retries = 1,
): Promise<T> {
  try {
    return await em.fork().transactional(work);
  } catch (error) {
    if (error instanceof UniqueConstraintViolationException && retries > 0) {
      return inTransaction(em, work, retries - 1);
    }
    throw error;
  }
}