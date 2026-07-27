'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWebSearchPolicy } = require('./index');

test('accepts only the backend-owned parallel-free policy', () => {
  assert.deepEqual(normalizeWebSearchPolicy({
    enabled: true,
    provider: 'parallel-free',
    fetch_enabled: true,
  }), {
    provider: 'parallel-free',
    fetchEnabled: true,
  });
});

test('rejects missing, paid, or user-selected providers', () => {
  for (const policy of [
    undefined,
    { enabled: true, provider: 'parallel', fetch_enabled: true },
    { enabled: true, provider: 'duckduckgo', fetch_enabled: true },
    { enabled: false, provider: 'parallel-free', fetch_enabled: true },
    { enabled: true, provider: 'parallel-free', fetch_enabled: false },
  ]) {
    assert.throws(() => normalizeWebSearchPolicy(policy));
  }
});
