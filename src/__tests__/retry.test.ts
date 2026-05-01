import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetry, nextTier } from '../retry.js';
import type Anthropic from '@anthropic-ai/sdk';

function fakeResponse(overrides: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'Hello world response here', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
  } as unknown as Anthropic.Message;
}

describe('shouldRetry', () => {
  it('no retry on normal response', () => {
    const result = shouldRetry(fakeResponse(), 'haiku');
    assert.equal(result.retry, false);
    assert.equal(result.reason, null);
  });

  it('retry on truncation (max_tokens with output > 20)', () => {
    const result = shouldRetry(
      fakeResponse({
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'truncation');
  });

  it('no retry on truncation with very short output', () => {
    const result = shouldRetry(
      fakeResponse({
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      'haiku',
    );
    assert.equal(result.retry, false);
  });

  it('no retry on truncation from opus', () => {
    const result = shouldRetry(
      fakeResponse({
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      'opus',
    );
    assert.equal(result.retry, false);
  });

  it('retry on refusal pattern', () => {
    const result = shouldRetry(
      fakeResponse({
        content: [{ type: 'text', text: "I can't help with that." }],
      }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('retry on "as an AI" refusal', () => {
    const result = shouldRetry(
      fakeResponse({
        content: [{ type: 'text', text: 'As an AI, I cannot do that.' }],
      }),
      'sonnet',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('no retry on long response with refusal-like word', () => {
    const result = shouldRetry(
      fakeResponse({
        content: [{ type: 'text', text: 'A'.repeat(250) + " I can't believe how great this is" }],
      }),
      'haiku',
    );
    assert.equal(result.retry, false);
  });

  it('no retry from opus even on refusal', () => {
    const result = shouldRetry(
      fakeResponse({
        content: [{ type: 'text', text: "I can't help." }],
      }),
      'opus',
    );
    assert.equal(result.retry, false);
  });
});

describe('nextTier', () => {
  it('haiku → sonnet', () => assert.equal(nextTier('haiku'), 'sonnet'));
  it('sonnet → opus', () => assert.equal(nextTier('sonnet'), 'opus'));
  it('opus → null', () => assert.equal(nextTier('opus'), null));
});
