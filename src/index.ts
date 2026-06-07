import Anthropic from '@anthropic-ai/sdk';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.js';
import {
  classifyHeuristic,
  classifyAI,
  classifyHybrid,
} from './classifier.js';
import {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  TIER_ORDER,
  computeCostCents,
} from './models.js';
import { CostTracker } from './tracker.js';
import { shouldRetry, nextTier } from './retry.js';
import type {
  ClassifyInput,
  ClassifyResult,
  ModelPricing,
  RoutedMessage,
  RouteMeta,
  RouterConfig,
  RouterStats,
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

  return { messages: params.messages, system: systemInput };
}

export class ClaudeRouter {
  /** @internal Exposed for testing — do not depend on this. */
  _client: Anthropic;
  private config: ResolvedConfig;
  private tracker: CostTracker;

  constructor(config: RouterConfig) {
    this.config = resolveConfig(config);
    this._client = new Anthropic({ apiKey: this.config.apiKey });
    this.tracker = new CostTracker();
  }

  private async classify(input: ClassifyInput): Promise<ClassifyResult> {
    switch (this.config.classifier) {
      case 'heuristic':
        return classifyHeuristic(input);
      case 'ai':
        return classifyAI(this._client, input, this.config.tiers.haiku);
      case 'hybrid':
        return classifyHybrid(this._client, input, this.config.tiers.haiku);
    }
  }

  private buildMeta(
    tier: Tier,
    model: string,
    inputTokens: number,
    outputTokens: number,
    classifyResult: ClassifyResult,
    fallbackUsed: boolean,
    retried: boolean = false,
    retryReason: string | null = null,
  ): RouteMeta {
    const costCents = computeCostCents(
      model,
      inputTokens,
      outputTokens,
      this.config.pricing,
    );
    const baselineCost = computeCostCents(
      this.config.defaultModel,
      inputTokens,
      outputTokens,
      this.config.pricing,
    );

    return {
      tier,
      model,
      inputTokens,
      outputTokens,
      costCents: Math.round(costCents * 1000) / 1000,
      savedCents: Math.round((baselineCost - costCents) * 1000) / 1000,
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

    const startIndex = TIER_ORDER.indexOf(classifyResult.tier);
    let lastError: unknown;

    for (let i = startIndex; i < TIER_ORDER.length; i++) {
      const tier = TIER_ORDER[i]!;
      const model = this.config.tiers[tier];
      const fallbackUsed = i !== startIndex;

      try {
        const response = await this._client.messages.create({
          ...apiParams,
          model,
        });

        // Auto-retry on bad output (truncation/refusal)
        const retryDecision = shouldRetry(response, tier);
        if (retryDecision.retry && !fallbackUsed) {
          const escalatedTier = nextTier(tier);
          if (escalatedTier) {
            const escalatedModel = this.config.tiers[escalatedTier];
            const retryResponse = await this._client.messages.create({
              ...apiParams,
              model: escalatedModel,
            });

            const meta = this.buildMeta(
              escalatedTier,
              escalatedModel,
              retryResponse.usage.input_tokens,
              retryResponse.usage.output_tokens,
              classifyResult,
              true,
              true,
              retryDecision.reason,
            );

            this.tracker.record(meta);
            this.log(meta, classifyResult);

            const routed = retryResponse as RoutedMessage;
            routed.meta = meta;
            return routed;
          }
        }

        const meta = this.buildMeta(
          tier,
          model,
          response.usage.input_tokens,
          response.usage.output_tokens,
          classifyResult,
          fallbackUsed,
        );

        this.tracker.record(meta);
        this.log(meta, classifyResult);

        const routed = response as RoutedMessage;
        routed.meta = meta;
        return routed;
      } catch (err) {
        lastError = err;
        if (
          this.config.fallback &&
          err instanceof Anthropic.RateLimitError &&
          i < TIER_ORDER.length - 1
        ) {
          continue;
        }
        throw err;
      }
    }

    throw lastError;
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
    let streamInstance: MessageStream | undefined;
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

        const s = this._client.messages.stream({
          ...apiParams,
          model,
        });

        streamInstance = s;
        resolveStream!(s);

        const finalMessage = await s.finalMessage();
        const meta = this.buildMeta(
          tier,
          model,
          finalMessage.usage.input_tokens,
          finalMessage.usage.output_tokens,
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
      stream: streamInstance ?? streamProxy,
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
  ClassifyInput,
  ClassifyResult,
} from './types.js';

export { heuristicScore, scoreToTier, scoreToConfidence, classifyHeuristic } from './classifier.js';
export { shouldRetry, nextTier } from './retry.js';
export {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  FAMILY_PRICING,
  computeCostCents,
  priceForModel,
  familyForModel,
} from './models.js';
export { CostTracker } from './tracker.js';
