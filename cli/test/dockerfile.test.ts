// The image builds the CLI with only the module files it imports, copied one
// by one (Dockerfile, the cli stage). A new import must be copied too (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '../..');

test('the Dockerfile copies every module file the CLI imports', () => {
  const dir = path.join(root, 'cli/src');
  const sources = (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.ts'));
  const imported = new Set<string>();
  for (const file of sources) {
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/from ['"](?:\.\.\/)+module\/src\/([\w-]+)(?:\.ts)?['"]/g)) imported.add(m[1]);
  }
  assert.ok(imported.size > 0);
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  for (const name of imported) {
    assert.ok(dockerfile.includes(`COPY module/src/${name}.ts /src/module/src/${name}.ts`), `the Dockerfile's cli stage must copy module/src/${name}.ts`);
  }
});
