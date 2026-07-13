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

  it('does not throw when response.content is undefined', () => {
    // Regression: extractResponseText did response.content.filter(...) and an
    // undefined content threw TypeError, uncaught in the proxy handler — it
    // surfaced as a 500 plus a leaked connection.
    const result = shouldRetry(fakeResponse({ content: undefined }), 'haiku');
    assert.equal(result.retry, false);
    assert.equal(result.reason, null);
  });

  it('does not throw when usage is undefined on a max_tokens stop', () => {
    const result = shouldRetry(
      fakeResponse({ stop_reason: 'max_tokens', usage: undefined }),
      'haiku',
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

  // ── G7 regressions: apostrophe normalization + tightened patterns ──────────

  it('retry on refusal written with a curly apostrophe (U+2019)', () => {
    // Claude output routinely uses the typographic apostrophe; straight-quote
    // patterns missed it, so genuine refusals evaded escalation.
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'I can’t help with that.' }] }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('retry on the spaced "I can not" refusal form', () => {
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'I can not do that.' }] }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('no retry on the benign opener "I can\'t wait to help"', () => {
    // Bare "i can't" over-matched this; it must not trigger a costly escalation.
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: "I can't wait to help — here's the answer: 42" }] }),
      'haiku',
    );
    assert.equal(result.retry, false);
    assert.equal(result.reason, null);
  });

  it('no retry on the benign opener "As an AI enthusiast"', () => {
    // Bare "as an ai" over-matched this benign self-description.
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: "As an AI enthusiast, here's my take: 42" }] }),
      'haiku',
    );
    assert.equal(result.retry, false);
    assert.equal(result.reason, null);
  });

  // ── German refusal patterns (issue #3) ─────────────────────────────────────

  it('retry on German refusal "Ich kann dabei nicht helfen"', () => {
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'Ich kann dabei nicht helfen.' }] }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('retry on German fronted word order "Dabei kann ich nicht helfen"', () => {
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'Dabei kann ich nicht helfen.' }] }),
      'sonnet',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('retry on German refusal with leading apology, still inside the 80-char scan window', () => {
    const result = shouldRetry(
      fakeResponse({
        content: [{ type: 'text', text: 'Es tut mir leid, aber ich kann Ihnen dabei nicht helfen.' }],
      }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('retry on German "als KI" refusal', () => {
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'Als KI kann ich nicht auf externe Systeme zugreifen.' }] }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('retry on German "nicht in der Lage" refusal', () => {
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'Ich bin nicht in der Lage, das zu tun.' }] }),
      'haiku',
    );
    assert.equal(result.retry, true);
    assert.equal(result.reason, 'refusal');
  });

  it('no retry on benign German "Ich kann keine Fehler finden"', () => {
    // The broad "ich kann keine" pattern is deliberately excluded — it would
    // escalate benign answers like this one.
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'Ich kann keine Fehler finden — alles sieht gut aus.' }] }),
      'haiku',
    );
    assert.equal(result.retry, false);
    assert.equal(result.reason, null);
  });

  it('no retry on benign German "Das kann ich nicht garantieren"', () => {
    // Bare "das kann ich nicht" is excluded for the same over-match reason.
    const result = shouldRetry(
      fakeResponse({ content: [{ type: 'text', text: 'Das kann ich nicht garantieren, aber es ist sehr wahrscheinlich: 42' }] }),
      'haiku',
    );
    assert.equal(result.retry, false);
    assert.equal(result.reason, null);
  });
});

describe('nextTier', () => {
  it('haiku → sonnet', () => assert.equal(nextTier('haiku'), 'sonnet'));
  it('sonnet → opus', () => assert.equal(nextTier('sonnet'), 'opus'));
  it('opus → null', () => assert.equal(nextTier('opus'), null));
});
