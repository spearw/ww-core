import fs from 'node:fs';
import path from 'node:path';

/** Copies each `*.sql` of `fromDir` (never `seed.sql`) that `toDir` lacks. Migrations are
 *  immutable: a same-named file that differs throws. Nothing is written until all are checked. */
export function copyMigrations(
  fromDir: string,
  toDir: string,
): { copied: string[]; same: string[] } {
  const files = fs
    .readdirSync(fromDir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort();
  const copied: string[] = [];
  const same: string[] = [];
  for (const f of files) {
    const dest = path.join(toDir, f);
    if (!fs.existsSync(dest)) {
      copied.push(f);
    } else if (fs.readFileSync(dest).equals(fs.readFileSync(path.join(fromDir, f)))) {
      same.push(f);
    } else {
      throw new Error(`ww-core: ${f} differs from the package copy`);
    }
  }
  if (copied.length > 0) fs.mkdirSync(toDir, { recursive: true });
  for (const f of copied) fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
  return { copied, same };
}
