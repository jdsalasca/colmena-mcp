#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { buildServer } from './tools.js';

const config = getConfig();
const { server, jm } = buildServer(config);
await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await Promise.all(jm.list({}).filter(j => j.state === 'running' || j.state === 'queued').map(j => jm.cancel(j.id).catch(() => {})));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
