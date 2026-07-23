import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { executeRoute } from '../route.js';
import { DEFAULT_MODELS } from '../models.js';
import type { Tier } from '../types.js';

function fakeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
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

function rateLimitError(): Error {
  // A genuine Anthropic.RateLimitError so the `instanceof` guard fires.
  // Forcing the prototype is version-proof against the SDK's APIError
  // constructor signature.
  const err = new Error('rate limited');
  Object.setPrototypeOf(err, Anthropic.RateLimitError.prototype);
  return err;
}

function clientWith(createFn: ReturnType<typeof mock.fn>): Anthropic {
  return { messages: { create: createFn } } as unknown as Anthropic;
}

const PARAMS = {
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 100,
};

describe('executeRoute', () => {
  it('rejects an unknown tier with a TypeError before any API call', async () => {
    const createFn = mock.fn(async () => fakeMessage());

    await assert.rejects(
      executeRoute(clientWith(createFn), PARAMS, 'gpt4' as Tier, DEFAULT_MODELS, {
        fallbackOnRateLimit: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.match((err as Error).message, /Unknown tier "gpt4"/);
        return true;
      },
    );
    assert.equal(createFn.mock.calls.length, 0);
  });

  it('walks up a tier on RateLimitError when fallback is enabled', async () => {
    let calls = 0;
    const createFn = mock.fn(async (params: { model: string }) => {
      calls++;
      if (calls === 1) throw rateLimitError();
      return fakeMessage({ model: params.model });
    });

    const result = await executeRoute(clientWith(createFn), PARAMS, 'haiku', DEFAULT_MODELS, {
      fallbackOnRateLimit: true,
    });

    assert.equal(result.tier, 'sonnet');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.retried, false);
    assert.equal(createFn.mock.calls.length, 2);
  });

  it('escalates once on truncation', async () => {
    const createFn = mock.fn(async (params: { model: string }) => {
      if (createFn.mock.calls.length === 0) {
        return fakeMessage({
          stop_reason: 'max_tokens',
          usage: { input_tokens: 100, output_tokens: 500 } as Anthropic.Usage,
        });
      }
      return fakeMessage({ model: params.model });
    });

    const result = await executeRoute(clientWith(createFn), PARAMS, 'sonnet', DEFAULT_MODELS, {
      fallbackOnRateLimit: true,
    });

    assert.equal(result.tier, 'opus');
    assert.equal(result.retried, true);
    assert.equal(result.retryReason, 'truncation');
    assert.equal(createFn.mock.calls.length, 2);
  });

  it('serves the original response when the escalated retry itself fails', async () => {
    const truncated = fakeMessage({
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 500 } as Anthropic.Usage,
    });
    let calls = 0;
    const createFn = mock.fn(async () => {
      calls++;
      if (calls === 1) return truncated;
      throw rateLimitError();
    });

    const result = await executeRoute(clientWith(createFn), PARAMS, 'sonnet', DEFAULT_MODELS, {
      fallbackOnRateLimit: true,
    });

    // The degraded-but-real original is returned; no third walk-up call happens.
    assert.equal(result.response, truncated);
    assert.equal(result.tier, 'sonnet');
    assert.equal(result.retried, false);
    assert.equal(result.retryReason, null);
    assert.equal(createFn.mock.calls.length, 2);
  });

  it('propagates RateLimitError when fallback is disabled', async () => {
    const createFn = mock.fn(async () => {
      throw rateLimitError();
    });

    await assert.rejects(
      executeRoute(clientWith(createFn), PARAMS, 'haiku', DEFAULT_MODELS, {
        fallbackOnRateLimit: false,
      }),
      Anthropic.RateLimitError,
    );
    assert.equal(createFn.mock.calls.length, 1);
  });
});
