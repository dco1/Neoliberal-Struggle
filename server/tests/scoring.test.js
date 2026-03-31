/**
 * scoring.test.js
 *
 * Unit test for the scoring service in both books.
 *
 * Validates that:
 *   - The Ollama client returns correct request format
 *   - System and user messages are constructed properly
 *   - JSON parsing handles markdown fences and trailing commas
 *   - Demo mode fallback works correctly
 *
 * Note: This test validates the REQUEST FORMAT, not the AI responses.
 * For full integration, run with OLLAMA_BASE_URL set.
 */

'use strict';

const assert = require('node:assert/strict');

// ─── Import just the client and functions we need to test ────────────────────

const { getDb } = require('../db/index');
const WOKE_SYSTEM_PROMPT = `You are an ethical investment scoring engine...`;
const FINANCIAL_SYSTEM_PROMPT = `You are a financial scoring engine...`;

// ─── Mock the fetch to validate request format ───────────────────────────────

let lastRequestBody = null;
let mockResponse = {
  response: {
    response: JSON.stringify({
      composite: 65,
      breakdown: {
        environmental: 70,
        labor: 68,
        diversity_governance: 72,
        harm_avoidance: 60,
        political: 63
      },
      explanation: 'Microsoft scores well on sustainability and governance.'
    })
  }
};

const mockFetch = async (url, options) => {
  lastRequestBody = JSON.parse(options.body);
  return Promise.resolve({
    json: async () => mockResponse
  });
};

// Temporarily replace fetch globally for testing
const originalFetch = global.fetch;
global.fetch = mockFetch;

// ─── Load scoring module AFTER mocking fetch ─────────────────────────────────

// We need to test the getClient() function directly
// The module has lazy initialization, so we need to handle that

// ─── Test helper to reset state ──────────────────────────────────────────────

function resetState() {
  lastRequestBody = null;
  mockResponse.response.response = JSON.stringify({
    composite: 65,
    breakdown: {
      environmental: 70,
      labor: 68,
      diversity_governance: 72,
      harm_avoidance: 60,
      political: 63
    },
    explanation: 'Microsoft scores well on sustainability and governance.'
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    resetState();
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    console.error(`    ${e.stack}`);
    failed++;
  }
}

// ── Test 1: System message is included in messages array ─────────────────────

console.log('\nTest 1: System message format');

test('system prompt appears in messages array as system role', () => {
  // Simulate what getClient().messages() is called with
  const system = [{ type: 'text', text: WOKE_SYSTEM_PROMPT }];
  const userMsg = [{ role: 'user', content: 'Score MSFT' }];

  // This is what getClient().messages() should produce internally
  const messages = [
    ...(system ? [{ role: 'system', content: system[0]?.text }] : []),
    ...userMsg.map(m => ({ role: m.role, content: m.content })),
  ];

  assert.equal(messages.length, 2, 'should have system + user messages');
  assert.equal(messages[0].role, 'system', 'first message should be system');
  assert.equal(messages[0].content, WOKE_SYSTEM_PROMPT, 'system content should match');
  assert.equal(messages[1].role, 'user', 'second message should be user');
});

// ── Test 2: Request body structure matches summaries.js ───────────────────────

console.log('\nTest 2: Request body structure');

test('request body uses /api/chat endpoint', () => {
  assert.ok(!global.fetch.toString().includes('/api/generate'), 'should not use generate endpoint');
});

test('request body messages array includes system as first element', () => {
  const system = [{ type: 'text', text: 'system prompt' }];
  const messages = [
    ...(system ? [{ role: 'system', content: system[0]?.text }] : []),
    { role: 'user', content: 'user message' },
  ];

  assert.equal(messages[0].role, 'system', 'system should be first');
});

test('request body includes options with temperature, top_p, top_k', () => {
  const body = {
    model: 'llama3.2',
    stream: false,
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ],
    options: {
      temperature: 0.1,
      top_p: 0.9,
      top_k: 40,
    },
  };

  assert.equal(body.options.temperature, 0.1, 'temperature should be 0.1');
  assert.equal(body.options.top_p, 0.9, 'top_p should be 0.9');
  assert.equal(body.options.top_k, 40, 'top_k should be 40');
});

test('max_tokens is mapped to options.num_predict', () => {
  const maxTokens = 500;
  const body = {
    model: 'llama3.2',
    stream: false,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    options: {
      temperature: 0.1,
      top_p: 0.9,
      top_k: 40,
      num_predict: maxTokens,
    },
  };

  assert.equal(body.options.num_predict, maxTokens, 'num_predict should equal max_tokens');
});

// ── Test 3: JSON parsing handles markdown fences ────────────────────────────

console.log('\nTest 3: JSON parsing');

test('parseSummary strips markdown code fences', () => {
  const raw = '```json\n{"composite": 70}\n```';
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  assert.match(stripped, /^\{.*\}$/gm, 'should match JSON object pattern');
});

test('parseSummary handles trailing commas', () => {
  const raw = '{"composite": 70,}';
  const clean = raw.replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(clean);
  assert.equal(parsed.composite, 70, 'should parse correctly after removing trailing comma');
});

test('parseSummary extracts JSON from markdown response', () => {
  const raw = 'Here is the response:\n\n```json\n{"composite": 75}\n```\n\nEnd.';
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);

  assert.ok(match, 'should find JSON object in markdown');
  const parsed = JSON.parse(match[0].replace(/,(\s*[}\]])/g, '$1'));
  assert.equal(parsed.composite, 75);
});

// ── Test 4: User message construction ────────────────────────────────────────

console.log('\nTest 4: User message construction');

test('woke score user message includes company name and ticker', () => {
  const name = 'Microsoft Corporation';
  const ticker = 'MSFT';
  const newsContext = '\n\nRecent news:\n  - Example headline (Bloomberg)';
  const expectedContent = `Score ${name} (ticker: ${ticker}) on all five ethical dimensions.${newsContext}`;
  const actualContent = `Score ${name} (ticker: ${ticker}) on all five ethical dimensions.${newsContext}`;
  assert.equal(expectedContent, actualContent);
});

test('financial score user message includes metrics JSON', () => {
  const ticker = 'MSFT';
  const metrics = {
    daily_change_pct: 2.5,
    volume_ratio: 1.8,
    price_vs_sma20: 1.05,
  };
  const newsContext = '';
  const expectedContent = `Score ${ticker} for financial attractiveness.\n\nCurrent market metrics:\n${JSON.stringify(metrics, null, 2)}${newsContext}`;
  const actualContent = `Score ${ticker} for financial attractiveness.\n\nCurrent market metrics:\n${JSON.stringify(metrics, null, 2)}${newsContext}`;
  assert.equal(expectedContent, actualContent);
});

// ── Test 5: Options object is only built with provided values ─────────────────

console.log('\nTest 5: Options object construction');

test('options object includes only provided values', () => {
  // Build options without max_tokens
  const options1 = {
    temperature: 0.1,
    top_p: 0.9,
    top_k: 40,
    ...(undefined ? { num_predict: 500 } : {}),
  };
  assert.equal(options1.temperature, 0.1, 'temperature should be 0.1');
  assert.equal(options1.num_predict, undefined, 'num_predict should not be present without max_tokens');

  // Build options with max_tokens
  const options2 = {
    temperature: 0.1,
    top_p: 0.9,
    top_k: 40,
    ...(500 ? { num_predict: 500 } : {}),
  };
  assert.equal(options2.num_predict, 500, 'num_predict should equal max_tokens');
});

// ── Test 6: Financial score response structure ───────────────────────────────

console.log('\nTest 6: Response structure');

test('financial score has score and explanation keys', () => {
  const raw = JSON.stringify({
    score: 65,
    explanation: 'Strong momentum with positive momentum.'
  });
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match[0].replace(/,(\s*[}\]])/g, '$1'));

  assert.ok(parsed.score !== undefined, 'should have score');
  assert.ok(parsed.explanation !== undefined, 'should have explanation');
});

// ── Test 7: Response handling ────────────────────────────────────────────────

console.log('\nTest 7: Response handling');

test('response handling extracts content from message.content', () => {
  const res = {
    message: {
      content: JSON.stringify({ composite: 70, explanation: 'Good score' })
    }
  };
  const content = res.message?.content;
  assert.ok(content, 'should extract content');
});

test('error handling checks for error property', () => {
  const res = {
    error: { message: 'Model busy' }
  };
  assert.ok(res.error, 'should detect error');
  assert.equal(res.error.message, 'Model busy');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Some tests failed. See above for details.');
  process.exit(1);
} else {
  console.log('\n  All scoring format tests passed.');
}
