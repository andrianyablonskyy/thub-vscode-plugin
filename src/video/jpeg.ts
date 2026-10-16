// Splits ffmpeg's image2pipe MJPEG output into whole JPEG frames (no VS Code
// dependency): each frame starts with FF D8 and ends with FF D9.

export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);

  /** Feeds a chunk; returns the frames it completed (the newest last). */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;){
      const start = this.buf.indexOf(SOI);
      if (start < 0){
        this.buf = Buffer.alloc(0);
        break;
      }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0){
        this.buf = this.buf.subarray(start);
        // A frame never ends: don't grow without bound.
        if (this.buf.length > MAX_FRAME){
          this.buf = Buffer.alloc(0);
        }
        break;
      }
      frames.push(this.buf.subarray(start, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
    return frames;
  }
}

const SOI = Buffer.from([0xff, 0xd8]),
  EOI = Buffer.from([0xff, 0xd9]),
  MAX_FRAME = 8 * 1024 * 1024;

/** ffmpeg: the MPEG-TS stream at `url` as JPEG frames on stdout. */
export function ffmpegMjpegArgs(url: string, fps = 10): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', url,
    '-vf', `fps=${fps},scale='min(1280,iw)':-2`,
    '-c:v', 'mjpeg', '-q:v', '5',
    '-f', 'image2pipe', '-'
  ];
}
