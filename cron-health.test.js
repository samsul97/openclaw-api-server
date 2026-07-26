const test = require('node:test');
const assert = require('node:assert/strict');

const { cronHealthIssue } = require('./index');

const NOW = 2_000_000_000;

test('classifies a cron that is more than five minutes late', () => {
  const issue = cronHealthIssue({ next_run_at_ms: NOW - 300_001 }, NOW);
  assert.equal(issue.kind, 'late');
});

test('classifies a cron that has run for more than fifteen minutes as stuck', () => {
  const issue = cronHealthIssue({
    running_at_ms: NOW - 900_001,
    next_run_at_ms: NOW - 1_000_000,
  }, NOW);
  assert.equal(issue.kind, 'stuck');
});

test('classifies execution and delivery failures', () => {
  assert.equal(cronHealthIssue({
    last_run_at_ms: NOW - 1_000,
    last_run_status: 'error',
    last_error: 'model timeout',
  }, NOW).kind, 'execution_failed');

  assert.equal(cronHealthIssue({
    last_run_status: 'ok',
    last_delivery_status: 'failed',
    last_delivery_error: 'channel unavailable',
  }, NOW).kind, 'delivery_failed');
});

test('returns no issue for a healthy future run', () => {
  assert.equal(cronHealthIssue({
    next_run_at_ms: NOW + 60_000,
    last_run_status: 'ok',
    last_delivery_status: 'delivered',
  }, NOW), null);
});
