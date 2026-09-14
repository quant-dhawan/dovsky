import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
const mode = process.argv[2] ?? 'stop';
const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
const quota = (rateLimitType: string, utilization?: number): void => emit({ type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed_warning', rateLimitType, utilization,
    resetsAt: Math.floor(Date.now() / 1000) + 3600 }, uuid: 'fixture', session_id: 'fixture' });
quota('five_hour', mode === 'zero' ? 0 : mode === 'incomplete' ? undefined : 0.95);
quota('seven_day', mode === 'zero' ? 0 : mode === 'incomplete' ? undefined : 0.2);
quota('five_hour'); // An incomplete later event must not erase measured usage.
emit({ type: 'result', result: 'Measured quota fixture complete', usage: { input_tokens: 1, output_tokens: 1 } });
