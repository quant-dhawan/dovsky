import { spawn } from 'node:child_process';

process.on('SIGTERM', () => undefined);
if (!process.argv.includes('--child')) {
  spawn(process.execPath, [new URL(import.meta.url).pathname, '--child'], { stdio: 'inherit' });
}
process.stdout.write(`STUBBORN_READY ${process.pid}\n`);
setInterval(() => undefined, 1000);
