import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [mode, policy = 'prune'] = process.argv.slice(2);
const emit = (text: string): void => writeFileSync(1, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
if (mode === 'gate') {
  if (existsSync('repair.txt') && (policy === 'all-pruned' || policy === 'prune' && readFileSync('repair.txt', 'utf8').trim() !== '2')) process.exitCode = 1;
} else {
  const prompt = readFileSync(0, 'utf8');
  if (mode === 'review') {
    const rollout = prompt.includes('ROLLOUT REVIEW');
    if (rollout && policy === 'review-crash') { writeFileSync(2, '503 temporarily unavailable'); process.exit(1); }
    const verdict = rollout && policy !== 'refute' ? 'approved' : 'refuted';
    emit(JSON.stringify({ verdict, reasons: verdict === 'refuted' ? [{ path: 'initial.txt', line: 1, defect: 'Repair the initial change', trigger: 'fixture' }] : [], confidence: 0.9, incomplete_evidence_ack: true }));
  } else {
    const index = /ROLLOUT CORRECTION (\d+)/.exec(prompt)?.[1];
    if (index !== undefined) {
      writeFileSync('repair.txt', index + '\n');
      await new Promise(resolve => setTimeout(resolve, policy === 'hold' ? 30_000 : 250));
    } else writeFileSync('initial.txt', 'original worker change\n');
    writeFileSync(1, JSON.stringify({ type: 'thread.started', thread_id: `rollout-${process.env.DOVSKY_JOB_ID}` }) + '\n');
    writeFileSync(1, JSON.stringify({ type: 'command_execution', command: 'fixture edit' }) + '\n');
    emit('DOVSKY_RESULT: {"outcome":"completed","phase":"Done","blocker":null,"nextAction":null,"acknowledgedControls":[]}');
  }
}
