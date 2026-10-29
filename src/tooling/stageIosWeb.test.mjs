import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stageBundledWeb } from '../../scripts/stage-ios-web.mjs';

test('bundled app copies exact bytes and replaces obsolete assets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'dist'),
    target = path.join(root, 'WebApp');
  await mkdir(source);
  await mkdir(target);
  await writeFile(path.join(source, 'index.html'), '<html>current</html>');
  await writeFile(path.join(target, 'old.js'), 'obsolete');
  await mkdir(path.join(source, 'assets'));
  await writeFile(
    path.join(source, 'assets/data.bin'),
    Buffer.from([0, 128, 255]),
  );
  const manifest = await stageBundledWeb(source, target);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ['assets/data.bin', 'index.html'],
  );
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(target, entry.path));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
    );
  }
  await assert.rejects(readFile(path.join(target, 'old.js')), {
    code: 'ENOENT',
  });
});

for (const kind of [
  'symlink',
  'credentials',
  'reserved manifest',
  'no index',
]) {
  test(`invalid ${kind} build leaves the previous bundle intact`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'gev-stage-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'dist'),
      target = path.join(root, 'WebApp');
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(target, 'index.html'), 'previous valid app');
    if (kind !== 'no index')
      await writeFile(path.join(source, 'index.html'), 'new app');
    if (kind === 'symlink')
      await symlink(
        path.join(target, 'index.html'),
        path.join(source, 'escape'),
      );
    if (kind === 'credentials')
      await writeFile(path.join(source, '.env.production'), 'secret');
    if (kind === 'reserved manifest')
      await writeFile(path.join(source, 'bundle-manifest.json'), '{}');
    await assert.rejects(stageBundledWeb(source, target));
    assert.equal(
      await readFile(path.join(target, 'index.html'), 'utf8'),
      'previous valid app',
    );
  });
}
