#!/usr/bin/env node

import { serve } from '@hono/node-server';
import { createProxyApp } from './server.js';
import { createProviderClient, type Provider } from './handler.js';
import { DEFAULT_MODELS, BEDROCK_MODELS, VERTEX_MODELS } from '../models.js';
import type { Tier } from '../types.js';

function parseArgs(args: string[]): {
  port: number;
  verbose: boolean;
  classifier: 'heuristic' | 'ai' | 'hybrid';
  provider: Provider;
  region: string;
} {
  let port = 4000;
  let verbose = false;
  let classifier: 'heuristic' | 'ai' | 'hybrid' = 'hybrid';
  let provider: Provider = 'anthropic';
  let region = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`Invalid port: ${args[i + 1]}. Must be 1-65535.`);
        process.exit(1);
      }
      port = parsed;
      i++;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--classifier' && args[i + 1]) {
      const val = args[i + 1]!;
      if (val === 'heuristic' || val === 'ai' || val === 'hybrid') {
        classifier = val;
      }
      i++;
    } else if (arg === '--provider' && args[i + 1]) {
      const val = args[i + 1]!;
      if (val === 'anthropic' || val === 'bedrock' || val === 'vertex') {
        provider = val;
      } else {
        console.error(`Invalid provider: ${val}. Must be anthropic | bedrock | vertex.`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--region' && args[i + 1]) {
      region = args[i + 1]!;
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
  --provider <mode>         anthropic | bedrock | vertex (default: anthropic)
  --region <string>         AWS/GCP region (default: us-east-1 / us-east5)
  --help, -h                Show this help

Examples:
  # Direct Anthropic API key (default)
  claude-router --port 4000 --verbose
  ANTHROPIC_BASE_URL=http://localhost:4000 <your app>

  # AWS Bedrock
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \\
    claude-router --provider bedrock --port 4000
  ANTHROPIC_BASE_URL=http://localhost:4000 <your app>   # no x-api-key needed

  # Google Vertex AI
  ANTHROPIC_VERTEX_PROJECT_ID=my-project \\
    claude-router --provider vertex --port 4000
  ANTHROPIC_BASE_URL=http://localhost:4000 <your app>   # no x-api-key needed

  # Claude Code (direct API key — no code changes needed)
  ANTHROPIC_BASE_URL=http://localhost:4000 claude
`);
      process.exit(0);
    }
  }

  // Apply region to env vars if not already set
  if (region) {
    if (provider === 'bedrock' && !process.env['AWS_REGION']) {
      process.env['AWS_REGION'] = region;
    } else if (provider === 'vertex' && !process.env['ANTHROPIC_VERTEX_REGION']) {
      process.env['ANTHROPIC_VERTEX_REGION'] = region;
    }
  }

  return { port, verbose, classifier, provider, region };
}

function modelsForProvider(provider: Provider): Record<Tier, string> {
  if (provider === 'bedrock') return BEDROCK_MODELS;
  if (provider === 'vertex') return VERTEX_MODELS;
  return DEFAULT_MODELS;
}

async function main() {
  const { port, verbose, classifier, provider, region } = parseArgs(process.argv.slice(2));
  const models = modelsForProvider(provider);

  let providerClient;
  try {
    providerClient = await createProviderClient(provider);
  } catch (err) {
    console.error(`\n[claude-router] Provider init failed:\n${String(err)}\n`);
    process.exit(1);
  }

  const app = createProxyApp({
    classifier,
    defaultModel: models.sonnet,
    verbose,
    provider,
    models,
  }, providerClient);

  const regionDisplay = region || (provider === 'bedrock' ? process.env['AWS_REGION'] ?? 'us-east-1' : provider === 'vertex' ? process.env['ANTHROPIC_VERTEX_REGION'] ?? 'us-east5' : '');

  console.log(`
┌──────────────────────────────────────────────┐
│  claude-router proxy                         │
├──────────────────────────────────────────────┤
│  URL:        http://localhost:${String(port).padEnd(5)}          │
│  Provider:   ${provider.padEnd(32)}│
│  Classifier: ${classifier.padEnd(32)}│
│  Verbose:    ${String(verbose).padEnd(32)}│${regionDisplay ? `\n│  Region:     ${regionDisplay.padEnd(32)}│` : ''}
├──────────────────────────────────────────────┤
│  Set ANTHROPIC_BASE_URL=http://localhost:${String(port).padEnd(5)}│
│  All requests auto-routed to optimal tier    │
└──────────────────────────────────────────────┘
`);

  // Catch async credential errors (e.g. Vertex lazy auth)
  process.on('unhandledRejection', (err) => {
    console.error(`\n[claude-router] Fatal error:\n${String(err)}`);
    if (provider === 'vertex') {
      console.error('\nVertex auth failed. Run: gcloud auth application-default login');
    } else if (provider === 'bedrock') {
      console.error('\nBedrock auth failed. Check: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
    }
    process.exit(1);
  });

  serve({ fetch: app.fetch, port });
}

main();
