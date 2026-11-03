import * as assert from 'node:assert/strict';
import { parseRttError } from '../../src/session/rttErrors';

suite('RTT connection errors', () => {
  test('extracts OpenOCD failures with their target and probe index', () => {
    assert.deepEqual(parseRttError('RTT 1: OpenOCD exited (1): Error: init mode failed (unable to connect to the target)'), {
      index: 1,
      message: 'OpenOCD exited (1): Error: init mode failed (unable to connect to the target)'
    });
    assert.deepEqual(parseRttError('RTT 2: no OpenOCD target for ST-Link 2'), {
      index: 2,
      message: 'no OpenOCD target for ST-Link 2'
    });
  });

  test('does not classify normal RTT status notes as terminal failures', () => {
    assert.equal(parseRttError('RTT 1: starting OpenOCD: target/stm32g4x.cfg on ST-Link 1'), undefined);
    assert.equal(parseRttError('RTT 1: output stream ready'), undefined);
  });
});
