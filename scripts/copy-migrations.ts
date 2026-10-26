import path from 'node:path';

import { copyMigrations } from '../src/tools/copyMigrations';

const dest = process.argv[2];
if (!dest) {
  console.error('usage: tsx copy-migrations.ts <destination migrations dir>');
  process.exit(2);
}
try {
  const { copied, same } = copyMigrations(
    path.resolve(__dirname, '..', 'supabase', 'migrations'),
    path.resolve(dest),
  );
  for (const f of copied) console.log(`copied ${f}`);
  console.log(`${copied.length} copied, ${same.length} already present`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
