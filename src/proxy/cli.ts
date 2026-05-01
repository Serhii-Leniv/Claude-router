#!/usr/bin/env node

import { serve } from '@hono/node-server';
import { createProxyApp } from './server.js';
import { DEFAULT_MODELS } from '../models.js';

function parseArgs(args: string[]): { port: number; verbose: boolean; classifier: 'heuristic' | 'ai' | 'hybrid' } {
  let port = 4000;
  let verbose = false;
  let classifier: 'heuristic' | 'ai' | 'hybrid' = 'hybrid';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--classifier' && args[i + 1]) {
      const val = args[i + 1]!;
      if (val === 'heuristic' || val === 'ai' || val === 'hybrid') {
        classifier = val;
      }
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
claude-router proxy — auto-route Claude API calls by complexity

Usage:
  claude-router [options]

Options:
  --port, -p <number>      Port to listen on (default: 4000)
  --verbose, -v             Log routing decisions to console
  --classifier <mode>       heuristic | ai | hybrid (default: hybrid)
  --help, -h                Show this help

Example:
  claude-router --port 4000 --verbose

Then set:
  ANTHROPIC_BASE_URL=http://localhost:4000
`);
      process.exit(0);
    }
  }

  return { port, verbose, classifier };
}

const { port, verbose, classifier } = parseArgs(process.argv.slice(2));

const app = createProxyApp({
  classifier,
  defaultModel: DEFAULT_MODELS.sonnet,
  verbose,
});

console.log(`
┌──────────────────────────────────────────────┐
│  claude-router proxy                         │
├──────────────────────────────────────────────┤
│  URL:        http://localhost:${String(port).padEnd(5)}          │
│  Classifier: ${classifier.padEnd(32)}│
│  Verbose:    ${String(verbose).padEnd(32)}│
├──────────────────────────────────────────────┤
│  Set ANTHROPIC_BASE_URL=http://localhost:${String(port).padEnd(5)}│
│  All requests auto-routed to optimal tier    │
└──────────────────────────────────────────────┘
`);

serve({ fetch: app.fetch, port });
