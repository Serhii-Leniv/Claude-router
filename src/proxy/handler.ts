import type { Context } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import {
  classifyHeuristic,
  classifyAI,
  classifyHybrid,
} from '../classifier.js';
import {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  computeCostCents,
} from '../models.js';
import { shouldRetry, nextTier } from '../retry.js';
import type { ClassifyInput, ClassifyResult, Tier } from '../types.js';

export interface HandlerConfig {
  classifier: 'heuristic' | 'ai' | 'hybrid';
  defaultModel: string;
  verbose: boolean;
}

export interface RouteEvent {
  timestamp: string;
  tier: Tier | 'passthrough';
  model: string;
  costCents: number;
  savedCents: number;
  confidence: number;
  classifier: string;
  retried: boolean;
  retryReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

const MAX_HISTORY = 1000;
export const routeHistory: RouteEvent[] = [];

function recordEvent(event: RouteEvent): void {
  routeHistory.push(event);
  if (routeHistory.length > MAX_HISTORY) {
    routeHistory.shift();
  }
}

function buildClassifyInput(body: Record<string, unknown>): ClassifyInput {
  const messages = (body.messages ?? []) as Anthropic.MessageParam[];
  const system = body.system as string | Anthropic.TextBlockParam[] | undefined;

  let systemInput: ClassifyInput['system'];
  if (typeof system === 'string') {
    systemInput = system;
  } else if (Array.isArray(system)) {
    systemInput = system.filter(
      (b): b is Anthropic.TextBlockParam =>
        typeof b === 'object' && b !== null && 'type' in b && b.type === 'text',
    );
  }

  return { messages, system: systemInput };
}

async function classify(
  client: Anthropic,
  input: ClassifyInput,
  config: HandlerConfig,
): Promise<ClassifyResult> {
  switch (config.classifier) {
    case 'heuristic':
      return classifyHeuristic(input);
    case 'ai':
      return classifyAI(client, input, DEFAULT_MODELS.haiku);
    case 'hybrid':
      return classifyHybrid(client, input, DEFAULT_MODELS.haiku);
  }
}

function log(tier: Tier, model: string, classifyResult: ClassifyResult, costCents: number, savedCents: number, defaultModel: string, retried: boolean = false, retryReason: string | null = null): void {
  const saved =
    savedCents >= 0
      ? `saved: $${(savedCents / 100).toFixed(4)}`
      : `extra: $${(Math.abs(savedCents) / 100).toFixed(4)}`;

  const retryNote = retried ? ` [retried: ${retryReason}]` : '';

  console.log(
    `[claude-router] → ${tier} (${classifyResult.method}, ${classifyResult.ms}ms, conf:${classifyResult.confidence}${retryNote}) | cost: $${(costCents / 100).toFixed(4)} | ${saved} vs ${defaultModel}`,
  );
}

function setRouterHeaders(
  headers: Headers,
  tier: Tier,
  model: string,
  costCents: number,
  savedCents: number,
  classifyResult: ClassifyResult,
  retried: boolean = false,
  retryReason: string | null = null,
): void {
  headers.set('x-router-tier', tier);
  headers.set('x-router-model', model);
  headers.set('x-router-cost-cents', costCents.toFixed(3));
  headers.set('x-router-saved-cents', savedCents.toFixed(3));
  headers.set('x-router-classifier', classifyResult.method);
  headers.set('x-router-classifier-ms', classifyResult.ms.toString());
  headers.set('x-router-confidence', classifyResult.confidence.toString());
  if (retried) {
    headers.set('x-router-retried', 'true');
    headers.set('x-router-retry-reason', retryReason ?? '');
  }
}

export async function handleMessages(c: Context, config: HandlerConfig): Promise<Response> {
  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    return c.json({ error: { type: 'authentication_error', message: 'Missing x-api-key header' } }, 401);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const isStreaming = body.stream === true;
  const requestedModel = body.model as string | undefined;

  // Passthrough: explicit model that isn't "auto"
  if (requestedModel && requestedModel !== 'auto') {
    return proxyPassthrough(c, apiKey, body, isStreaming);
  }

  const client = new Anthropic({ apiKey });
  const input = buildClassifyInput(body);
  const classifyResult = await classify(client, input, config);

  const tier = classifyResult.tier;
  const model = DEFAULT_MODELS[tier];

  // Remove 'model' and 'stream' from body, we control them
  const { model: _m, stream: _s, ...apiParams } = body;

  if (isStreaming) {
    return handleStreaming(c, client, apiParams, tier, model, classifyResult, config);
  }

  return handleNonStreaming(c, client, apiParams, tier, model, classifyResult, config);
}

async function handleNonStreaming(
  c: Context,
  client: Anthropic,
  apiParams: Record<string, unknown>,
  tier: Tier,
  model: string,
  classifyResult: ClassifyResult,
  config: HandlerConfig,
): Promise<Response> {
  try {
    const response = await client.messages.create({
      ...apiParams,
      model,
    } as Anthropic.MessageCreateParamsNonStreaming);

    // Auto-retry on bad output
    const retryDecision = shouldRetry(response, tier);
    if (retryDecision.retry) {
      const escalatedTier = nextTier(tier);
      if (escalatedTier) {
        const escalatedModel = DEFAULT_MODELS[escalatedTier];
        const retryResponse = await client.messages.create({
          ...apiParams,
          model: escalatedModel,
        } as Anthropic.MessageCreateParamsNonStreaming);

        const costCents = computeCostCents(escalatedModel, retryResponse.usage.input_tokens, retryResponse.usage.output_tokens, DEFAULT_PRICING);
        const baselineCost = computeCostCents(config.defaultModel, retryResponse.usage.input_tokens, retryResponse.usage.output_tokens, DEFAULT_PRICING);
        const savedCents = Math.round((baselineCost - costCents) * 1000) / 1000;
        const roundedCost = Math.round(costCents * 1000) / 1000;

        if (config.verbose) {
          log(escalatedTier, escalatedModel, classifyResult, roundedCost, savedCents, config.defaultModel, true, retryDecision.reason);
        }

        recordEvent({
          timestamp: new Date().toISOString(),
          tier: escalatedTier,
          model: escalatedModel,
          costCents: roundedCost,
          savedCents,
          confidence: classifyResult.confidence,
          classifier: classifyResult.method,
          retried: true,
          retryReason: retryDecision.reason,
          inputTokens: retryResponse.usage.input_tokens,
          outputTokens: retryResponse.usage.output_tokens,
        });

        const headers = new Headers({ 'content-type': 'application/json' });
        setRouterHeaders(headers, escalatedTier, escalatedModel, roundedCost, savedCents, classifyResult, true, retryDecision.reason);

        return new Response(JSON.stringify(retryResponse), { status: 200, headers });
      }
    }

    const costCents = computeCostCents(model, response.usage.input_tokens, response.usage.output_tokens, DEFAULT_PRICING);
    const baselineCost = computeCostCents(config.defaultModel, response.usage.input_tokens, response.usage.output_tokens, DEFAULT_PRICING);
    const savedCents = Math.round((baselineCost - costCents) * 1000) / 1000;
    const roundedCost = Math.round(costCents * 1000) / 1000;

    if (config.verbose) {
      log(tier, model, classifyResult, roundedCost, savedCents, config.defaultModel);
    }

    recordEvent({
      timestamp: new Date().toISOString(),
      tier,
      model,
      costCents: roundedCost,
      savedCents,
      confidence: classifyResult.confidence,
      classifier: classifyResult.method,
      retried: false,
      retryReason: null,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    const headers = new Headers({ 'content-type': 'application/json' });
    setRouterHeaders(headers, tier, model, roundedCost, savedCents, classifyResult);

    return new Response(JSON.stringify(response), { status: 200, headers });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return c.json({ error: { type: 'api_error', message: err.message } }, err.status as 400);
    }
    throw err;
  }
}

async function handleStreaming(
  c: Context,
  client: Anthropic,
  apiParams: Record<string, unknown>,
  tier: Tier,
  model: string,
  classifyResult: ClassifyResult,
  config: HandlerConfig,
): Promise<Response> {
  const stream = client.messages.stream({
    ...apiParams,
    model,
  } as Anthropic.MessageStreamParams);

  const headers = new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-router-tier': tier,
    'x-router-model': model,
    'x-router-classifier': classifyResult.method,
    'x-router-classifier-ms': classifyResult.ms.toString(),
    'x-router-confidence': classifyResult.confidence.toString(),
  });

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          const data = `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }

        const finalMessage = await stream.finalMessage();
        const costCents = computeCostCents(model, finalMessage.usage.input_tokens, finalMessage.usage.output_tokens, DEFAULT_PRICING);
        const baselineCost = computeCostCents(config.defaultModel, finalMessage.usage.input_tokens, finalMessage.usage.output_tokens, DEFAULT_PRICING);
        const savedCents = Math.round((baselineCost - costCents) * 1000) / 1000;

        if (config.verbose) {
          log(tier, model, classifyResult, Math.round(costCents * 1000) / 1000, savedCents, config.defaultModel);
        }

        recordEvent({
          timestamp: new Date().toISOString(),
          tier,
          model,
          costCents: Math.round(costCents * 1000) / 1000,
          savedCents,
          confidence: classifyResult.confidence,
          classifier: classifyResult.method,
          retried: false,
          retryReason: null,
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        });

        controller.close();
      } catch (err) {
        const errorData = `event: error\ndata: ${JSON.stringify({ error: { message: String(err) } })}\n\n`;
        controller.enqueue(encoder.encode(errorData));
        controller.close();
      }
    },
  });

  return new Response(readable, { status: 200, headers });
}

async function proxyPassthrough(
  c: Context,
  apiKey: string,
  body: Record<string, unknown>,
  isStreaming: boolean,
): Promise<Response> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const headers = new Headers();
  response.headers.forEach((value, key) => headers.set(key, value));
  headers.set('x-router-tier', 'passthrough');

  if (isStreaming && response.body) {
    return new Response(response.body, { status: response.status, headers });
  }

  const text = await response.text();
  return new Response(text, { status: response.status, headers });
}
