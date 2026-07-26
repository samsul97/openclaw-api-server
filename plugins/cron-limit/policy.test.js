import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  countCronJobs,
  cronJobName,
  evaluateCronAdd,
  evaluateCronCollision,
  evaluateCronRemove,
} from './policy.js';

test('counts all enabled and disabled cron rows from OpenClaw state', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-limit-policy-'));
  const state = path.join(temp, 'state');
  fs.mkdirSync(state, { recursive: true });
  const database = new DatabaseSync(path.join(state, 'openclaw.sqlite'));
  database.exec('CREATE TABLE cron_jobs (job_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
  database.exec("INSERT INTO cron_jobs VALUES ('default-1', 1), ('custom-disabled', 0)");
  database.close();

  try {
    assert.equal(countCronJobs(temp), 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('allows cron N while current count is below max', () => {
  const result = evaluateCronAdd({ maxTotal: 7, defaultCount: 2, additionalLimit: 5, stateDir: '/state' }, () => 6);
  assert.equal(result, undefined);
});

test('blocks cron N+1 when current count equals max', () => {
  const result = evaluateCronAdd({ maxTotal: 7, defaultCount: 2, additionalLimit: 5, stateDir: '/state' }, () => 7);
  assert.equal(result.block, true);
  assert.match(result.blockReason, /7\/7/);
});

test('fails closed when policy is invalid', () => {
  const result = evaluateCronAdd({ maxTotal: null, defaultCount: 2, additionalLimit: 5, stateDir: '' }, () => 0);
  assert.equal(result.block, true);
});

test('fails closed when policy components do not equal max total', () => {
  const result = evaluateCronAdd({ maxTotal: 8, defaultCount: 2, additionalLimit: 5, stateDir: '/state' }, () => 0);
  assert.equal(result.block, true);
});

test('fails closed when state database cannot be read', () => {
  const result = evaluateCronAdd({ maxTotal: 7, defaultCount: 2, additionalLimit: 5, stateDir: '/state' }, () => {
    throw new Error('database unavailable');
  });
  assert.equal(result.block, true);
});

test('looks up a cron job name by id', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-limit-policy-'));
  const state = path.join(temp, 'state');
  fs.mkdirSync(state, { recursive: true });
  const database = new DatabaseSync(path.join(state, 'openclaw.sqlite'));
  database.exec('CREATE TABLE cron_jobs (job_id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  database.exec("INSERT INTO cron_jobs VALUES ('job-1', 'aldo__operator_limit_test_01')");
  database.close();

  try {
    assert.equal(cronJobName(temp, 'job-1'), 'aldo__operator_limit_test_01');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('blocks conversational removal of operator limit-test cron', () => {
  const result = evaluateCronRemove(
    { stateDir: '/state' },
    'job-1',
    () => 'aldo__operator_limit_test_01',
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /dikelola operator/);
});

test('allows removal of ordinary user cron', () => {
  const result = evaluateCronRemove(
    { stateDir: '/state' },
    'job-1',
    () => 'aldo__health_custom_reminder',
  );
  assert.equal(result, undefined);
});

test('blocks a recurring cron within the configured minimum gap', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'cron', expr: '33 7 * * *', tz: 'Asia/Jakarta' } },
    () => [{
      id: 'existing',
      name: 'admin_daily_agenda',
      kind: 'cron',
      expr: '30 7 * * *',
      tz: 'Asia/Jakarta',
    }],
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /07:35/);
  assert.match(result.blockReason, /mengonfirmasi/);
});

test('allows a recurring cron at exactly the minimum gap', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'cron', expr: '35 7 * * *', tz: 'Asia/Jakarta' } },
    () => [{
      id: 'existing',
      name: 'admin_daily_agenda',
      kind: 'cron',
      expr: '30 7 * * *',
      tz: 'Asia/Jakarta',
    }],
  );
  assert.equal(result, undefined);
});

test('detects overlap between a daily cron and a Monday cron', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'cron', expr: '30 7 * * *', tz: 'Asia/Jakarta' } },
    () => [{
      id: 'existing',
      name: 'monday_job',
      kind: 'cron',
      expr: '30 7 * * 1',
      tz: 'Asia/Jakarta',
    }],
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /monday_job/);
});

test('allows recurring jobs on disjoint weekdays', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'cron', expr: '30 7 * * 2', tz: 'Asia/Jakarta' } },
    () => [{
      id: 'existing',
      name: 'monday_job',
      kind: 'cron',
      expr: '30 7 * * 1',
      tz: 'Asia/Jakarta',
    }],
  );
  assert.equal(result, undefined);
});

test('blocks one-shot reminders inside the minimum gap', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'at', at: '2026-08-01T03:03:00.000Z' } },
    () => [{
      id: 'existing',
      name: 'one_shot',
      kind: 'at',
      at: '2026-08-01T03:00:00.000Z',
    }],
  );
  assert.equal(result.block, true);
});

test('excludes the job itself while validating an update', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'cron', expr: '30 7 * * *', tz: 'Asia/Jakarta' } },
    () => [{
      id: 'job-being-updated',
      name: 'admin_daily_agenda',
      kind: 'cron',
      expr: '30 7 * * *',
      tz: 'Asia/Jakarta',
    }],
    'job-being-updated',
  );
  assert.equal(result, undefined);
});

test('still detects another assistant job while validating an update', () => {
  const result = evaluateCronCollision(
    { stateDir: '/state', minGapMinutes: 5 },
    { schedule: { kind: 'cron', expr: '32 7 * * *', tz: 'Asia/Jakarta' } },
    () => [
      {
        id: 'job-being-updated',
        name: 'career_reminder',
        kind: 'cron',
        expr: '0 9 * * 1',
        tz: 'Asia/Jakarta',
      },
      {
        id: 'different-assistant',
        name: 'admin_daily_agenda',
        kind: 'cron',
        expr: '30 7 * * *',
        tz: 'Asia/Jakarta',
      },
    ],
    'job-being-updated',
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /admin_daily_agenda/);
});
