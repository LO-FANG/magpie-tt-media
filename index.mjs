import { createServer } from 'node:http';
import { MediaStore, handle } from './src/media.mjs';
let server;
export async function TTMediaPlugin(_input, options = {}) {
  if (!server) {
    const store = new MediaStore(options.codexHome, options.claudeHome);
    server = createServer((req, res) => handle(store, req, res));
    const port = Number(options.port ?? 43821);
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const onError = error => { server.removeListener('listening', onListening); reject(error); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '127.0.0.1');
        });
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    server.unref();
  }
  return {};
}
