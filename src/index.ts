import Anthropic from '@anthropic-ai/sdk';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.js';
import {
  classify,
  DEFAULT_CLASSIFY_CACHE_SIZE,
} from './classifier.js';
import { LruCache } from './cache.js';
import {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  computeRouteCost,
} from './models.js';
import { CostTracker } from './tracker.js';
import { executeRoute } from './route.js';
import { normalizeParamsForTier } from './params.js';
import type {
  ClassifyInput,
  ClassifyResult,
  ModelPricing,
  RoutedMessage,
  RouteMeta,
  RouterConfig,
  RouterStats,
  RoutingTuning,
  Tier,
} from './types.js';

interface ResolvedConfig {
  apiKey: string;
  defaultModel: string;
  classifier: 'heuristic' | 'ai' | 'hybrid';
  tiers: Record<Tier, string>;
  pricing: Record<string, ModelPricing>;
  fallback: boolean;
  verbose: boolean;
  routing: RoutingTuning;
}

export interface StreamResult {
  stream: MessageStream;
  meta: Promise<RouteMeta>;
}

type SendParams = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> & {
  tier?: Tier;
};

type StreamParams = Omit<
  Anthropic.MessageStreamParams,
  'model'
> & {
  tier?: Tier;
};

function resolveConfig(config: RouterConfig): ResolvedConfig {
  const tiers: Record<Tier, string> = {
    haiku: config.tiers?.haiku ?? DEFAULT_MODELS.haiku,
    sonnet: config.tiers?.sonnet ?? DEFAULT_MODELS.sonnet,
    opus: config.tiers?.opus ?? DEFAULT_MODELS.opus,
  };

  return {
    apiKey: config.apiKey,
    defaultModel: config.defaultModel ?? tiers.sonnet,
    classifier: config.classifier ?? 'hybrid',
    tiers,
    pricing: { ...DEFAULT_PRICING, ...config.pricing },
    fallback: config.fallback ?? true,
    verbose: config.verbose ?? false,
    routing: config.routing ?? {},
  };
}

function buildClassifyInput(
  params: SendParams | StreamParams,
): ClassifyInput {
  const system = params.system;
  let systemInput: ClassifyInput['system'];
  if (typeof system === 'string') {
    systemInput = system;
  } else if (Array.isArray(system)) {
    systemInput = system.filter(
      (b): b is Anthropic.TextBlockParam =>
        'type' in b && b.type === 'text',
    );
  }

  return {
    messages: params.messages,
    system: systemInput,
    tools: (params as { tools?: unknown[] }).tools,
  };
}

export class ClaudeRouter {
  /** @internal Exposed for testing — do not depend on this. */
  _client: Anthropic;
  private config: ResolvedConfig;
  private tracker: CostTracker;
  private classifyCache: LruCache<string, ClassifyResult>;

  constructor(config: RouterConfig) {
    this.config = resolveConfig(config);
    this._client = new Anthropic({ apiKey: this.config.apiKey });
    this.tracker = new CostTracker();
    this.classifyCache = new LruCache(
      this.config.routing.classifyCacheSize ?? DEFAULT_CLASSIFY_CACHE_SIZE,
    );
  }

  private async classify(input: ClassifyInput): Promise<ClassifyResult> {
    return classify(
      this._client,
      input,
      this.config.classifier,
      this.config.tiers.haiku,
      { ...this.config.routing, cache: this.classifyCache },
    );
  }

  private buildMeta(
    tier: Tier,
    model: string,
    usage: Anthropic.Usage,
    classifyResult: ClassifyResult,
    fallbackUsed: boolean,
    retried: boolean = false,
    retryReason: string | null = null,
  ): RouteMeta {
    const { costCents, savedCents, cacheReadTokens, cacheCreationTokens } =
      computeRouteCost(model, usage, this.config.defaultModel, this.config.pricing);

    return {
      tier,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens,
      cacheCreationTokens,
      costCents,
      savedCents,
      classifierMethod: classifyResult.method,
      classifierMs: classifyResult.ms,
      fallbackUsed,
      confidence: classifyResult.confidence,
      retried,
      retryReason,
    };
  }

  private log(meta: RouteMeta, classifyResult: ClassifyResult): void {
    if (!this.config.verbose) return;

    const fallbackNote = meta.fallbackUsed
      ? `, fallback from ${classifyResult.tier}`
      : '';
    const saved =
      meta.savedCents >= 0
        ? `saved: $${(meta.savedCents / 100).toFixed(4)}`
        : `extra: $${(Math.abs(meta.savedCents) / 100).toFixed(4)}`;

    console.log(
      `[claude-router] → ${meta.tier} (${meta.classifierMethod}, ${meta.classifierMs}ms${fallbackNote}) | cost: $${(meta.costCents / 100).toFixed(4)} | ${saved} vs ${this.config.defaultModel}`,
    );
  }

  async send(params: SendParams): Promise<RoutedMessage> {
    const { tier: forcedTier, ...apiParams } = params;
    const input = buildClassifyInput(params);

    const classifyResult = forcedTier
      ? { tier: forcedTier, score: -1, method: 'heuristic' as const, ms: 0, confidence: 1.0 }
      : await this.classify(input);

    const result = await executeRoute(
      this._client,
      apiParams as Record<string, unknown>,
      classifyResult.tier,
      this.config.tiers,
      { fallbackOnRateLimit: this.config.fallback },
    );

    const meta = this.buildMeta(
      result.tier,
      result.model,
      result.response.usage,
      classifyResult,
      result.fallbackUsed,
      result.retried,
      result.retryReason,
    );

    this.tracker.record(meta);
    this.log(meta, classifyResult);

    const routed = result.response as RoutedMessage;
    routed.meta = meta;
    return routed;
  }

  stream(params: StreamParams): StreamResult {
    const { tier: forcedTier, ...apiParams } = params;
    const input = buildClassifyInput(params);

    const classifyPromise = forcedTier
      ? Promise.resolve({
          tier: forcedTier,
          score: -1,
          method: 'heuristic' as const,
          ms: 0,
          confidence: 1.0,
        })
      : this.classify(input);

    // We need to classify first, then start stream
    let resolveStream: (s: MessageStream) => void;
    let rejectStream: (e: unknown) => void;

    const streamReady = new Promise<MessageStream>((res, rej) => {
      resolveStream = res;
      rejectStream = rej;
    });

    const metaPromise = classifyPromise
      .then(async (classifyResult) => {
        const tier = classifyResult.tier;
        const model = this.config.tiers[tier];

        const s = this._client.messages.stream(
          normalizeParamsForTier({ ...apiParams, model }, tier),
        );

        resolveStream!(s);

        const finalMessage = await s.finalMessage();
        const meta = this.buildMeta(
          tier,
          model,
          finalMessage.usage,
          classifyResult,
          false,
        );

        this.tracker.record(meta);
        this.log(meta, classifyResult);
        return meta;
      })
      .catch((err) => {
        rejectStream!(err);
        throw err;
      });

    // Return a proxy that waits for classification to complete
    const streamProxy = new Proxy({} as MessageStream, {
      get(_target, prop) {
        if (prop === 'then') return undefined; // Not a thenable
        return (...args: unknown[]) => {
          return streamReady.then((s) => {
            const val = (s as unknown as Record<string | symbol, unknown>)[prop];
            if (typeof val === 'function') {
              return (val as Function).apply(s, args);
            }
            return val;
          });
        };
      },
    });

    return {
      stream: streamProxy,
      meta: metaPromise,
    };
  }

  stats(): RouterStats {
    return this.tracker.stats();
  }

  reset(): void {
    this.tracker.reset();
  }
}

export function createRouter(config: RouterConfig): ClaudeRouter {
  return new ClaudeRouter(config);
}

// Re-export types
export type {
  Tier,
  ModelPricing,
  RouterConfig,
  RouteMeta,
  RoutedMessage,
  RouterStats,
  RoutingTuning,
  ClassifyInput,
  ClassifyResult,
} from './types.js';

export {
  heuristicScore,
  heuristicScoreDetailed,
  scoreToTier,
  scoreToConfidence,
  classifyHeuristic,
  classify,
  HEURISTIC_WEIGHTS,
} from './classifier.js';
export { shouldRetry, nextTier } from './retry.js';
export { normalizeParamsForTier } from './params.js';
export {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  FAMILY_PRICING,
  computeCostCents,
  priceForModel,
  familyForModel,
} from './models.js';
export { CostTracker } from './tracker.js';
