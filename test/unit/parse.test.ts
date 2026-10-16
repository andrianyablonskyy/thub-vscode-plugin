import * as assert from 'node:assert/strict';
import { boardState, errorMessage, exitKind, formatLeft, labelsSummary, mask, parseConnectLine, parseDurationMin, parseJsonOutput } from '../../src/cli/parse';
import type { Resource } from '../../src/cli/types';

const board = (over: Partial<Resource> = {}): Resource => ({
  id: 'res_1', name: 'lab-hw-01', type: 'hw', status: 'IDLE', busySource: null, labels: [], lastHeartbeatAt: null, reservation: null, ...over
});
const later = new Date(Date.now() + 3600_000).toISOString(),
  earlier = new Date(Date.now() - 1000).toISOString();

suite('parse', () => {
  test('the JSON a --json command printed: its last JSON line', () => {
    assert.deepEqual(parseJsonOutput('noise\n{"a":1}\n'), { a: 1 });
    assert.deepEqual(parseJsonOutput('[{"name":"x"}]'), [{ name: 'x' }]);
    assert.throws(() => parseJsonOutput('Error: nope'), /printed no JSON/);
  });

  test('thub connect --json: NDJSON events, and an older thub\'s single ready object', () => {
    const ready = { client: 'lab-hw-01', link: 'wss://x/api/v1/remote/rsv_1', until: later, ports: [{ kind: 'uart', index: 1, label: 'dut1-uart', host: '127.0.0.1', port: 5001 }], video: null };
    assert.equal(parseConnectLine(JSON.stringify(ready))?.event, 'ready');
    assert.deepEqual(parseConnectLine('{"event":"disconnected","retryMs":2000,"reason":null}'), { event: 'disconnected', retryMs: 2000, reason: null });
    assert.deepEqual(parseConnectLine('{"event":"video","streaming":false,"error":"ffmpeg isn\'t installed"}'),
      { event: 'video', streaming: false, error: 'ffmpeg isn\'t installed' });
    assert.equal(parseConnectLine('Connected to lab-hw-01'), null);
    assert.equal(parseConnectLine('{"nope":1}'), null);
    assert.equal(parseConnectLine('{broken'), null);
  });

  test('durations in whole minutes', () => {
    assert.equal(parseDurationMin('30m'), 30);
    assert.equal(parseDurationMin('2h'), 120);
    assert.equal(parseDurationMin(' 90 '), 90);
    assert.equal(parseDurationMin('1d'), 1440);
    assert.equal(parseDurationMin('0m'), null);
    assert.equal(parseDurationMin('2.5h'), null);
    assert.equal(parseDurationMin('soon'), null);
  });

  test('time left as the design shows it', () => {
    assert.equal(formatLeft(102 * 60_000), '1h 42m');
    assert.equal(formatLeft(60 * 60_000), '1h 00m');
    assert.equal(formatLeft(7 * 60_000 + 59_000), '7m');
    assert.equal(formatLeft(30_000), '<1m');
  });

  test('board states: mine (a link), someone else\'s, a job, offline, maintenance, idle; an expired reservation is none', () => {
    assert.equal(boardState(board({ reservation: { by: 'me', since: earlier, until: later, id: 'rsv_1', link: 'wss://x' } })), 'mine');
    assert.equal(boardState(board({ reservation: { by: 'oleksandr', since: earlier, until: later } })), 'reserved');
    assert.equal(boardState(board({ reservation: { by: 'oleksandr', since: earlier, until: earlier } })), 'idle');
    assert.equal(boardState(board({ status: 'BUSY' })), 'job');
    assert.equal(boardState(board({ status: 'OUT_OF_SERVICE' })), 'offline');
    assert.equal(boardState(board({ status: 'MAINTENANCE' })), 'maintenance');
    assert.equal(boardState(board()), 'idle');
  });

  test('labels: the board model first, a camera as "camera"', () => {
    assert.equal(labelsSummary(board({ labels: ['uart', 'video-stream', 'board:nucleo-f401re'] })), 'nucleo-f401re · camera · uart');
  });

  test('exit codes: 4 is the one that offers Sign in', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 130, 9].map(exitKind), ['ok', 'failed', 'infra', 'canceled', 'auth', 'running', 'detached', 'unknown']);
    assert.equal(errorMessage('warn\nError: Invalid or revoked access key\n', 'x'), 'Invalid or revoked access key');
    assert.equal(errorMessage('', 'fallback'), 'fallback');
  });

  test('the key never shows in full', () => {
    assert.equal(mask('key=thk_abcdef123 and again thk_abcdef123', 'thk_abcdef123'), 'key=thk_… and again thk_…');
    assert.equal(mask('nothing', undefined), 'nothing');
  });
});
