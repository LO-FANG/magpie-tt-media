import { createServer } from 'node:http';
import { MediaStore, handle } from './src/media.mjs';
let server;
export async function TTMediaPlugin(_input, options = {}) {
  if (!server) {
    const store = new MediaStore(options.codexHome, options.claudeHome);
    server = createServer((req, res) => handle(store, req, res));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(options.port ?? 43821), '127.0.0.1', resolve);
    });
    server.unref();
  }
  return {};
}
