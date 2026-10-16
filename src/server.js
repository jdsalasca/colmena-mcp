#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { buildServer } from './tools.js';

const config = getConfig();
const { server, jm, notify } = buildServer(config);
await server.connect(new StdioServerTransport());

let shutdownPromise;
const shutdown = () => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (config.settings.defaults.cancel_jobs_on_shutdown) {
      await Promise.all(jm.list({}).filter(j => j.state === 'running' || j.state === 'queued').map(j => jm.cancel(j.id).catch(() => {})));
    }
    notify.stop();
    jm.shutdown();
    process.exit(0);
  })();
  return shutdownPromise;
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
