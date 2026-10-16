import * as assert from 'node:assert/strict';
import { JpegSplitter, ffmpegMjpegArgs } from '../../src/video/jpeg';
import { freeBlock } from '../../src/util/ports';

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, n, 0xff, 0xd9]);

suite('video and ports', () => {
  test('JPEG frames out of ffmpeg\'s byte stream, split anywhere', () => {
    const s = new JpegSplitter(),
      all = Buffer.concat([Buffer.from([1, 2]), jpeg(1), jpeg(2), jpeg(3)]);
    const got = [...s.push(all.subarray(0, 5)), ...s.push(all.subarray(5, 11)), ...s.push(all.subarray(11))];
    assert.deepEqual(got.map((f) => f[2]), [1, 2, 3]);
    assert.deepEqual(s.push(Buffer.from([9, 9])), []);
  });

  test('ffmpeg: low-latency JPEG frames from the stream URL', () => {
    const args = ffmpegMjpegArgs('http://127.0.0.1:8090/rsv_1/video.ts', 10);
    assert.equal(args[args.indexOf('-i') + 1], 'http://127.0.0.1:8090/rsv_1/video.ts');
    assert.deepEqual(args.slice(-3), ['-f', 'image2pipe', '-']);
  });

  test('a block of free local ports, past taken ones', async () => {
    const taken = new Set([5001, 5006]);
    assert.equal(await freeBlock(5001, 4, 10, async (p) => !taken.has(p)), 5009);
    assert.equal(await freeBlock(3333, 2, 10, async () => true), 3333);
    await assert.rejects(freeBlock(5001, 4, 2, async () => false), /No 4 free local ports/);
  });
});
