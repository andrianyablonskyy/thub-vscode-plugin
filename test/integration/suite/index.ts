import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))){
    mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
}
