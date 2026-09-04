import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRouter } from '../index.js';
import { DEFAULT_MODELS } from '../models.js';
import { resetDeadRoutingWarnings } from '../routing.js';
import Anthropic from '@anthropic-ai/sdk';

function fakeMessage(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODELS.sonnet,
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, ...(overrides.usage ?? {}) },
    ...overrides,
  } as Anthropic.Message;
}

function createMockRouter(opts?: { classifier?: 'heuristic' | 'ai' | 'hybrid' }) {
  const router = new ClaudeRouter({
    apiKey: 'sk-test',
    classifier: opts?.classifier ?? 'heuristic',
    verbose: false,
  });

  const createFn = mock.fn(async (_params: unknown) => fakeMessage());

  // Replace client with mock
  (router as unknown as { _client: unknown })._client = {
    messages: {
      create: createFn,
      stream: mock.fn(),
    },
  };

  return { router, createFn };
}

describe('ClaudeRouter.send', () => {
  it('routes simple prompt to haiku', async () => {
    const { router, createFn } = createMockRouter();

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
    });

    assert.equal(result.meta.tier, 'haiku');
    assert.equal(result.meta.model, DEFAULT_MODELS.haiku);
    assert.equal(createFn.mock.calls.length, 1);

    const callArgs = createFn.mock.calls[0]!.arguments[0] as { model: string };
    assert.equal(callArgs.model, DEFAULT_MODELS.haiku);
  });

  it('routes complex prompt to opus', async () => {
    const { router, createFn } = createMockRouter();

    const result = await router.send({
      messages: [
        {
          role: 'user',
          content:
            'architect and design a distributed system, evaluate tradeoffs, strategize about scaling and prove correctness',
        },
      ],
      max_tokens: 1000,
    });

    assert.equal(result.meta.tier, 'opus');
    assert.equal(result.meta.model, DEFAULT_MODELS.opus);
    const callArgs = createFn.mock.calls[0]!.arguments[0] as { model: string };
    assert.equal(callArgs.model, DEFAULT_MODELS.opus);
  });

  it('tier override skips classifier', async () => {
    const { router, createFn } = createMockRouter();

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
      tier: 'opus',
    });

    assert.equal(result.meta.tier, 'opus');
    assert.equal(result.meta.model, DEFAULT_MODELS.opus);
    const callArgs = createFn.mock.calls[0]!.arguments[0] as { model: string };
    assert.equal(callArgs.model, DEFAULT_MODELS.opus);
  });

  it('includes cost and savings in meta', async () => {
    const { router } = createMockRouter();

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    assert.equal(typeof result.meta.costCents, 'number');
    assert.equal(typeof result.meta.savedCents, 'number');
    assert.ok(result.meta.costCents >= 0);
    // Haiku cheaper than sonnet baseline → positive savings
    assert.ok(result.meta.savedCents >= 0);
  });

  it('tracks stats across calls', async () => {
    const { router } = createMockRouter();

    await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });
    await router.send({
      messages: [{ role: 'user', content: 'translate goodbye' }],
      max_tokens: 100,
    });

    const stats = router.stats();
    assert.equal(stats.callCount, 2);
    assert.ok(stats.totalCostCents > 0);
  });

  it('reset clears stats', async () => {
    const { router } = createMockRouter();

    await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    router.reset();
    assert.equal(router.stats().callCount, 0);
  });

  it('fallback on RateLimitError escalates to next tier', async () => {
    const { router } = createMockRouter();

    // A genuine Anthropic.RateLimitError so the `instanceof` guard in
    // ClaudeRouter.send actually fires. Forcing the prototype is version-proof
    // against the SDK's APIError constructor signature.
    let callCount = 0;
    const mockCreate = mock.fn(async (params: { model: string }) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('rate limited');
        Object.setPrototypeOf(err, Anthropic.RateLimitError.prototype);
        throw err;
      }
      return fakeMessage({ model: params.model });
    });

    (router as unknown as { _client: { messages: { create: typeof mockCreate } } })._client.messages.create = mockCreate;

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    // haiku rate-limited → escalate to sonnet
    assert.equal(result.meta.tier, 'sonnet');
    assert.equal(result.meta.model, DEFAULT_MODELS.sonnet);
    assert.equal(result.meta.fallbackUsed, true);
    assert.equal(mockCreate.mock.calls.length, 2);
    assert.equal((mockCreate.mock.calls[0]!.arguments[0] as { model: string }).model, DEFAULT_MODELS.haiku);
    assert.equal((mockCreate.mock.calls[1]!.arguments[0] as { model: string }).model, DEFAULT_MODELS.sonnet);
  });

  it('fallback never walks a rate-limited opus route onto fable', async () => {
    const { router } = createMockRouter();
    const mockCreate = mock.fn(async (_params: { model: string }) => {
      const err = new Error('rate limited');
      Object.setPrototypeOf(err, Anthropic.RateLimitError.prototype);
      throw err;
    });
    (router as unknown as { _client: { messages: { create: typeof mockCreate } } })._client.messages.create = mockCreate;

    await assert.rejects(
      router.send({
        // An explicit depth request classifies to opus.
        messages: [{ role: 'user', content: 'architect a payment system and prove correctness under partition' }],
        max_tokens: 100,
      }),
      Anthropic.RateLimitError,
    );
    const sent = mockCreate.mock.calls.map((c) => (c.arguments[0] as { model: string }).model);
    assert.deepEqual(sent, [DEFAULT_MODELS.opus], 'one call at the ceiling, nothing above it');
  });

  it('propagates RateLimitError when fallback is disabled', async () => {
    const router = new ClaudeRouter({
      apiKey: 'sk-test',
      classifier: 'heuristic',
      verbose: false,
      fallback: false,
    });

    const mockCreate = mock.fn(async () => {
      const err = new Error('rate limited');
      Object.setPrototypeOf(err, Anthropic.RateLimitError.prototype);
      throw err;
    });
    (router as unknown as { _client: unknown })._client = {
      messages: { create: mockCreate, stream: mock.fn() },
    };

    await assert.rejects(
      () =>
        router.send({
          messages: [{ role: 'user', content: 'translate hello' }],
          max_tokens: 100,
        }),
      { message: 'rate limited' },
    );
    // No escalation — the single haiku attempt throws and propagates.
    assert.equal(mockCreate.mock.calls.length, 1);
  });

  it('verbose mode logs to console', async () => {
    const router = new ClaudeRouter({
      apiKey: 'sk-test',
      classifier: 'heuristic',
      verbose: true,
    });

    const mockCreate = mock.fn(async () => fakeMessage());
    (router as unknown as { _client: unknown })._client = {
      messages: { create: mockCreate, stream: mock.fn() },
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };

    try {
      await router.send({
        messages: [{ role: 'user', content: 'translate hello' }],
        max_tokens: 100,
      });

      assert.ok(logs.length > 0, 'should have logged');
      assert.ok(
        logs.some((l) => l.includes('[claude-router]')),
        `expected [claude-router] in logs, got: ${logs.join('\n')}`,
      );
    } finally {
      console.log = origLog;
    }
  });
});

describe('ClaudeRouter.send auto-retry', () => {
  it('retries on truncation — escalates haiku→sonnet', async () => {
    const { router } = createMockRouter();
    let callNum = 0;
    const mockCreate = mock.fn(async (params: { model: string }) => {
      callNum++;
      if (callNum === 1) {
        return fakeMessage({
          model: params.model,
          stop_reason: 'max_tokens',
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        });
      }
      return fakeMessage({ model: params.model });
    });
    (router as unknown as { _client: { messages: { create: typeof mockCreate } } })._client.messages.create = mockCreate;

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    assert.equal(result.meta.retried, true);
    assert.equal(result.meta.retryReason, 'truncation');
    assert.equal(result.meta.tier, 'sonnet');
    assert.equal(mockCreate.mock.calls.length, 2);

    const firstModel = (mockCreate.mock.calls[0]!.arguments[0] as { model: string }).model;
    const secondModel = (mockCreate.mock.calls[1]!.arguments[0] as { model: string }).model;
    assert.equal(firstModel, DEFAULT_MODELS.haiku);
    assert.equal(secondModel, DEFAULT_MODELS.sonnet);
  });

  it('retries on refusal — escalates tier', async () => {
    const { router } = createMockRouter();
    let callNum = 0;
    const mockCreate = mock.fn(async (params: { model: string }) => {
      callNum++;
      if (callNum === 1) {
        return fakeMessage({
          model: params.model,
          content: [{ type: 'text', text: "I can't help with that.", citations: null }],
        });
      }
      return fakeMessage({ model: params.model });
    });
    (router as unknown as { _client: { messages: { create: typeof mockCreate } } })._client.messages.create = mockCreate;

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    assert.equal(result.meta.retried, true);
    assert.equal(result.meta.retryReason, 'refusal');
  });

  it('does NOT chain retries (only once)', async () => {
    const { router } = createMockRouter();
    const mockCreate = mock.fn(async (params: { model: string }) => {
      // Always return truncated
      return fakeMessage({
        model: params.model,
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      });
    });
    (router as unknown as { _client: { messages: { create: typeof mockCreate } } })._client.messages.create = mockCreate;

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    // Should only call twice: initial haiku + one retry to sonnet
    // Should NOT chain to opus
    assert.equal(mockCreate.mock.calls.length, 2);
    assert.equal(result.meta.tier, 'sonnet');
  });

  it('confidence appears in meta', async () => {
    const { router } = createMockRouter();

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });

    assert.equal(typeof result.meta.confidence, 'number');
    assert.ok(result.meta.confidence >= 0 && result.meta.confidence <= 1);
  });

  it('forced tier sets confidence to 1.0', async () => {
    const { router } = createMockRouter();

    const result = await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
      tier: 'opus',
    });

    assert.equal(result.meta.confidence, 1.0);
  });
});

describe('ClaudeRouter.stats', () => {
  it('returns correct tier breakdown', async () => {
    const { router } = createMockRouter();

    // Simple → haiku
    await router.send({
      messages: [{ role: 'user', content: 'translate hello' }],
      max_tokens: 100,
    });
    // Complex → opus
    await router.send({
      messages: [
        {
          role: 'user',
          content: 'architect design evaluate strategize prove reason about distributed systems',
        },
      ],
      max_tokens: 100,
    });

    const stats = router.stats();
    assert.ok(stats.tierBreakdown.haiku >= 1);
    assert.ok(stats.tierBreakdown.opus >= 1);
  });
});

describe('ClaudeRouter — classifier resilience', () => {
  it('hybrid mode still routes when the AI classifier call fails', async () => {
    const router = new ClaudeRouter({
      apiKey: 'sk-test',
      classifier: 'hybrid',
      verbose: false,
    });

    // Ambiguous prompt → hybrid wants AI confirmation. First create call
    // (the classifier) rejects; the routed request itself succeeds.
    let calls = 0;
    (router as unknown as { _client: unknown })._client = {
      messages: {
        create: mock.fn(async (params: { max_tokens: number }) => {
          calls++;
          if (params.max_tokens === 4) throw new Error('haiku outage');
          return fakeMessage();
        }),
        stream: mock.fn(),
      },
    };

    const result = await router.send({
      messages: [{ role: 'user', content: 'explain compare write generate describe this code' }],
      max_tokens: 100,
    });

    assert.equal(result.meta.classifierMethod, 'heuristic');
    assert.equal(calls, 2, 'classifier attempt + routed request');
    assert.ok(result.meta.tier);
  });
});

describe('ClaudeRouter logger sink', () => {
  it('routes config warnings to an injected logger, not the console', () => {
    resetDeadRoutingWarnings();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => void warnings.push(String(msg));
    const custom: string[] = [];
    try {
      new ClaudeRouter({
        apiKey: 'sk-test',
        verbose: false,
        logger: { warn: (msg) => void custom.push(msg) },
        routing: { haikuMax: 30 } as never,
      });
    } finally {
      console.warn = original;
      resetDeadRoutingWarnings();
    }

    assert.equal(custom.length, 1);
    assert.match(custom[0]!, /routing\.haikuMax/);
    assert.deepEqual(warnings, [], 'console.warn must stay silent');
  });
});

describe('ClaudeRouter.stream', () => {
  function withStream(
    router: ClaudeRouter,
    impl: (params: { model: string }) => unknown,
  ): ReturnType<typeof mock.fn> {
    const streamFn = mock.fn(impl);
    (router as unknown as { _client: { messages: { stream: typeof streamFn } } })._client.messages.stream = streamFn;
    return streamFn;
  }

  it('routes a streamed request and resolves meta for the chosen tier', async () => {
    const { router } = createMockRouter();

    let streamedModel: string | undefined;
    const streamFn = withStream(router, (params) => {
      streamedModel = params.model;
      return {
        finalMessage: async () => fakeMessage({ model: params.model }),
      };
    });

    const { meta } = await router.stream({
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
    });

    const resolved = await meta;
    assert.equal(resolved.tier, 'haiku');
    assert.equal(resolved.model, DEFAULT_MODELS.haiku);
    assert.equal(streamedModel, DEFAULT_MODELS.haiku);
    assert.equal(streamFn.mock.calls.length, 1);
    assert.equal(router.stats().callCount, 1);
  });

  it('returns the real stream: for-await iteration works', async () => {
    const { router } = createMockRouter();

    withStream(router, () => ({
      // The API contract the old Proxy wrapper broke: the returned object IS
      // the SDK stream, so its async iterator must be directly consumable.
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'content_block_delta' };
        yield { type: 'message_stop' };
      },
      finalMessage: async () => fakeMessage(),
    }));

    const { stream } = await router.stream({
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    });

    const events: unknown[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      events.push(event);
    }
    assert.equal(events.length, 2);
  });

  it('rejects when the SDK stream call throws synchronously', async () => {
    const { router } = createMockRouter();
    withStream(router, () => {
      throw new Error('bad params');
    });

    await assert.rejects(
      router.stream({
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
      }),
      /bad params/,
    );
  });

  it('rejects an unknown forced tier before any API call', async () => {
    const { router } = createMockRouter();
    const streamFn = withStream(router, () => ({
      finalMessage: async () => fakeMessage(),
    }));

    await assert.rejects(
      router.stream({
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
        tier: 'gpt4' as never,
      }),
      TypeError,
    );
    assert.equal(streamFn.mock.calls.length, 0);
  });

  it('a mid-stream failure cannot crash a caller that ignores meta', async () => {
    const { router } = createMockRouter();
    withStream(router, () => ({
      finalMessage: async () => {
        throw new Error('stream died');
      },
    }));

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const { meta } = await router.stream({
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
      });
      // Consume only the stream (i.e. do nothing with meta) and give the
      // rejection a macrotask to surface if it were unhandled.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(rejections, [], 'ignoring meta must not raise unhandledRejection');
      // Awaiting meta still surfaces the error.
      await assert.rejects(meta, /stream died/);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
