const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makePairCode, normalizePairCode, formatPairCode, pairSecret } = require('../src/pair-code.cjs');

test('human-readable invitations accept spacing and case and reject malformed codes', async () => {
  const code = makePairCode();
  assert.match(code, /^[2-9A-HJ-NP-Z]{12}$/);
  assert.equal(normalizePairCode(formatPairCode(code).toLowerCase()), code);
  assert.equal(normalizePairCode(formatPairCode(code).replaceAll('-', ' ')), code);
  for (const wrong of [null, 'RD1.payload', code.slice(1), '0' + code.slice(1), 'O' + code.slice(1), 'A'.repeat(65)]) {
    assert.equal(normalizePairCode(wrong), null);
  }
  // Versioned derivation must agree across independently upgraded endpoints.
  const secret = await pairSecret('ABCD2345WXYZ');
  assert.equal(secret.toString('hex'), '3201928484e3b5d77b67498940430ec3316911eee86a0f661cab22383be72a4d');
});
