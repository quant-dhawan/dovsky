import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';

const [mode, provider = 'codex', verdict = 'approved'] = process.argv.slice(2);
readFileSync(0, 'utf8');
const emit = (value: unknown): void => writeFileSync(1, JSON.stringify(value) + '\n');
const message = (text: string): void => emit(provider === 'codex'
  ? { type: 'item.completed', item: { type: 'agent_message', text } } : { type: 'result', result: text });
if (mode === 'work') {
  writeFileSync('changed.txt', 'review runtime fixture\n');
  emit({ type: 'thread.started', thread_id: 'runtime-fixture-thread' });
  emit({ type: 'command_execution', command: 'fixture edit' });
  message('DOVSKY_RESULT: {"outcome":"completed","phase":"Done","blocker":null,"nextAction":null,"acknowledgedControls":[]}');
} else {
  const option = (name: string): string => {
    const index = process.argv.indexOf(name);
    assert.ok(index > 0, `missing ${name}`);
    return process.argv[index + 1]!;
  };
  const schema = provider === 'codex' ? JSON.parse(readFileSync(option('--output-schema'), 'utf8')) : JSON.parse(option('--json-schema'));
  assert.equal(schema.properties.verdict.enum.length, 3);
  if (provider === 'codex') assert.equal(process.argv.at(-1), '-');
  else assert.equal(option('--output-format'), 'json');
  const reasons = verdict === 'refuted' && mode !== 'empty' ? [
    { path: 'changed.txt', line: 2, defect: 'First defect', trigger: 'empty input' },
    { path: 'src/main.ts', line: 7, defect: 'Second defect', trigger: 'retry' },
  ] : [];
  const value = { verdict, reasons, confidence: 0.9, incomplete_evidence_ack: true };
  if (mode === 'crash') { writeFileSync(2, '503 temporarily unavailable'); process.exitCode = 1; }
  else if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'prose') message('1. Legacy defect\nVERDICT: REFUTED');
  else if (mode === 'last') writeFileSync(option('-o'), JSON.stringify(value));
  else if (mode === 'last-invalid') { message('VERDICT: APPROVED'); writeFileSync(option('-o'), 'invalid JSON'); }
  else if (mode === 'last-link') { message('VERDICT: APPROVED'); symlinkSync('/missing-review-target', option('-o')); }
  else if (mode === 'invalid') message('This is not a verdict');
  else if (provider === 'claude') emit({ type: 'result', result: '', structured_output: value });
  else message(JSON.stringify(value));
}
