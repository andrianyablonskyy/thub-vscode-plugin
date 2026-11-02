import { StringDecoder } from 'node:string_decoder';

export class RttDecoder {
  private decoder = new StringDecoder('utf8');

  write(bytes: Buffer): string {
    return this.decoder.write(bytes);
  }

  end(): string {
    const tail = this.decoder.end();
    this.decoder = new StringDecoder('utf8');
    return tail;
  }
}
