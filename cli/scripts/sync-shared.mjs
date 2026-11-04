// Copies ../shared/{redact,schema} into src/shared so the npm tarball is self-contained.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '..', '..', 'shared');
const to = path.join(here, '..', 'src', 'shared');
if (!existsSync(from)) { console.log('sync-shared: ../shared not found, keeping existing src/shared'); process.exit(0); }
for (const d of ['redact', 'schema']) {
  rmSync(path.join(to, d), { recursive: true, force: true });
  cpSync(path.join(from, d), path.join(to, d), { recursive: true });
}
console.log('sync-shared: copied redact + schema');
