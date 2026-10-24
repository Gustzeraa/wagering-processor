import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

async function main() {
  const command = process.argv[2];
  const orm = await MikroORM.init({ ...config, debug: false });

  try {
    if (command === 'up') {
      const done = await orm.migrator.up();
      console.log('applied:', done.map((m) => m.name));
    } else if (command === 'down') {
      const done = await orm.migrator.down();
      console.log('reverted:', done.map((m) => m.name));
    } else {
      console.error('usage: bun src/migrate.ts <up|down>');
      process.exitCode = 1;
    }
  } finally {
    await orm.close();
  }
}

void main();