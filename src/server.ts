import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { isDevelopmentMode } from './server-mode';

// Increase max listeners to prevent warning during hot reload
process.setMaxListeners(20);

const dev = isDevelopmentMode();
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5000', 10);

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url?.split('?')[0], err instanceof Error ? err.name : 'Error');
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', () => {
    console.error('HTTP server failed to listen.');
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : 'production'
      }`,
    );
  });
});
