import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { BubblewrapIsolation } from './sandbox.js';
import { captureBaseline, contentHash } from './job-delta.js';
import { command, limits } from './__fixtures__/s1-scope.js';
import { preparedFixture, treeFixture } from './__fixtures__/s1-sandbox.js';

test('readonly project and dependency mounts coexist with writable private output', async t => {
  const f = await preparedFixture(t, true);
  const deps = join(f.project, 'node_modules'); mkdirSync(deps); writeFileSync(join(deps, 'fixture.txt'), 'dependency');
  f.request.config = { ...limits, dependencyRoots: [deps] };
  const second = await f.isolation.prepare({ ...f.request, jobId: 'readonly' });
  writeFileSync(join(second.runDirectory, 'schema.json'), '{}');
  await second.command(command({ argv: [process.execPath], cwd: f.project }));
  const args = f.executor.commands[0]!.argv;
  assert.equal(args[args.indexOf(second.privateRepo) - 1], '--bind');
  assert.equal(args[args.indexOf(deps) - 1], '--ro-bind');
  const sealed = args.indexOf('--remount-ro');
  assert.equal(args[sealed + 1], second.visibleCwd);
  assert.ok(sealed > args.indexOf(deps), 'create nested dependency mount points before sealing the private project');
  assert.ok(sealed < args.indexOf('--'), 'seal before executing any provider command');
  assert.equal(args[args.indexOf(second.runDirectory) - 1], '--bind');
  assert.equal(readFileSync(join(second.runDirectory, 'schema.json'), 'utf8'), '{}');
  f.executor.state = 'absent'; await second.dispose(); await f.handle.dispose();
});

test('host sandbox: private writes, readonly refusal, socket, hard limits and stubborn descendants', { timeout: 30_000 }, async t => {
  // Availability is itself a disposable local diagnostic, never a provider/auth probe.
  // Do it before allocating Git/socket fixtures so unsupported hosts give a clear reason.
  const base = process.env.TMPDIR ?? '/tmp';
  const isolation = new BubblewrapIsolation({ sandboxRoot: join(base, 'dovsky-s1-host-unused'), hiddenPaths: [] });
  const availability = await isolation.available();
  if (!availability.available) {
    const reason = `Host sandbox unavailable: ${availability.reason}; fixture tests do not establish readiness`;
    if (process.env.DOVSKY_REQUIRE_SANDBOX === '1') assert.fail(reason);
    t.skip(reason); return;
  }
  const f = treeFixture(t);
  const server = createServer(client => client.end('READY'));
  const socket = join(f.admin, 'job.sock');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const native = new BubblewrapIsolation({ sandboxRoot: f.sandboxRoot, hiddenPaths: [f.admin] });
  const deps = join(f.project, 'node_modules'), runtime = join(f.root, 'runtime');
  mkdirSync(deps); mkdirSync(runtime);
  for (const path of [deps, runtime]) writeFileSync(join(path, 'fixture.txt'), 'readonly fixture');
  const baseline = captureBaseline(f.project, join(f.root, 'baseline'));
  const request = { jobId: 'host', projectPath: f.project, visibleCwd: f.project, baseline, readOnly: false,
    config: { ...limits, dependencyRoots: [deps], runtimePaths: [runtime] }, jobSocketPath: socket };
  const writable = await native.prepare(request);
  const script = `const fs=require('node:fs'),net=require('node:net');
    if(process.cwd()!==${JSON.stringify(f.project)})throw Error('cwd');
    if(fs.existsSync(${JSON.stringify(f.admin)}))throw Error('admin exposed');
    for(const file of ${JSON.stringify([join(deps, 'fixture.txt'), join(runtime, 'fixture.txt')])}) {
      if(fs.readFileSync(file,'utf8')!=='readonly fixture')throw Error('runtime access');
      try {fs.writeFileSync(file,'must fail');throw Error('readonly mount writable')}catch(e){if(e.code!=='EROFS')throw e}
    }
    fs.writeFileSync('NEW.txt','private');
    fs.writeFileSync(${JSON.stringify(join(writable.runDirectory, 'output.json'))},'{}');
    net.connect(process.env.DOVSKY_SOCKET).on('data',d=>process.stdout.write(d));`;
  const write = await writable.command(command({ argv: [process.execPath, '-e', script], cwd: f.project, timeoutMs: 3000 }));
  assert.equal((await write.completion).exitCode, 0); assert.equal((await write.result).stdout, 'READY');
  assert.equal(existsSync(join(f.project, 'NEW.txt')), false); assert.equal(contentHash(f.project), baseline.manifest.identity.contentHash);
  assert.equal(readFileSync(join(writable.privateRepo, 'NEW.txt'), 'utf8'), 'private');
  await writable.dispose();
  const readonly = await native.prepare({ ...request, jobId: 'readonly', readOnly: true });
  const refusal = await readonly.command(command({ argv: [process.execPath, '-e', `try {require('node:fs').writeFileSync('NEW.txt','fail');process.exit(2)}catch(e){if(e.code!=='EROFS')throw e}`], cwd: f.project }));
  assert.equal((await refusal.completion).exitCode, 0); await readonly.dispose();
  const stubborn = await native.prepare({ ...request, jobId: 'stubborn' });
  // The dedicated fixture is copied into this disposable PRIVATE tree only.
  writeFileSync(join(stubborn.privateRepo, 'stubborn.mjs'), readFileSync(new URL('../src/__fixtures__/stubborn.mjs', import.meta.url)));
  const timed = await stubborn.command(command({ argv: [process.execPath, join(f.project, 'stubborn.mjs')], cwd: f.project, timeoutMs: 300 }));
  assert.equal((await timed.result).timedOut, true);
  await timed.completion; assert.equal((await timed.observe()).state, 'absent'); await stubborn.dispose();
});
