// Free local ports for `thub connect` (no VS Code dependency).

import * as net from 'node:net';

export function isFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/**
 * The first `size` consecutive free ports from `base` on (stepping by
 * `size`): UART n and ST-Link n are base + n − 1, so a block is needed.
 */
export async function freeBlock(base: number, size = 4, tries = 50, free = isFree): Promise<number> {
  for (let start = base, i = 0; i < tries && start + size <= 65535; i++, start += size){
    const all = await Promise.all(Array.from({ length: size }, (_, k) => free(start + k)));
    if (all.every(Boolean)){
      return start;
    }
  }
  throw new Error(`No ${size} free local ports from ${base} on`);
}
