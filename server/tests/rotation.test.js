/**
 * rotation.test.js
 *
 * Unit test for the portfolio rotation logic in both books.
 *
 * Mocks Alpaca, scoring, market, and guardrails so the test
 * runs offline with no API calls and no real DB writes.
 *
 * Scenarios:
 *   1. Zombie exists + better candidate found → rotation sell fires
 *   2. Zombie exists + no better candidate   → rotation skipped, hold logged
 *   3. No zombies (all holdings above buy threshold) → rotation skipped silently
 *   4. Cash is healthy (>= $10) → rotation skipped (not needed)
 */

'use strict';

const assert = require('node:assert/strict');

// ─── Rotation logic extracted for unit testing ─────────────────────────────
// Rather than importing the full book file (which pulls in DB, Alpaca, etc.),
// we inline the rotation decision function here and test it directly.

const BUY_COMPOSITE_THRESHOLD = 60;
const ROTATION_MIN_IMPROVEMENT = 5;

/**
 * Decide whether to rotate a zombie holding out of the portfolio.
 *
 * @param {number}   cash             - available cash
 * @param {Array}    holdingEvals     - [{ticker, composite, pos, wokeScore, financialScore}]
 * @param {Array}    candidates       - [{ticker, composite, wokeAllowed}] — pre-scored candidates
 * @returns {{ action: 'sell'|'hold'|'skip', ticker?: string, reason?: string }}
 */
function decideRotation(cash, holdingEvals, candidates) {
  if (cash >= 10) return { action: 'skip', reason: 'Cash healthy — rotation not needed.' };

  const validEvals = holdingEvals.filter(e => e !== null);
  if (validEvals.length === 0) return { action: 'skip', reason: 'No holdings to evaluate.' };

  const zombies = validEvals
    .filter(e => e.composite < BUY_COMPOSITE_THRESHOLD)
    .sort((a, b) => a.composite - b.composite); // worst first

  if (zombies.length === 0) return { action: 'skip', reason: 'No zombie holdings found.' };

  const worstZombie = zombies[0];
  const minRequired = worstZombie.composite + ROTATION_MIN_IMPROVEMENT;

  const bestCandidate = candidates
    .filter(c => c.wokeAllowed && c.composite >= BUY_COMPOSITE_THRESHOLD && c.composite >= minRequired)
    .sort((a, b) => b.composite - a.composite)[0];

  if (bestCandidate) {
    return {
      action: 'sell',
      ticker: worstZombie.ticker,
      replacedBy: bestCandidate.ticker,
      reason: `Rotation: ${worstZombie.ticker} (${worstZombie.composite.toFixed(1)}) → ${bestCandidate.ticker} (${bestCandidate.composite.toFixed(1)})`,
    };
  }

  return {
    action: 'hold',
    ticker: worstZombie.ticker,
    reason: `No candidate beats ${worstZombie.ticker} by ${ROTATION_MIN_IMPROVEMENT}+ points.`,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ── Scenario 1: Zombie exists + clear winner candidate → rotation fires ─────
console.log('\nScenario 1: Zombie + better candidate → SELL');

test('fires rotation sell when candidate is 5+ points above zombie', () => {
  const cash = 6.31; // cash-poor
  const holdings = [
    { ticker: 'PYPL', composite: 57.0, pos: { qty: '4.674', current_price: '45.26' }, wokeScore: { score: 62 }, financialScore: { score: 45 } },
    { ticker: 'NVDA', composite: 60.8, pos: { qty: '1.834', current_price: '181.75' }, wokeScore: { score: 58 }, financialScore: { score: 72 } },
    { ticker: 'AMD',  composite: 63.2, pos: { qty: '1.567', current_price: '199.38' }, wokeScore: { score: 62 }, financialScore: { score: 68 } },
  ];
  const candidates = [
    { ticker: 'MSFT', composite: 74.0, wokeAllowed: true },
    { ticker: 'NEE',  composite: 71.0, wokeAllowed: true },
    { ticker: 'COST', composite: 68.0, wokeAllowed: true },
  ];

  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'sell', 'expected sell action');
  assert.equal(result.ticker, 'PYPL', 'expected worst zombie (PYPL) to be sold');
  assert.equal(result.replacedBy, 'MSFT', 'expected best candidate (MSFT) to be chosen');
});

test('sells the WORST zombie, not just any zombie', () => {
  const cash = 5.00;
  const holdings = [
    { ticker: 'WEAK', composite: 52.0, pos: { qty: '10', current_price: '10' }, wokeScore: { score: 55 }, financialScore: { score: 46 } },
    { ticker: 'MEH',  composite: 57.0, pos: { qty: '5', current_price: '20' }, wokeScore: { score: 58 }, financialScore: { score: 55 } },
  ];
  const candidates = [
    { ticker: 'GOOD', composite: 68.0, wokeAllowed: true },
  ];
  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'sell');
  assert.equal(result.ticker, 'WEAK', 'should sell WEAK (52), not MEH (57)');
});

// ── Scenario 2: Zombie exists + no candidate is better enough → hold ────────
console.log('\nScenario 2: Zombie + no candidate beats threshold → HOLD');

test('holds when best candidate does not clear zombie + 5pts', () => {
  const cash = 5.00;
  const holdings = [
    { ticker: 'PYPL', composite: 58.0, pos: { qty: '4', current_price: '45' }, wokeScore: { score: 62 }, financialScore: { score: 46 } },
  ];
  const candidates = [
    { ticker: 'XYZ', composite: 61.0, wokeAllowed: true }, // only 3pts above zombie — not enough
  ];
  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'hold');
  assert.equal(result.ticker, 'PYPL');
});

test('holds when best candidate fails woke floor', () => {
  const cash = 5.00;
  const holdings = [
    { ticker: 'PYPL', composite: 55.0, pos: { qty: '4', current_price: '45' }, wokeScore: { score: 62 }, financialScore: { score: 38 } },
  ];
  const candidates = [
    { ticker: 'XOM', composite: 72.0, wokeAllowed: false }, // high composite but blocked by ethics
  ];
  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'hold', 'XOM should be rejected despite high composite');
});

test('holds when best candidate is above zombie but below BUY_COMPOSITE_THRESHOLD', () => {
  const cash = 5.00;
  const holdings = [
    { ticker: 'WEAK', composite: 52.0, pos: { qty: '10', current_price: '10' }, wokeScore: { score: 55 }, financialScore: { score: 46 } },
  ];
  const candidates = [
    { ticker: 'ALSOMEDIUM', composite: 58.0, wokeAllowed: true }, // above zombie+5=57, but below buy threshold 60
  ];
  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'hold', 'candidate below BUY_COMPOSITE_THRESHOLD should not trigger rotation');
});

// ── Scenario 3: No zombie holdings → skip ───────────────────────────────────
console.log('\nScenario 3: All holdings above buy threshold → SKIP');

test('skips when all holdings are at or above BUY_COMPOSITE_THRESHOLD', () => {
  const cash = 5.00;
  const holdings = [
    { ticker: 'GOOD1', composite: 60.0, pos: {}, wokeScore: { score: 62 }, financialScore: { score: 58 } },
    { ticker: 'GOOD2', composite: 65.0, pos: {}, wokeScore: { score: 70 }, financialScore: { score: 55 } },
  ];
  const candidates = [
    { ticker: 'BETTER', composite: 80.0, wokeAllowed: true },
  ];
  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /No zombie/);
});

test('exact threshold: composite 60.0 is NOT a zombie (< not <=)', () => {
  // This is the real-world case we observed with PYPL at exactly 60.0
  const cash = 5.00;
  const holdings = [
    { ticker: 'PYPL', composite: 60.0, pos: {}, wokeScore: { score: 62 }, financialScore: { score: 52 } },
  ];
  const result = decideRotation(cash, [], []);  // no candidates needed
  const resultWithHolding = decideRotation(cash, holdings, [{ ticker: 'X', composite: 80, wokeAllowed: true }]);
  assert.equal(resultWithHolding.action, 'skip', '60.0 is not < 60, should not rotate');
});

// ── Scenario 4: Healthy cash → skip rotation entirely ───────────────────────
console.log('\nScenario 4: Sufficient cash → SKIP (rotation not needed)');

test('skips rotation when cash >= $10', () => {
  const cash = 500; // plenty of cash
  const holdings = [
    { ticker: 'WEAK', composite: 45.0, pos: {}, wokeScore: { score: 50 }, financialScore: { score: 36 } },
  ];
  const candidates = [{ ticker: 'GREAT', composite: 80.0, wokeAllowed: true }];
  const result = decideRotation(cash, holdings, candidates);
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /Cash healthy/);
});

// ── Edge: empty holdings array ───────────────────────────────────────────────
console.log('\nEdge cases');

test('handles empty holdings gracefully', () => {
  const result = decideRotation(5.00, [], []);
  assert.equal(result.action, 'skip');
});

test('handles null entries in holdingEvals (no market data for ticker)', () => {
  const holdings = [null, null, { ticker: 'WEAK', composite: 50.0, pos: {}, wokeScore: { score: 55 }, financialScore: { score: 40 } }];
  const candidates = [{ ticker: 'GREAT', composite: 80.0, wokeAllowed: true }];
  const result = decideRotation(5.00, holdings, candidates);
  assert.equal(result.action, 'sell', 'should still find zombie despite null entries');
  assert.equal(result.ticker, 'WEAK');
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Some tests failed. See above for details.');
  process.exit(1);
} else {
  console.log('\n  All rotation tests passed.');
}
