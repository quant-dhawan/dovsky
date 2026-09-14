import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { BubblewrapIsolation } from '../sandbox.js';
import { SystemdScopeExecutor } from '../execution-scope.js';
import { treeFixture } from './s1-sandbox.js';

/** Native diagnostics run before Git/socket fixtures; no provider or authentication calls. */
export async function homeHostFixture(t: TestContext, executor = new SystemdScopeExecutor()) {
  const diagnostic = new BubblewrapIsolation({ sandboxRoot: '/tmp/dovsky-s1-home-diagnostic-unused', hiddenPaths: [], executor });
  const availability = await diagnostic.available();
  if (!availability.available) {
    const reason = `Native S1 home/dependency sandbox unavailable: ${availability.reason}; fixture coverage is not host verification`;
    if (process.env.DOVSKY_REQUIRE_SANDBOX === '1') assert.fail(reason);
    t.skip(reason); return null;
  }
  const f = treeFixture(t);
  const server = createServer(client => client.end('S1_HOME_READY'));
  const socket = join(f.admin, 'job.sock');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const isolation = new BubblewrapIsolation({ sandboxRoot: f.sandboxRoot, hiddenPaths: [f.admin], operatorHome: f.home, executor });
  return { ...f, socket, isolation };
}
