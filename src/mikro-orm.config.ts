import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { RECORDS } from './infrastructure/persistence/records';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD ?? 'wagering',
  dbName: process.env.DB_NAME ?? 'wagering',
  entities: RECORDS,
  metadataProvider: ReflectMetadataProvider,
  extensions: [Migrator],
  migrations: { path: 'src/migrations', snapshot: false },
  debug: true,
});