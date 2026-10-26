import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyMigrations } from '../copyMigrations';

let root: string;
let from: string;
let to: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-copy-'));
  from = path.join(root, 'from');
  to = path.join(root, 'to');
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, '001_a.sql'), 'select 1;');
  fs.writeFileSync(path.join(from, '002_b.sql'), 'select 2;');
  fs.writeFileSync(path.join(from, 'seed.sql'), 'insert into x values (1);');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('copyMigrations', () => {
  it('copies every migration on the first run, creating the destination', () => {
    const out = copyMigrations(from, to);
    expect(out).toEqual({ copied: ['001_a.sql', '002_b.sql'], same: [] });
    expect(fs.readFileSync(path.join(to, '002_b.sql'), 'utf8')).toBe('select 2;');
  });

  it('reports both as same on the second run', () => {
    copyMigrations(from, to);
    expect(copyMigrations(from, to)).toEqual({ copied: [], same: ['001_a.sql', '002_b.sql'] });
  });

  it('copies only the files the destination lacks', () => {
    copyMigrations(from, to);
    fs.writeFileSync(path.join(from, '003_c.sql'), 'select 3;');
    expect(copyMigrations(from, to)).toEqual({
      copied: ['003_c.sql'],
      same: ['001_a.sql', '002_b.sql'],
    });
  });

  it('throws when a same-named destination file differs, writing nothing new', () => {
    copyMigrations(from, to);
    fs.writeFileSync(path.join(to, '001_a.sql'), 'select 99;');
    fs.writeFileSync(path.join(from, '003_c.sql'), 'select 3;');
    expect(() => copyMigrations(from, to)).toThrow(
      'ww-core: 001_a.sql differs from the package copy',
    );
    expect(fs.existsSync(path.join(to, '003_c.sql'))).toBe(false);
  });

  it('never copies seed.sql or non-sql files', () => {
    fs.writeFileSync(path.join(from, 'notes.md'), 'x');
    copyMigrations(from, to);
    expect(fs.readdirSync(to).sort()).toEqual(['001_a.sql', '002_b.sql']);
  });
});
