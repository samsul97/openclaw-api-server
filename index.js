const express = require('express');
const { exec, execSync, execFile, execFileSync, spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = 18799;
const HOST = '127.0.0.1';
const API_TOKEN = process.env.OPENCLAW_API_TOKEN || 'changeme-set-env-var';
const SCRIPTS_DIR = '/root';
const NODE_BIN = '/root/.nvm/versions/node/v22.22.0/bin/node';
const OPENCLAW_BIN = '/root/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/dist/index.js';
const CLAUDE_BIN = '/root/.nvm/versions/node/v22.22.0/bin/claude';
const WHATSAPP_PLUGIN_SPEC = '@openclaw/whatsapp@2026.5.27';
const MODEL_POOL_SCRIPT = path.join(__dirname, 'chatgpt-pool-store.py');
const CRON_LIMIT_PLUGIN_SOURCE = path.join(__dirname, 'plugins', 'cron-limit');
const managedLoginSessions = new Map();
const modelPoolLoginSessions = new Map();
const modelPoolSyncJobs = new Map();
const modelPoolClientsInFlight = new Set();
const MODEL_POOL_HEALTH_STATE_FILE = '/root/.openclaw/model-pool-health.json';
const modelPoolHealthChecks = new Map(
  Object.entries(readJsonFile(MODEL_POOL_HEALTH_STATE_FILE, {})).map(([id, state]) => [Number(id), state]),
);
const MANAGED_RUNTIME_STATE_FILE = '/root/.openclaw/managed-runtime-health.json';
const managedRuntimeChecks = new Map(
  Object.entries(readJsonFile(MANAGED_RUNTIME_STATE_FILE, {})).map(([id, state]) => [Number(id), state]),
);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8731741557:AAFjdZjoXrcCdZPTHiJFjCjuo2ZRtOYP8YE';
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID  || '652689793';
const DISK_MONITOR_PATH = process.env.DISK_MONITOR_PATH || '/';
const DISK_WARNING_PERCENT = Number(process.env.DISK_WARNING_PERCENT || 80);
const DISK_CRITICAL_PERCENT = Number(process.env.DISK_CRITICAL_PERCENT || 90);
const DISK_EMERGENCY_PERCENT = Number(process.env.DISK_EMERGENCY_PERCENT || 95);
const DISK_MONITOR_INTERVAL_MS = Number(process.env.DISK_MONITOR_INTERVAL_MS || 300000);
const DISK_ALERT_REMINDER_MS = Number(process.env.DISK_ALERT_REMINDER_MS || 21600000);
const DISK_HEALTH_STATE_FILE = '/root/.openclaw/disk-health.json';
const CRON_HEALTH_MONITOR_INTERVAL_MS = Number(process.env.CRON_HEALTH_MONITOR_INTERVAL_MS || 60000);
const CRON_HEALTH_LATE_GRACE_MS = Number(process.env.CRON_HEALTH_LATE_GRACE_MS || 300000);
const CRON_HEALTH_STUCK_MS = Number(process.env.CRON_HEALTH_STUCK_MS || 900000);
const CRON_HEALTH_ALERT_REMINDER_MS = Number(process.env.CRON_HEALTH_ALERT_REMINDER_MS || 21600000);
const CRON_HEALTH_STATE_FILE = '/root/.openclaw/cron-health.json';

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const WORKSPACE_FILES = new Set([
  'SOUL.md',
  'USER.md',
  'AGENTS.md',
  'MEMORY.md',
  'IDENTITY.md',
  'HEARTBEAT.md',
]);

const VALID_ASSISTANT_TYPES = [
  'finance', 'health', 'admin', 'career', 'religious',
  'parenting', 'kitchen', 'vehicle', 'creator', 'affiliate', 'coding', 'custom',
];

// Accepts root-level WORKSPACE_FILES and one-level subfolder paths like keuangan/AGENTS.md
function isAllowedWorkspaceFile(file) {
  if (!file || typeof file !== 'string') return false;
  if (path.isAbsolute(file) || file.includes('..')) return false;
  const normalized = file.replace(/\\/g, '/');
  if (WORKSPACE_FILES.has(normalized)) return true;
  const parts = normalized.split('/');
  if (parts.length !== 2) return false;
  const [folder, filename] = parts;
  if (!/^[a-z][a-z0-9_-]*$/.test(folder)) return false;
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return false;
  return true;
}

function openClawEnv(paths) {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configPath,
    CODEX_HOME: paths.codexHome,
    HOME: paths.home,
  };
}

function run(cmd, options = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 60000, ...options }).trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function execOpenClawAfterGatewayReady(args, options = {}) {
  let lastError;
  // A full OpenClaw config reload can take 25-30 seconds on the shared VPS.
  // Keep retrying transient websocket startup failures within the caller's
  // 60-second HTTP budget instead of failing cron sync after only 16 seconds.
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return execFileSync(NODE_BIN, [OPENCLAW_BIN, ...args], options);
    } catch (error) {
      lastError = error;
      const detail = String(error.stderr || error.message || '');
      const transient = /1006|ECONNREFUSED|not yet ready|closed before connect/i.test(detail);
      if (!transient || attempt === maxAttempts) throw error;
      sleepSync(2000);
    }
  }
  throw lastError;
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function diskAlertLevel(percent) {
  if (percent >= DISK_EMERGENCY_PERCENT) return 'emergency';
  if (percent >= DISK_CRITICAL_PERCENT) return 'critical';
  if (percent >= DISK_WARNING_PERCENT) return 'warning';
  return 'healthy';
}

function monitorDisk() {
  const stats = fs.statfsSync(DISK_MONITOR_PATH, { bigint: true });
  const totalBytes = stats.bsize * stats.blocks;
  const availableBytes = stats.bsize * stats.bavail;
  const usedBytes = totalBytes - availableBytes;
  const usagePercent = totalBytes > 0n ? Number((usedBytes * 1000n) / totalBytes) / 10 : 0;
  const inodeUsagePercent = stats.files > 0n
    ? Number(((stats.files - stats.ffree) * 1000n) / stats.files) / 10
    : 0;
  const pressurePercent = Math.max(usagePercent, inodeUsagePercent);
  const level = diskAlertLevel(pressurePercent);
  const now = Date.now();
  const previous = readJsonFile(DISK_HEALTH_STATE_FILE, {
    level: 'healthy',
    last_alert_at_ms: 0,
    first_seen_at: null,
  });
  const changed = previous.level !== level;
  const reminderDue = level !== 'healthy'
    && now - Number(previous.last_alert_at_ms || 0) >= DISK_ALERT_REMINDER_MS;
  let lastAlertAtMs = Number(previous.last_alert_at_ms || 0);
  let firstSeenAt = previous.first_seen_at || null;

  if (level === 'healthy' && previous.level !== 'healthy') {
    sendTelegram(
      `✅ <b>Disk host pulih</b>\n`
      + `Host: <code>${os.hostname()}</code>\n`
      + `Mount: <code>${DISK_MONITOR_PATH}</code>\n`
      + `Disk: <code>${usagePercent.toFixed(1)}%</code> (${formatBytes(availableBytes)} tersedia)\n`
      + `Inode: <code>${inodeUsagePercent.toFixed(1)}%</code>`,
    );
    lastAlertAtMs = now;
    firstSeenAt = null;
  } else if (level !== 'healthy' && (changed || reminderDue)) {
    const icon = level === 'emergency' ? '🆘' : (level === 'critical' ? '🚨' : '⚠️');
    if (changed || !firstSeenAt) firstSeenAt = new Date().toISOString();
    sendTelegram(
      `${icon} <b>Disk ${level.toUpperCase()}</b>\n`
      + `Host: <code>${os.hostname()}</code>\n`
      + `Mount: <code>${DISK_MONITOR_PATH}</code>\n`
      + `Disk: <code>${usagePercent.toFixed(1)}%</code> (${formatBytes(availableBytes)} tersedia)\n`
      + `Inode: <code>${inodeUsagePercent.toFixed(1)}%</code>\n`
      + `Threshold: warning ${DISK_WARNING_PERCENT}% · critical ${DISK_CRITICAL_PERCENT}% · emergency ${DISK_EMERGENCY_PERCENT}%\n`
      + `Cleanup otomatis: <code>disabled</code>`,
    );
    lastAlertAtMs = now;
  }

  writeJsonFileAtomic(DISK_HEALTH_STATE_FILE, {
    level,
    path: DISK_MONITOR_PATH,
    usage_percent: usagePercent,
    inode_usage_percent: inodeUsagePercent,
    total_bytes: totalBytes.toString(),
    available_bytes: availableBytes.toString(),
    first_seen_at: firstSeenAt,
    last_checked_at: new Date().toISOString(),
    last_alert_at_ms: lastAlertAtMs,
  });
}

function cronRuntimeSources() {
  const sources = [];
  for (const name of discoverClients()) {
    const paths = clientPaths(name);
    sources.push({ key: `client:${name}`, label: name, stateDir: paths.stateDir });
  }

  const managedRoot = '/root/.openclaw/managed-accounts';
  if (fs.existsSync(managedRoot)) {
    for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
      const serviceName = `openclaw-managed-${entry.name}-gateway.service`;
      const serviceActive = run(`systemctl is-active ${quote(serviceName)} 2>/dev/null; true`).trim() === 'active';
      if (!serviceActive) continue;
      sources.push({
        key: `managed:${entry.name}`,
        label: `managed-${entry.name}`,
        stateDir: path.join(managedRoot, entry.name),
      });
    }
  }

  return sources.filter((source, index, all) =>
    all.findIndex((candidate) => candidate.stateDir === source.stateDir) === index
  );
}

function removeManagedClientCronJobs(accountId, clientName) {
  if (!validName(clientName)) throw new Error('Invalid client name');
  const databasePath = path.join(managedAccountPaths(accountId).stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(databasePath)) return 0;

  const database = new DatabaseSync(databasePath, { open: true });
  try {
    database.exec('BEGIN IMMEDIATE');
    const jobs = database.prepare('SELECT store_key, job_id FROM cron_jobs WHERE name LIKE ? ESCAPE \'\\\'')
      .all(`${clientName.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}\\_\\_%`);
    const deleteLogs = database.prepare('DELETE FROM cron_run_logs WHERE job_id = ?');
    const deleteJob = database.prepare('DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?');
    for (const job of jobs) {
      deleteLogs.run(job.job_id);
      deleteJob.run(job.store_key, job.job_id);
    }
    database.exec('COMMIT');
    return jobs.length;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function readCronHealthRows(source) {
  const databasePath = path.join(source.stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    return database.prepare(
      `SELECT job_id, name, next_run_at_ms, running_at_ms, last_run_at_ms,
              last_run_status, last_error, last_duration_ms, consecutive_errors,
              consecutive_skipped, last_delivery_status, last_delivery_error
       FROM cron_jobs
       WHERE enabled = 1`,
    ).all();
  } finally {
    database.close();
  }
}

function cronHealthIssue(row, now) {
  const runningAt = Number(row.running_at_ms || 0);
  if (runningAt > 0 && now - runningAt > CRON_HEALTH_STUCK_MS) {
    return {
      kind: 'stuck',
      fingerprint: `stuck:${runningAt}`,
      detail: `masih berjalan selama ${Math.floor((now - runningAt) / 60000)} menit`,
    };
  }

  const nextRunAt = Number(row.next_run_at_ms || 0);
  if (!runningAt && nextRunAt > 0 && now - nextRunAt > CRON_HEALTH_LATE_GRACE_MS) {
    return {
      kind: 'late',
      fingerprint: `late:${nextRunAt}`,
      detail: `terlambat ${Math.floor((now - nextRunAt) / 60000)} menit`,
    };
  }

  const runStatus = String(row.last_run_status || '').toLowerCase();
  if (runStatus && !['ok', 'success'].includes(runStatus)) {
    const error = String(row.last_error || runStatus).slice(0, 300);
    return {
      kind: 'execution_failed',
      fingerprint: `execution:${Number(row.last_run_at_ms || 0)}:${runStatus}`,
      detail: error,
    };
  }

  const deliveryStatus = String(row.last_delivery_status || '').toLowerCase();
  if (['failed', 'error'].includes(deliveryStatus)) {
    const error = String(row.last_delivery_error || deliveryStatus).slice(0, 300);
    return {
      kind: 'delivery_failed',
      fingerprint: `delivery:${Number(row.last_run_at_ms || 0)}:${deliveryStatus}`,
      detail: error,
    };
  }

  return null;
}

function monitorCronHealth() {
  const now = Date.now();
  const previous = readJsonFile(CRON_HEALTH_STATE_FILE, { issues: {} });
  const previousIssues = previous.issues && typeof previous.issues === 'object' ? previous.issues : {};
  const currentIssues = {};
  const scannedSources = [];

  for (const source of cronRuntimeSources()) {
    try {
      const rows = readCronHealthRows(source);
      scannedSources.push(source.key);
      for (const row of rows) {
        const issue = cronHealthIssue(row, now);
        if (!issue) continue;
        const key = `${source.key}:${row.job_id}`;
        const old = previousIssues[key] || {};
        const isNew = old.fingerprint !== issue.fingerprint;
        const reminderDue = now - Number(old.last_alert_at_ms || 0) >= CRON_HEALTH_ALERT_REMINDER_MS;
        let lastAlertAtMs = Number(old.last_alert_at_ms || 0);

        if (isNew || reminderDue) {
          sendTelegram(
            `🚨 <b>Cron ${escapeTelegramHtml(issue.kind)}</b>\n`
            + `Host: <code>${escapeTelegramHtml(os.hostname())}</code>\n`
            + `Runtime: <code>${escapeTelegramHtml(source.label)}</code>\n`
            + `Job: <code>${escapeTelegramHtml(row.name)}</code>\n`
            + `Detail: <code>${escapeTelegramHtml(issue.detail)}</code>\n`
            + `Consecutive errors: <code>${Number(row.consecutive_errors || 0)}</code>`,
          );
          lastAlertAtMs = now;
        }

        currentIssues[key] = {
          source: source.key,
          runtime: source.label,
          job_id: String(row.job_id),
          job_name: String(row.name),
          kind: issue.kind,
          fingerprint: issue.fingerprint,
          first_seen_at: isNew ? new Date(now).toISOString() : (old.first_seen_at || new Date(now).toISOString()),
          last_seen_at: new Date(now).toISOString(),
          last_alert_at_ms: lastAlertAtMs,
        };
      }
    } catch (error) {
      console.error(`Cron health scan failed for ${source.key}: ${error.message}`);
    }
  }

  for (const [key, old] of Object.entries(previousIssues)) {
    if (currentIssues[key] || !scannedSources.includes(old.source)) continue;
    sendTelegram(
      `✅ <b>Cron pulih</b>\n`
      + `Host: <code>${escapeTelegramHtml(os.hostname())}</code>\n`
      + `Runtime: <code>${escapeTelegramHtml(old.runtime)}</code>\n`
      + `Job: <code>${escapeTelegramHtml(old.job_name)}</code>\n`
      + `Masalah sebelumnya: <code>${escapeTelegramHtml(old.kind)}</code>`,
    );
  }

  writeJsonFileAtomic(CRON_HEALTH_STATE_FILE, {
    issues: currentIssues,
    scanned_sources: scannedSources,
    last_checked_at: new Date(now).toISOString(),
  });
}

function removeLegacyGeneratedAgentsPolicy(content) {
  const normalized = String(content || '').trim();
  if (!normalized) return '';

  // Old backend-generated AGENTS.md files are policy snapshots, not user
  // memory. They remain recoverable in workspace-backups, but must not stay in
  // the active prompt after a plan upgrade because stale plan/cron limits can
  // conflict with the new authoritative managed block.
  const generatedPolicyMarkers = [
    '# Kemampuan Agent',
    'Paket:',
    'Cron bawaan:',
    'Cron tambahan:',
    '## Asisten Aktif',
    '## Kemampuan Umum',
    '# Batas Akses Direktori',
    '# Kebijakan',
  ];
  if (generatedPolicyMarkers.every((marker) => normalized.includes(marker))) {
    return '';
  }

  return normalized;
}

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function whatsappSessionIdentity(credsDir) {
  const creds = readJsonFile(path.join(credsDir, 'creds.json'), null);
  const rawId = creds?.me?.id || '';
  const phone = normalizePhone(rawId.split(':')[0].split('@')[0]);
  return {
    credentials_exist: Boolean(creds),
    session_phone: phone ? `+${phone}` : null,
    session_name: creds?.me?.name || null,
  };
}

function modelPoolPaths(accountId) {
  const base = path.join('/root/.openclaw/model-pool', String(accountId));
  return {
    base,
    stateDir: base,
    configPath: path.join(base, 'openclaw.json'),
    workspaceDir: path.join(base, 'workspace'),
    codexHome: path.join(base, '.codex'),
    sqlitePath: path.join(base, 'agents/main/agent/openclaw-agent.sqlite'),
    jobsDir: path.join(base, 'sync-jobs'),
    backupsDir: path.join(base, 'auth-backups'),
  };
}

function ensureModelPool(accountId) {
  const paths = modelPoolPaths(accountId);
  for (const dir of [paths.base, paths.workspaceDir, paths.codexHome, paths.jobsDir, paths.backupsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(paths.configPath)) {
    fs.writeFileSync(paths.configPath, JSON.stringify({
      agents: { defaults: { workspace: paths.workspaceDir, model: { primary: 'openai/gpt-5.5', fallbacks: [] }, models: { 'openai/gpt-5.5': {} } } },
      plugins: { allow: ['openai'], bundledDiscovery: 'compat', entries: { openai: { enabled: true } } },
    }, null, 2) + '\n', { mode: 0o600 });
  }
  return paths;
}

function modelPoolEnv(paths) {
  return { ...process.env, HOME: '/root', OPENCLAW_STATE_DIR: paths.stateDir, OPENCLAW_CONFIG_PATH: paths.configPath, CODEX_HOME: paths.codexHome, TERM: 'xterm-256color' };
}

function readModelPoolProfiles(accountId) {
  const paths = ensureModelPool(accountId);
  if (!fs.existsSync(paths.sqlitePath)) return [];
  try {
    const raw = execFileSync('python3', [MODEL_POOL_SCRIPT, 'list', '--db', paths.sqlitePath], { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(raw).profiles || [];
  } catch {
    return [];
  }
}

function checkModelPoolHealth(accountId, profiles = readModelPoolProfiles(accountId)) {
  if (!profiles.length) return { checked: true, ok: false, status: 'not_logged', error_category: null };
  const paths = ensureModelPool(accountId);
  try {
    execFileSync(NODE_BIN, [OPENCLAW_BIN, 'models', 'status', '--check', '--json'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, env: modelPoolEnv(paths),
    });
    return { checked: true, ok: true, status: 'active', error_category: null };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '');
    const category = /invalid_refresh|authentication|unauthorized|expired/i.test(detail)
      ? 'model_auth_expired'
      : (/rate.?limit/i.test(detail) ? 'model_rate_limit' : 'model_check_failed');
    return { checked: true, ok: false, status: 'expired', error_category: category };
  }
}

async function monitorModelPools() {
  const root = '/root/.openclaw/model-pool';
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const accountId = Number(entry);
    if (!Number.isInteger(accountId)) continue;
    const profiles = readModelPoolProfiles(accountId);
    if (!profiles.length) continue;
    const health = checkModelPoolHealth(accountId, profiles);
    const previous = modelPoolHealthChecks.get(accountId);
    modelPoolHealthChecks.set(accountId, { ok: health.ok, error_category: health.error_category });
    if ((!health.ok && previous?.ok !== false) || (!health.ok && previous?.error_category !== health.error_category)) {
      sendTelegram(`⚠️ <b>ChatGPT Pool #${accountId} bermasalah</b>\nPenyebab: <code>${health.error_category || 'unknown'}</code>\nClient yang memakai pool ini mungkin gagal membalas.`);
    } else if (health.ok && previous?.ok === false) {
      sendTelegram(`✅ <b>ChatGPT Pool #${accountId} pulih</b>\nModel auth kembali valid.`);
    }
  }
  fs.writeFileSync(MODEL_POOL_HEALTH_STATE_FILE, JSON.stringify(Object.fromEntries(modelPoolHealthChecks), null, 2) + '\n', { mode: 0o600 });
}

function sanitizeTerminalOutput(value) {
  return String(value || '')
    .replace(/(access|refresh|token|secret)[=:]\s*[^\s]+/gi, '$1=<redacted>')
    .replace(/([?&]code=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_]/g, '')
    .replace(/\r/g, '');
}

function writeModelPoolJob(paths, job) {
  const safe = { ...job };
  delete safe.promise;
  fs.writeFileSync(path.join(paths.jobsDir, `${job.id}.json`), JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
}

function recoverInterruptedModelPoolJobs() {
  const root = '/root/.openclaw/model-pool';
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const accountId = Number(entry);
    if (!Number.isInteger(accountId)) continue;
    const paths = modelPoolPaths(accountId);
    if (!fs.existsSync(paths.jobsDir)) continue;
    for (const file of fs.readdirSync(paths.jobsDir).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))) {
      const target = path.join(paths.jobsDir, file);
      const job = readJsonFile(target, null);
      if (!job || job.status !== 'running') continue;
      job.status = 'failed';
      job.finished_at = new Date().toISOString();
      job.error = 'VPS API restarted before this job completed; retry failed clients.';
      fs.writeFileSync(target, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
    }
  }
}

async function syncModelPoolClient(accountId, profileId, clientName, replaceExisting) {
  if (!validName(clientName)) return { client: clientName, ok: false, error: 'Invalid client name' };
  if (!getClientConfig(clientName)) return { client: clientName, ok: false, error: 'Client not found or deleted' };
  if (modelPoolClientsInFlight.has(clientName)) return { client: clientName, ok: false, error: 'Client is already being synced by another model-pool job' };
  modelPoolClientsInFlight.add(clientName);
  const source = ensureModelPool(accountId);
  const target = clientPaths(clientName);
  const sqlitePath = path.join(target.stateDir, 'agents/main/agent/openclaw-agent.sqlite');
  const scope = target.serviceScope === 'system' ? '' : '--user ';
  try {
    try { run(`systemctl ${scope}stop ${quote(target.serviceName)} 2>/dev/null || true`); } catch {}
    const args = [MODEL_POOL_SCRIPT, 'sync', '--source', source.sqlitePath, '--target', sqlitePath, '--profile-id', profileId];
    if (replaceExisting) args.push('--replace');
    const raw = execFileSync('python3', args, { encoding: 'utf8', timeout: 30000 });
    const result = JSON.parse(raw);
    if (!result.ok) throw new Error(result.error || 'Profile sync failed');
    chownTreeIfHome(target, path.dirname(sqlitePath));
    try { run(`systemctl ${scope}start ${quote(target.serviceName)}`); } catch {}
    let modelAuthOk = false;
    let verifyError = null;
    try {
      execFileSync(NODE_BIN, [OPENCLAW_BIN, 'models', 'status', '--check', '--json'], {
        encoding: 'utf8', timeout: 60000, env: openClawEnv(target),
      });
      modelAuthOk = true;
    } catch (error) {
      verifyError = String(error.stderr || error.stdout || error.message || '').trim().slice(0, 1000);
    }
    return {
      ...result,
      client: clientName,
      ok: modelAuthOk,
      synced: true,
      model_auth_ok: modelAuthOk,
      service_status: getServiceStatus(clientName),
      ...(modelAuthOk ? {} : { error: `Profile copied but model verification failed: ${verifyError}` }),
    };
  } catch (error) {
    try { run(`systemctl ${scope}start ${quote(target.serviceName)} 2>/dev/null || true`); } catch {}
    return { client: clientName, ok: false, error: String(error.stderr || error.message || '').trim().slice(0, 1000) };
  } finally {
    modelPoolClientsInFlight.delete(clientName);
  }
}

function classifyWhatsAppError(value) {
  const error = String(value || '');
  if (/401|unauthorized|logged out/i.test(error)) return 'auth_logged_out';
  if (/timed?out|ETIMEDOUT/i.test(error)) return 'network_timeout';
  if (/ECONN|ENOTFOUND|network/i.test(error)) return 'network_error';
  return error ? 'channel_error' : null;
}

function persistManagedRuntimeChecks() {
  fs.mkdirSync(path.dirname(MANAGED_RUNTIME_STATE_FILE), { recursive: true });
  fs.writeFileSync(MANAGED_RUNTIME_STATE_FILE, JSON.stringify(Object.fromEntries(managedRuntimeChecks), null, 2) + '\n');
}

function getManagedChannelRuntime(accountId) {
  const paths = managedAccountPaths(accountId);
  const config = readJsonFile(paths.configPath, {});
  const port = Number(config.gateway?.port || 0);
  const token = config.gateway?.auth?.token;
  if (!port || !token) {
    return Promise.resolve({ checked: false, connected: false, running: false, health_state: 'not-configured', error_category: 'gateway_not_configured' });
  }

  return new Promise(resolve => {
    execFile(NODE_BIN, [OPENCLAW_BIN, 'channels', 'status', '--json', '--url', `ws://127.0.0.1:${port}`, '--token', token], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: '/root', OPENCLAW_STATE_DIR: paths.base, OPENCLAW_CONFIG_PATH: paths.configPath, CODEX_HOME: '/root/.codex' },
    }, (error, stdout) => {
      let parsed = {};
      try { parsed = JSON.parse(String(stdout || '').trim()); } catch {}
      const channel = parsed.channels?.whatsapp || parsed.channelAccounts?.whatsapp?.[0] || {};
      let lastError = channel.lastError || parsed.error || error?.message || null;
      let gatewayLogs = '';
      if (channel.connected !== true) {
        try {
          // Read enough of the current gateway lifecycle to support stable
          // channels that have not emitted a fresh "Listening" line recently.
          // Ordering matters: a later disconnect still wins over an older
          // Listening event.
          gatewayLogs = run(`journalctl -u ${quote(paths.serviceName)} --since '-24 hours' --no-pager -n 500 2>/dev/null; true`, { timeout: 5000 });
          if (!lastError) {
            lastError = gatewayLogs.split('\n')
              .filter(line => /401|unauthorized|logged out|connection failure|ETIMEDOUT|ECONN/i.test(line))
              .at(-1) || null;
          }
        } catch {}
      }
      const lastListening = gatewayLogs.lastIndexOf('Listening for WhatsApp inbound messages');
      const lastDisconnect = Math.max(
        gatewayLogs.lastIndexOf('Web connection closed'),
        gatewayLogs.lastIndexOf('channel exited'),
        gatewayLogs.lastIndexOf('logged out'),
      );
      const logFallbackConnected = Boolean(error)
        && lastListening >= 0
        && lastListening > lastDisconnect;
      const connected = channel.connected === true || logFallbackConnected;
      resolve({
        checked: true,
        connected,
        running: channel.running === true || logFallbackConnected,
        linked: channel.linked === true || channel.statusState === 'linked' || logFallbackConnected,
        health_state: channel.healthState || (connected ? 'healthy' : 'disconnected'),
        status_source: logFallbackConnected ? 'gateway_log_fallback' : 'channels_status',
        last_connected_at: channel.lastConnectedAt || null,
        last_inbound_at: channel.lastInboundAt || null,
        last_message_at: channel.lastMessageAt || null,
        error_category: connected ? null : classifyWhatsAppError(lastError),
        last_error: connected ? null : (lastError ? String(lastError).slice(0, 500) : null),
      });
    });
  });
}

function getManagedModelRuntime(serviceName) {
  let logs = '';
  try {
    logs = run(`journalctl -u ${quote(serviceName)} --since '-15 minutes' --no-pager -n 160 2>/dev/null; true`, { timeout: 10000 });
  } catch {}
  const lines = logs.split('\n').filter(line => /invalid_refresh|authentication_error|all models failed|provider auth|rate.?limit|model.*error/i.test(line));
  const lastError = lines.at(-1) || null;
  let errorCategory = null;
  if (/invalid_refresh|authentication_error|provider auth/i.test(lastError || '')) errorCategory = 'model_auth_error';
  else if (/rate.?limit/i.test(lastError || '')) errorCategory = 'model_rate_limit';
  else if (/all models failed|model.*error/i.test(lastError || '')) errorCategory = 'model_runtime_error';
  return {
    checked: true,
    status: errorCategory ? 'error' : 'no_recent_error',
    error_category: errorCategory,
    last_error: lastError ? lastError.slice(0, 500) : null,
    window_minutes: 15,
  };
}

let managedWhatsAppMonitorInFlight = false;

async function monitorManagedWhatsApp() {
  if (managedWhatsAppMonitorInFlight) return;
  managedWhatsAppMonitorInFlight = true;
  const managedRoot = '/root/.openclaw/managed-accounts';
  try {
    if (!fs.existsSync(managedRoot)) return;
    for (const entry of fs.readdirSync(managedRoot)) {
      const accountId = Number(entry);
      if (!Number.isInteger(accountId)) continue;
      const paths = managedAccountPaths(accountId);
      const identity = whatsappSessionIdentity(paths.credsDir);
      if (!identity.credentials_exist) continue;
      const serviceActive = run(`systemctl is-active ${quote(paths.serviceName)} 2>/dev/null; true`).trim() === 'active';
      if (!serviceActive) continue;
      const runtime = await getManagedChannelRuntime(accountId);
      const model = getManagedModelRuntime(paths.serviceName);
      const previous = managedRuntimeChecks.get(accountId);
      managedRuntimeChecks.set(accountId, { connected: runtime.connected, model_error: model.error_category });
      persistManagedRuntimeChecks();
      if (previous === undefined && !runtime.connected) {
        sendTelegram(`🚨 <b>Managed WhatsApp #${accountId} terputus</b>\nNomor: <code>${identity.session_phone || '-'}</code>\nStatus: <code>${runtime.health_state}</code>\nPenyebab: <code>${runtime.error_category || 'unknown'}</code>\nBuka Managed WA Account, lepas session, lalu pair ulang bila status menunjukkan auth_logged_out.`);
      } else if (previous?.connected === true && !runtime.connected) {
        sendTelegram(`🚨 <b>Managed WhatsApp #${accountId} baru saja terputus</b>\nNomor: <code>${identity.session_phone || '-'}</code>\nPenyebab: <code>${runtime.error_category || 'unknown'}</code>`);
      } else if (previous?.connected === false && runtime.connected) {
        sendTelegram(`✅ <b>Managed WhatsApp #${accountId} pulih</b>\nNomor: <code>${identity.session_phone || '-'}</code>\nChannel kembali connected.`);
      }
      if (model.error_category && previous?.model_error !== model.error_category) {
        sendTelegram(`⚠️ <b>Model/provider error pada managed bot #${accountId}</b>\nNomor: <code>${identity.session_phone || '-'}</code>\nPenyebab: <code>${model.error_category}</code>\nWhatsApp: <code>${runtime.connected ? 'connected' : 'disconnected'}</code>`);
      } else if (!model.error_category && previous?.model_error) {
        sendTelegram(`✅ <b>Model/provider managed bot #${accountId} pulih</b>\nTidak ada error baru dalam 15 menit terakhir.`);
      }
    }
  } finally {
    managedWhatsAppMonitorInFlight = false;
  }
}

function configuredGatewayPorts(excludeManagedAccountId = null) {
  const ports = new Map();
  for (const name of discoverClients()) {
    const port = Number(getClientConfig(name)?.gateway?.port || 0);
    if (port) ports.set(port, `client:${name}`);
  }

  const managedRoot = '/root/.openclaw/managed-accounts';
  if (fs.existsSync(managedRoot)) {
    for (const entry of fs.readdirSync(managedRoot)) {
      const id = Number(entry);
      if (!Number.isInteger(id) || id === excludeManagedAccountId) continue;
      const config = readJsonFile(path.join(managedRoot, entry, 'openclaw.json'), {});
      const port = Number(config.gateway?.port || 0);
      if (port) ports.set(port, `managed:${id}`);
    }
  }
  return ports;
}

function resolveManagedGatewayPort(accountId, requestedPort, existingPort) {
  const used = configuredGatewayPorts(accountId);
  const persisted = Number(requestedPort || existingPort || 0);
  if (persisted) {
    const owner = used.get(persisted);
    if (owner) throw new Error(`Gateway port ${persisted} already used by ${owner}`);
    return persisted;
  }

  let candidate = 21000 + accountId * 20;
  while (used.has(candidate) && candidate <= 65515) candidate += 20;
  if (candidate > 65535) throw new Error('No managed gateway port available');
  return candidate;
}

function runAsync(cmd, res, options = {}) {
  exec(cmd, { encoding: 'utf8', timeout: 120000, ...options }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ ok: false, error: error.message, stderr: String(stderr || '').trim(), stdout: String(stdout || '').trim() });
    }
    res.json({ ok: true, success: true, output: String(stdout || '').trim() });
  });
}

function validName(name) {
  return /^[a-z][a-z0-9_-]*$/.test(String(name || ''));
}

function clientPaths(name) {
  const linuxUser = `openclaw-${name}`;
  const homeBase = `/home/${linuxUser}`;
  const legacyState = `/root/.openclaw-${name}`;
  const legacyWorkspace = `/root/.openclaw/workspace-${name}`;
  const legacyConfig = `${legacyState}/openclaw.json`;
  const homeConfig = `${homeBase}/.openclaw/openclaw.json`;

  if (fs.existsSync(legacyConfig)) {
    return {
      layout: 'legacy-root',
      linuxUser,
      home: '/root',
      stateDir: legacyState,
      workspaceDir: legacyWorkspace,
      codexHome: `/root/.codex-${name}`,
      configPath: legacyConfig,
      serviceName: `openclaw-${name}-gateway.service`,
      serviceScope: 'user',
    };
  }

  if (fs.existsSync(homeConfig)) {
    return {
      layout: 'home',
      linuxUser,
      home: homeBase,
      stateDir: `${homeBase}/.openclaw`,
      workspaceDir: `${homeBase}/workspace`,
      codexHome: `${homeBase}/.codex`,
      configPath: homeConfig,
      serviceName: `openclaw-${name}-gateway.service`,
      serviceScope: 'system',
    };
  }

  return {
    layout: 'legacy-root',
    linuxUser,
    home: '/root',
    stateDir: legacyState,
    workspaceDir: legacyWorkspace,
    codexHome: `/root/.codex-${name}`,
    configPath: legacyConfig,
    serviceName: `openclaw-${name}-gateway.service`,
    serviceScope: 'user',
  };
}

function getClientConfig(name) {
  const paths = clientPaths(name);
  if (!fs.existsSync(paths.configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeClientConfig(name, config) {
  const paths = clientPaths(name);
  fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2) + '\n');
  chownIfHome(paths, paths.configPath);
}

function getServiceStatus(name) {
  const paths = clientPaths(name);
  try {
    if (paths.serviceScope === 'system') {
      return run(`systemctl is-active --quiet ${paths.serviceName} 2>/dev/null && echo active || echo inactive`);
    }
    return run(`systemctl --user is-active --quiet ${paths.serviceName} 2>/dev/null && echo active || echo inactive`);
  } catch {
    return 'unknown';
  }
}

function restartClientService(name) {
  const paths = clientPaths(name);
  if (paths.serviceScope === 'system') {
    run(`systemctl restart ${paths.serviceName}`);
  } else {
    run(`systemctl --user restart ${paths.serviceName}`);
  }
}

function reloadClientService(name) {
  const paths = clientPaths(name);
  run(`touch ${quote(paths.configPath)}`);
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function chownIfHome(paths, target) {
  if (paths.layout !== 'home') return;
  try {
    run(`chown ${quote(paths.linuxUser)}:${quote(paths.linuxUser)} ${quote(target)}`);
  } catch {
    // Non-fatal for existing files; callers still return the write result.
  }
}

function chownTreeIfHome(paths, target) {
  if (paths.layout !== 'home') return;
  try {
    run(`chown -R ${quote(paths.linuxUser)}:${quote(paths.linuxUser)} ${quote(target)}`);
  } catch {
    // Non-fatal for API response. The setup checklist will catch ownership issues.
  }
}

function ensureCronLimitPlugin(paths) {
  const target = path.join(paths.stateDir, 'managed-plugins', 'cron-limit');
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['package.json', 'openclaw.plugin.json', 'index.js', 'policy.js']) {
    const destination = path.join(target, file);
    fs.copyFileSync(path.join(CRON_LIMIT_PLUGIN_SOURCE, file), destination);
    fs.chownSync(destination, 0, 0);
    fs.chmodSync(destination, 0o644);
  }
  fs.chownSync(target, 0, 0);
  fs.chmodSync(target, 0o755);
  return target;
}

function discoverClients() {
  const names = new Set();

  if (fs.existsSync('/home')) {
    for (const entry of fs.readdirSync('/home')) {
      if (!entry.startsWith('openclaw-')) continue;
      const name = entry.replace(/^openclaw-/, '');
      if (validName(name) && fs.existsSync(`/home/${entry}/.openclaw/openclaw.json`)) names.add(name);
    }
  }

  for (const entry of fs.readdirSync('/root')) {
    if (!entry.startsWith('.openclaw-')) continue;
    const name = entry.replace(/^\.openclaw-/, '');
    if (validName(name) && fs.existsSync(`/root/${entry}/openclaw.json`)) names.add(name);
  }

  return [...names].sort();
}

function extractClient(config, name) {
  const paths = clientPaths(name);
  const wa = config.channels?.whatsapp || {};
  const firstAgent = config.agents?.list?.[0] || {};
  const groupAllowFrom = wa.groupAllowFrom || [];
  const configuredScope = config.meta?.scopePackage || config.meta?.scope_package;

  return {
    name,
    trigger: firstAgent.groupChat?.mentionPatterns?.[0] || '',
    phone: wa.allowFrom?.[0] === '*'
      ? (whatsappSessionIdentity(path.join(paths.stateDir, 'credentials/whatsapp/default')).session_phone || '')
      : (wa.allowFrom?.[0] || ''),
    port: config.gateway?.port,
    scope_package: ['personal', 'team'].includes(configuredScope)
      ? configuredScope
      : (groupAllowFrom.includes('*') ? 'team' : 'personal'),
    plan: config.meta?.plan || null,
    assistant_type: config.meta?.assistantType || config.meta?.assistant_type || 'custom',
    service_status: getServiceStatus(name),
    layout: paths.layout,
    linux_user: paths.linuxUser,
    state_dir: paths.stateDir,
    workspace_dir: paths.workspaceDir,
    codex_home: paths.codexHome,
    workspace: paths.workspaceDir,
  };
}

function buildConfigFromDashboard(name, payload, existing = {}) {
  const paths = clientPaths(name);
  const waMode = payload.wa_mode || existing.meta?.waMode || 'client_number_bot';
  const existingConfig = { ...existing };
  delete existingConfig.meta;
  const trigger = payload.trigger || existing.agents?.list?.[0]?.groupChat?.mentionPatterns?.[0] || 'Hey';
  const port = Number(payload.server_port || existing.gateway?.port || 0) || undefined;
  const allowFrom = Array.isArray(payload.allowFrom) ? payload.allowFrom : (existing.channels?.whatsapp?.allowFrom || []);
  const groups = {};

  for (const group of payload.groups || []) {
    if (!group.group_wa_id) continue;
    groups[group.group_wa_id] = {
      name: group.name || group.group_name || '',
      requireMention: group.requireMention !== false,
      allowFrom: Array.isArray(group.groupAllowFrom) ? group.groupAllowFrom : undefined,
      assistantSlot: group.slot || group.assistantSlot || 1,
    };
  }

  const model = payload.primary_model || existing.agents?.defaults?.model?.primary || 'openai/gpt-5.5';
  const fallbacks = [];
  const cronPolicy = payload.cron_policy || {};
  const maxCronTotal = Number(cronPolicy.max_total);
  const defaultCronCount = Number(cronPolicy.default_count);
  const additionalCronLimit = Number(cronPolicy.additional_limit);
  const maxConcurrentCronRuns = Number(cronPolicy.max_concurrent_runs);
  const minCronGapMinutes = Number(cronPolicy.min_gap_minutes);
  if (!Number.isInteger(maxCronTotal) || maxCronTotal < 0 || maxCronTotal > 500
      || !Number.isInteger(defaultCronCount) || defaultCronCount < 0
      || !Number.isInteger(additionalCronLimit) || additionalCronLimit < 0
      || !Number.isInteger(maxConcurrentCronRuns) || maxConcurrentCronRuns < 1 || maxConcurrentCronRuns > 32
      || !Number.isInteger(minCronGapMinutes) || minCronGapMinutes < 0 || minCronGapMinutes > 60
      || maxCronTotal !== defaultCronCount + additionalCronLimit) {
    throw new Error('cron_policy must contain valid quota and concurrency settings');
  }
  const cronLimitPluginPath = ensureCronLimitPlugin(paths);
  const modelProvider = normalizeDashboardModelProvider(payload.model_provider, model);
  const webSearch = normalizeWebSearchPolicy(payload.web_search);

  const next = {
    ...existingConfig,
    models: singleModelProviderConfig(modelProvider),
    agents: {
      ...(existing.agents || {}),
      defaults: {
        ...(existing.agents?.defaults || {}),
        workspace: payload.workspace_dir || paths.workspaceDir,
        model: {
          primary: model,
          fallbacks,
        },
        models: {
          [model]: {},
        },
      },
      list: [
        {
          id: 'main',
          default: true,
          groupChat: {
            mentionPatterns: [trigger, `@${trigger}`],
          },
        },
      ],
    },
    channels: {
      ...(existing.channels || {}),
      whatsapp: {
        ...(existing.channels?.whatsapp || {}),
        enabled: true,
        dmPolicy: payload.dm_policy || existing.channels?.whatsapp?.dmPolicy || 'allowlist',
        allowFrom,
        groupPolicy: payload.group_policy || existing.channels?.whatsapp?.groupPolicy || 'allowlist',
        groupAllowFrom: Array.isArray(payload.group_allow_from)
          ? payload.group_allow_from
          : inferGlobalGroupAllowFrom(payload.groups || [], allowFrom, existing.channels?.whatsapp?.groupAllowFrom || []),
        groups,
        debounceMs: payload.debounce_ms ?? existing.channels?.whatsapp?.debounceMs ?? 3000,
        sendReadReceipts: Boolean(payload.send_read_receipts),
      },
    },
    gateway: {
      ...(existing.gateway || {}),
      mode: existing.gateway?.mode || 'local',
      port,
      bind: existing.gateway?.bind || 'loopback',
      auth: existing.gateway?.auth || { mode: 'token' },
    },
    session: existing.session || { dmScope: 'per-channel-peer' },
    cron: {
      ...(existing.cron || {}),
      maxConcurrentRuns: maxConcurrentCronRuns,
    },
    tools: {
      ...(existing.tools || { profile: 'coding' }),
      web: {
        search: {
          enabled: true,
          provider: webSearch.provider,
          maxResults: 10,
          timeoutSeconds: 30,
          cacheTtlMinutes: 15,
        },
        fetch: {
          enabled: webSearch.fetchEnabled,
        },
      },
    },
    plugins: {
      ...(existing.plugins || {}),
      allow: [...new Set([...(existing.plugins?.allow || []), 'openai', 'whatsapp', 'parallel', 'heyurassistant-cron-limit'])],
      bundledDiscovery: 'compat',
      load: {
        ...(existing.plugins?.load || {}),
        paths: [...new Set([...(existing.plugins?.load?.paths || []), cronLimitPluginPath])],
      },
      entries: {
        ...(existing.plugins?.entries || {}),
        openai: { enabled: true },
        whatsapp: { enabled: true },
        parallel: { enabled: true },
        'heyurassistant-cron-limit': {
          enabled: true,
            config: {
              maxTotal: maxCronTotal,
              defaultCount: defaultCronCount,
              additionalLimit: additionalCronLimit,
              stateDir: paths.stateDir,
              minGapMinutes: minCronGapMinutes,
            },
        },
      },
    },
  };

  if (waMode === 'managed_group_employee') {
    delete next.channels.whatsapp;
    delete next.plugins.entries.whatsapp;
    next.plugins.allow = next.plugins.allow.filter((id) => id !== 'whatsapp');
  }

  return next;
}

function normalizeWebSearchPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('web_search policy is required');
  }
  if (policy.enabled !== true || policy.provider !== 'parallel-free' || policy.fetch_enabled !== true) {
    throw new Error('web_search must use the managed parallel-free provider with fetch enabled');
  }
  return { provider: 'parallel-free', fetchEnabled: true };
}

function normalizeDashboardModelProvider(provider, primaryModel) {
  if (!provider) {
    if (primaryModel === 'nvidia/z-ai/glm-5.2') {
      throw new Error('NVIDIA model_provider configuration is required');
    }
    return null;
  }
  if (provider.id !== 'nvidia' || primaryModel !== 'nvidia/z-ai/glm-5.2') {
    throw new Error('Unsupported model_provider configuration');
  }
  if (provider.configured !== true || typeof provider.api_key !== 'string' || provider.api_key.trim() === '') {
    throw new Error('NVIDIA_API_KEY is not configured');
  }
  if (provider.base_url !== 'https://integrate.api.nvidia.com/v1'
      || provider.api !== 'openai-completions') {
    throw new Error('Invalid NVIDIA provider endpoint or API mode');
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (models.length !== 1 || models[0]?.id !== 'z-ai/glm-5.2') {
    throw new Error('Invalid NVIDIA model catalog');
  }

  return {
    id: 'nvidia',
    config: {
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      api: 'openai-completions',
      timeoutSeconds: 300,
      models: models.map(item => ({
        id: item.id,
        name: item.name || 'NVIDIA NIM · GLM 5.2',
        reasoning: item.reasoning !== false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(item.context_window) || 1000000,
        maxTokens: Number(item.max_tokens) || 16384,
        compat: { requiresStringContent: true },
      })),
    },
  };
}

function singleModelProviderConfig(provider = null) {
  if (!provider) return undefined;
  return {
    mode: 'replace',
    providers: {
      [provider.id]: provider.config,
    },
  };
}

function clearClientSessionModelOverrides(name) {
  const paths = clientPaths(name);
  const sessionsPath = path.join(paths.stateDir, 'agents', 'main', 'sessions', 'sessions.json');
  if (!fs.existsSync(sessionsPath)) return { changed: 0 };

  const sessions = readJsonFile(sessionsPath, {});
  const fields = [
    'providerOverride',
    'modelOverride',
    'modelOverrideSource',
    'modelOverrideFallbackOriginProvider',
    'modelOverrideFallbackOriginModel',
  ];
  let changed = 0;
  for (const entry of Object.values(sessions)) {
    if (!entry || typeof entry !== 'object') continue;
    let entryChanged = false;
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(entry, field)) {
        delete entry[field];
        entryChanged = true;
      }
    }
    if (entryChanged) changed += 1;
  }
  if (changed > 0) {
    const backupPath = `${sessionsPath}.before-model-switch-${Date.now()}`;
    fs.copyFileSync(sessionsPath, backupPath);
    fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2) + '\n');
    chownIfHome(paths, backupPath);
    chownIfHome(paths, sessionsPath);
  }
  return { changed };
}

function inferGlobalGroupAllowFrom(groups, allowFrom, existing) {
  if (!groups.length) return existing;
  return groups.some((group) => Array.isArray(group.groupAllowFrom) && group.groupAllowFrom.includes('*'))
    ? ['*']
    : allowFrom;
}

function writeBlueprint(name, content) {
  const paths = clientPaths(name);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  const agentsPath = path.join(paths.workspaceDir, 'AGENTS.md');
  let current = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '# AGENTS.md\n';
  const nextSection = `## Blueprint Client\n\n${String(content || '').trim()}\n`;

  if (current.includes('## Blueprint Client')) {
    current = current.replace(/## Blueprint Client[\s\S]*$/, nextSection);
  } else {
    current = `${current.trim()}\n\n${nextSection}`;
  }

  fs.writeFileSync(agentsPath, current);
  chownIfHome(paths, agentsPath);
}

app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'ok', version: '1.1.0', ts: new Date().toISOString() });
});

app.get('/clients', (_req, res) => {
  const clients = discoverClients()
    .map((name) => {
      const config = getClientConfig(name);
      return config ? extractClient(config, name) : null;
    })
    .filter(Boolean);

  res.json(clients);
});

app.post('/clients/validate-provision', (req, res) => {
  const { name, phone, wa_mode = 'client_number_bot', assistants = [], files = {}, config = {}, crons = [] } = req.body || {};
  const errors = [];

  if (!validName(name)) errors.push('Invalid client name');
  if (!/^\+62[0-9]{9,13}$/.test(String(phone || ''))) errors.push('Invalid Indonesian E.164 phone');
  if (!['client_number_bot', 'managed_group_employee'].includes(wa_mode)) errors.push('Invalid wa_mode');
  if (!Array.isArray(assistants) || assistants.length === 0) errors.push('At least one assistant is required');
  for (const assistant of assistants || []) {
    if (!VALID_ASSISTANT_TYPES.includes(assistant.type)) errors.push(`Invalid assistant type: ${assistant.type || ''}`);
  }
  if (!files || typeof files !== 'object' || Array.isArray(files)) errors.push('files must be an object');
  for (const file of Object.keys(files || {})) {
    if (!isAllowedWorkspaceFile(file)) errors.push(`Unsupported workspace file: ${file}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) errors.push('config must be an object');
  try {
    normalizeDashboardModelProvider(config?.model_provider, config?.primary_model);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    normalizeWebSearchPolicy(config?.web_search);
  } catch (error) {
    errors.push(error.message);
  }
  const maxCronTotal = Number(config?.cron_policy?.max_total);
  const defaultCronCount = Number(config?.cron_policy?.default_count);
  const additionalCronLimit = Number(config?.cron_policy?.additional_limit);
  const maxConcurrentCronRuns = Number(config?.cron_policy?.max_concurrent_runs);
  const minCronGapMinutes = Number(config?.cron_policy?.min_gap_minutes);
  if (!Number.isInteger(maxCronTotal) || maxCronTotal < 0 || maxCronTotal > 500
      || !Number.isInteger(defaultCronCount) || defaultCronCount < 0
      || !Number.isInteger(additionalCronLimit) || additionalCronLimit < 0
      || !Number.isInteger(maxConcurrentCronRuns) || maxConcurrentCronRuns < 1 || maxConcurrentCronRuns > 32
      || !Number.isInteger(minCronGapMinutes) || minCronGapMinutes < 0 || minCronGapMinutes > 60
      || maxCronTotal !== defaultCronCount + additionalCronLimit) {
    errors.push('Invalid or missing config.cron_policy');
  }
  if (wa_mode === 'client_number_bot' && config && typeof config === 'object') {
    const plan = config.plan;
    const expectedDm = plan === 'pro' ? 'allowlist' : 'disabled';
    const expectedGroupAllow = plan === 'personal' ? [phone] : ['*'];
    if (!['personal', 'plus', 'pro'].includes(plan)) errors.push('Invalid or missing config.plan');
    if (config.dm_policy !== expectedDm) errors.push(`Invalid dm_policy for ${plan || 'unknown'} plan`);
    if (config.group_policy !== 'allowlist') errors.push('group_policy must be allowlist');
    if (JSON.stringify(config.group_allow_from || []) !== JSON.stringify(expectedGroupAllow)) {
      errors.push(`Invalid group_allow_from for ${plan || 'unknown'} plan`);
    }
    const expectedDmAllow = plan === 'pro' ? [phone] : [];
    if (JSON.stringify(config.allowFrom || []) !== JSON.stringify(expectedDmAllow)) {
      errors.push(`Invalid allowFrom for ${plan || 'unknown'} plan`);
    }
  }
  if (!Array.isArray(crons)) errors.push('crons must be an array');
  for (const cron of crons || []) {
    if (!/^[a-z][a-z0-9_-]*$/.test(String(cron.slug || ''))) errors.push(`Invalid cron slug: ${cron.slug || ''}`);
    if (!/^\S+(\s+\S+){4}$/.test(String(cron.schedule || ''))) errors.push(`Invalid cron schedule: ${cron.slug || ''}`);
    if (!cron.message || typeof cron.message !== 'string') errors.push(`Missing cron message: ${cron.slug || ''}`);
    if (cron.enabled !== false) errors.push(`Cron must start disabled: ${cron.slug || ''}`);
  }
  if (Array.isArray(crons) && Number.isInteger(defaultCronCount) && crons.length !== defaultCronCount) {
    errors.push(`Default cron count does not match policy: ${crons.length}/${defaultCronCount}`);
  }

  res.status(errors.length ? 422 : 200).json({
    ok: errors.length === 0,
    dry_run: true,
    errors,
    summary: {
      assistants: Array.isArray(assistants) ? assistants.length : 0,
      workspace_files: files && typeof files === 'object' && !Array.isArray(files) ? Object.keys(files).length : 0,
      config_keys: config && typeof config === 'object' && !Array.isArray(config) ? Object.keys(config) : [],
      crons: Array.isArray(crons) ? crons.length : 0,
    },
  });
});

app.get('/clients/:name', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });

  const paths = clientPaths(name);
  const workspace = {};
  for (const file of WORKSPACE_FILES) {
    const filePath = path.join(paths.workspaceDir, file);
    workspace[file] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }

  res.json({
    ok: true,
    ...extractClient(config, name),
    config,
    groups: config.channels?.whatsapp?.groups || {},
    workspace,
  });
});

app.post('/clients', (req, res) => {
  const { name, trigger, phone, scope_package = 'personal', assistant_type = 'custom', blueprint } = req.body;

  if (!name || !trigger || !phone) return res.status(400).json({ ok: false, error: 'name, trigger, phone are required' });
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'name must be lowercase alphanumeric/dash/underscore' });
  if (!/^\+62[0-9]{9,13}$/.test(phone)) return res.status(400).json({ ok: false, error: 'phone must be E.164 format starting with +62' });
  if (!['personal', 'team'].includes(scope_package)) return res.status(400).json({ ok: false, error: 'scope_package must be personal or team' });
  if (!VALID_ASSISTANT_TYPES.includes(assistant_type)) return res.status(400).json({ ok: false, error: `assistant_type must be one of: ${VALID_ASSISTANT_TYPES.join('|')}` });

  const cmd = `bash ${quote(path.join(SCRIPTS_DIR, 'create-client.sh'))} ${quote(name)} ${quote(trigger)} ${quote(phone)} ${quote(scope_package)} ${quote(assistant_type)} 2>&1`;

  exec(cmd, { encoding: 'utf8', timeout: 120000 }, (error, stdout, stderr) => {
    if (error && !String(stdout || '').includes('berhasil dibuat')) {
      return res.status(500).json({ ok: false, error: 'Setup failed', detail: stdout || stderr });
    }

    if (blueprint && String(blueprint).trim()) {
      writeBlueprint(name, blueprint);
    }

    const config = getClientConfig(name);
    const port = config?.gateway?.port;
    res.status(201).json({
      ok: true,
      success: true,
      name,
      port,
      service_status: getServiceStatus(name),
      message: `Client '${name}' created. Next step: login WhatsApp.`,
      next_step: `openclaw --profile ${name} channels login --channel whatsapp`,
    });
  });
});

app.patch('/clients/:name', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const existing = getClientConfig(name);
  if (!existing) return res.status(404).json({ ok: false, error: 'Client not found' });

  const fullDashboardPayload = req.body && (
    req.body.primary_model ||
    req.body.dm_policy ||
    req.body.group_policy ||
    req.body.groups ||
    req.body.assistants ||
    req.body.integrations ||
    req.body.web_search ||
    req.body.workspace_dir ||
    req.body.codex_home
  );

  if (fullDashboardPayload) {
    const next = buildConfigFromDashboard(name, req.body, existing);
    writeClientConfig(name, next);
    const sessionReset = req.body.single_model_mode === true
      ? clearClientSessionModelOverrides(name)
      : { changed: 0 };
    if (req.body.blueprint !== undefined) writeBlueprint(name, req.body.blueprint);
    return res.json({
      ok: true,
      success: true,
      restarted: false,
      message: `Client '${name}' full config updated`,
      port: next.gateway?.port,
      session_model_overrides_cleared: sessionReset.changed,
    });
  }

  let changed = false;
  let needRestart = false;

  if (req.body.scope_package) {
    if (!['personal', 'team'].includes(req.body.scope_package)) {
      return res.status(400).json({ ok: false, error: 'scope_package must be personal or team' });
    }
    const phone = existing.channels?.whatsapp?.allowFrom?.[0] || '';
    existing.channels.whatsapp.groupAllowFrom = req.body.scope_package === 'team' ? ['*'] : [phone];
    changed = true;
    needRestart = true;
  }

  if (req.body.trigger && existing.agents?.list?.[0]) {
    existing.agents.list[0].groupChat = { mentionPatterns: [req.body.trigger, `@${req.body.trigger}`] };
    changed = true;
  }

  if (changed) writeClientConfig(name, existing);
  if (req.body.blueprint !== undefined) writeBlueprint(name, req.body.blueprint);
  if (needRestart) restartClientService(name);

  res.json({ ok: true, success: true, restarted: needRestart, message: `Client '${name}' updated` });
});

app.delete('/clients/:name', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  if (!getClientConfig(name)) return res.status(404).json({ ok: false, error: 'Client not found' });

  const cmd = `echo ${quote(name)} | bash ${quote(path.join(__dirname, 'delete-client.sh'))} ${quote(name)} 2>&1`;
  runAsync(cmd, res);
});

app.post('/clients/:name/restart', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  if (!getClientConfig(name)) return res.status(404).json({ ok: false, error: 'Client not found' });

  try {
    restartClientService(name);
    res.json({ ok: true, success: true, message: `Service '${name}' restarted` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/clients/:name/reload', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  if (!getClientConfig(name)) return res.status(404).json({ ok: false, error: 'Client not found' });

  try {
    reloadClientService(name);
    res.json({ ok: true, success: true, message: `Config '${name}' reload triggered` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/clients/:name/workspace', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  if (!getClientConfig(name)) return res.status(404).json({ ok: false, error: 'Client not found' });

  const files = req.body?.files;
  const preserveExisting = req.body?.preserve_existing !== false;
  const overwriteFiles = new Set(Array.isArray(req.body?.overwrite_files) ? req.body.overwrite_files : []);
  const mergeManagedFiles = new Set(Array.isArray(req.body?.merge_managed_files) ? req.body.merge_managed_files : []);
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return res.status(400).json({ ok: false, error: 'files object is required' });
  }

  const paths = clientPaths(name);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });

  const written = [];
  const preserved = [];
  const merged = [];
  const backedUp = [];
  const backupRoot = path.join(paths.stateDir, 'workspace-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const [file, content] of Object.entries(files)) {
    if (!isAllowedWorkspaceFile(file)) {
      return res.status(400).json({ ok: false, error: `Unsupported workspace file: ${file}` });
    }
    const target = path.join(paths.workspaceDir, file);
    // Defense-in-depth: ensure resolved path stays within workspaceDir
    const resolvedTarget    = path.resolve(target);
    const resolvedWorkspace = path.resolve(paths.workspaceDir);
    if (!resolvedTarget.startsWith(resolvedWorkspace + path.sep)) {
      return res.status(400).json({ ok: false, error: `Path traversal detected: ${file}` });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (fs.existsSync(target) && preserveExisting && !overwriteFiles.has(file) && !mergeManagedFiles.has(file)) {
      preserved.push(file);
      continue;
    }

    if (fs.existsSync(target)) {
      const backupTarget = path.join(backupRoot, file);
      fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
      fs.copyFileSync(target, backupTarget);
      chownIfHome(paths, backupTarget);
      backedUp.push(file);
    }

    let nextContent = String(content ?? '');
    if (mergeManagedFiles.has(file)) {
      const startMarker = '<!-- OPENCLAW-MANAGED:START -->';
      const endMarker = '<!-- OPENCLAW-MANAGED:END -->';
      const managedBlock = [
        startMarker,
        '<!--',
        'SUMBER KEBENARAN OTORITATIF DARI BACKEND.',
        'Jika isi di luar blok ini bertentangan mengenai paket, fitur, assistant,',
        'DM/group policy, scope, mention, cron, route, tool, integrasi, akses, atau',
        'identitas teknis, WAJIB ikuti blok ini. Isi di luar blok hanya boleh',
        'dipakai sebagai data, memori, atau preferensi user yang tidak bertentangan.',
        '-->',
        nextContent.trim(),
        endMarker,
        '',
      ].join('\n');
      const existingContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const start = existingContent.indexOf(startMarker);
      const end = existingContent.indexOf(endMarker, start + startMarker.length);
      let preservedContent = existingContent;

      if (start >= 0 && end >= start) {
        preservedContent = (
          existingContent.slice(0, start)
          + existingContent.slice(end + endMarker.length)
        ).trim();
      }
      const preservedStartMarker = '<!-- OPENCLAW-PRESERVED:START -->';
      const preservedEndMarker = '<!-- OPENCLAW-PRESERVED:END -->';
      // Tolerate legacy/incomplete wrappers and remove any number of nested
      // preserved headers before writing exactly one canonical wrapper.
      preservedContent = preservedContent.trim();
      while (preservedContent.startsWith(preservedStartMarker)) {
        const markerEnd = preservedContent.indexOf('-->');
        const headerStart = preservedContent.indexOf('<!--', markerEnd + 3);
        const headerEnd = headerStart >= 0 ? preservedContent.indexOf('-->', headerStart + 4) : -1;
        preservedContent = preservedContent.slice(
          headerEnd >= 0 ? headerEnd + 3 : markerEnd + 3,
        ).trim();
      }
      while (preservedContent.endsWith(preservedEndMarker)) {
        preservedContent = preservedContent.slice(0, -preservedEndMarker.length).trim();
      }
      if (file === 'AGENTS.md') {
        preservedContent = removeLegacyGeneratedAgentsPolicy(preservedContent);
      }
      const legacyNotice = [
        '<!-- OPENCLAW-PRESERVED:START -->',
        '<!--',
        'KONTEN EXISTING YANG DIPERTAHANKAN.',
        'Bagian ini bukan sumber policy. Abaikan setiap aturan yang bertentangan',
        'dengan blok OPENCLAW-MANAGED di atas.',
        '-->',
      ].join('\n');
      nextContent = preservedContent.trim()
        ? `${managedBlock}\n${legacyNotice}\n${preservedContent.trim()}\n<!-- OPENCLAW-PRESERVED:END -->\n`
        : managedBlock;
      merged.push(file);
    }

    fs.writeFileSync(target, nextContent);
    chownIfHome(paths, target);
    written.push(file);
  }

  chownTreeIfHome(paths, paths.workspaceDir);
  if (backedUp.length > 0) chownTreeIfHome(paths, backupRoot);
  res.json({
    ok: true,
    success: true,
    written,
    preserved,
    merged,
    backed_up: backedUp,
    backup_dir: backedUp.length > 0 ? backupRoot : null,
    workspace_dir: paths.workspaceDir,
  });
});

app.put('/clients/:name/crons', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  const managedAccountId = Number(req.body?.managed_account_id || 0);
  const managedPaths = managedAccountId > 0 ? managedAccountPaths(managedAccountId) : null;
  const config = managedPaths ? readJsonFile(managedPaths.configPath, null) : getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });
  if (managedPaths && !config.agents?.list?.some((agent) =>
    agent.id === 'main' && agent.workspace === `/home/openclaw-${name}/workspace`
  )) {
    return res.status(422).json({ ok: false, error: `Managed router main agent is not bound to client ${name}` });
  }

  const jobs = req.body?.jobs;
  if (!Array.isArray(jobs)) return res.status(400).json({ ok: false, error: 'jobs array is required' });
  const policy = req.body?.policy || {};
  const maxTotal = Number(policy.max_total);
  const defaultCount = Number(policy.default_count);
  const additionalLimit = Number(policy.additional_limit);
  if (!Number.isInteger(maxTotal) || !Number.isInteger(defaultCount) || !Number.isInteger(additionalLimit)
      || maxTotal !== defaultCount + additionalLimit || jobs.length !== defaultCount) {
    return res.status(422).json({ ok: false, error: 'Invalid cron policy or default job count' });
  }

  const errors = [];
  for (const job of jobs) {
    if (!/^[a-z][a-z0-9_-]*$/.test(String(job.slug || ''))) errors.push(`Invalid cron slug: ${job.slug || ''}`);
    if (!/^\S+(\s+\S+){4}$/.test(String(job.schedule || ''))) errors.push(`Invalid cron schedule: ${job.slug || ''}`);
    if (!job.message || typeof job.message !== 'string') errors.push(`Missing cron message: ${job.slug || ''}`);
    if (job.enabled !== false) errors.push(`Provisioned cron must start disabled: ${job.slug || ''}`);
  }
  if (errors.length) return res.status(422).json({ ok: false, errors });

  const port = config.gateway?.port;
  const token = config.gateway?.auth?.token;
  if (!port || !token) return res.status(422).json({ ok: false, error: 'Gateway port/token missing' });
  const connection = ['--url', `ws://127.0.0.1:${port}`, '--token', token];
  const cronExecOptions = { encoding: 'utf8', timeout: 30000, ...(managedPaths ? { env: openClawEnv(managedPaths) } : {}) };

  try {
    const raw = execOpenClawAfterGatewayReady(['cron', 'list', '--all', '--json', ...connection], cronExecOptions);
    const parsed = JSON.parse(raw || '{}');
    const existingJobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    const jobName = (slug) => managedPaths ? `${name}__${slug}` : slug;
    const existingByName = new Map(existingJobs.map((job) => [job.name, job]));
    const scopedExisting = managedPaths
      ? existingJobs.filter((job) => String(job.name || '').startsWith(`${name}__`))
      : existingJobs;
    const newDefaultCount = jobs.filter((job) => !existingByName.has(jobName(job.slug))).length;
    if (scopedExisting.length + newDefaultCount > maxTotal) {
      return res.status(409).json({
        ok: false,
        error: `Cron policy exceeded: ${scopedExisting.length} existing + ${newDefaultCount} new > ${maxTotal}`,
      });
    }
    const created = [];
    const existing = [];
    const unchanged = [];

    for (const job of jobs) {
      const persistedName = jobName(job.slug);
      const cronAgent = managedPaths ? 'main' : (job.agent || 'main');
      if (existingByName.has(persistedName)) {
        const current = existingByName.get(persistedName);
        if (!current.id) throw new Error(`Existing cron has no id: ${job.slug}`);
        const alreadySynced = current.agentId === cronAgent
          && current.schedule?.kind === 'cron'
          && current.schedule?.expr === job.schedule
          && current.schedule?.tz === (job.timezone || 'Asia/Jakarta')
          && current.sessionTarget === (job.session || 'isolated')
          && current.payload?.message === job.message;
        if (alreadySynced) {
          existing.push(persistedName);
          unchanged.push(persistedName);
          continue;
        }
        execFileSync(NODE_BIN, [
          OPENCLAW_BIN, 'cron', 'edit', current.id,
          '--cron', job.schedule, '--tz', job.timezone || 'Asia/Jakarta',
          '--agent', cronAgent, '--session', job.session || 'isolated',
          '--message', job.message, '--disable', '--no-deliver', ...connection,
        ], cronExecOptions);
        existing.push(persistedName);
        continue;
      }
      execFileSync(NODE_BIN, [
        OPENCLAW_BIN, 'cron', 'add', '--json', '--name', persistedName,
        '--cron', job.schedule, '--tz', job.timezone || 'Asia/Jakarta',
        '--agent', cronAgent, '--session', job.session || 'isolated',
        '--message', job.message, '--disabled', '--no-deliver', ...connection,
      ], cronExecOptions);
      created.push(persistedName);
    }

    res.json({ ok: true, success: true, created, existing, unchanged, enabled: 0 });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Cron sync failed', detail: String(error.stderr || error.message || '').trim() });
  }
});

app.post('/clients/:name/workspace/adapt', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  const paths = clientPaths(name);
  if (!getClientConfig(name)) return res.status(404).json({ ok: false, error: 'Client not found' });

  const manifest = req.body?.manifest;
  const allowedPaths = manifest?.output_contract?.allowed_paths;
  if (manifest?.schema_version !== 1 || !Array.isArray(allowedPaths)) {
    return res.status(422).json({ ok: false, error: 'Invalid onboarding adapter manifest' });
  }
  if (allowedPaths.some((file) => !isAllowedWorkspaceFile(file))) {
    return res.status(422).json({ ok: false, error: 'Manifest contains unsupported workspace paths' });
  }
  if (!fs.existsSync(CLAUDE_BIN)) return res.status(503).json({ ok: false, error: 'Claude adapter is unavailable' });

  const schema = JSON.stringify({
    type: 'object', additionalProperties: false, required: ['files'],
    properties: {
      files: {
        type: 'object',
        propertyNames: { enum: allowedPaths },
        additionalProperties: { type: 'string', maxLength: 100000 },
      },
    },
  });
  const prompt = [
    'Adapt onboarding data into client-specific workspace content.',
    'Return JSON only according to the supplied schema.',
    'Do not return or alter config, credentials, integrations, cron, router, or infrastructure.',
    'Only include a file when onboarding data materially improves it; preserve the base template structure, preserve facts, and never invent personal data.',
    'Current allowed base files:',
    JSON.stringify(Object.fromEntries(allowedPaths.map((file) => {
      const target = path.resolve(paths.workspaceDir, file);
      return [file, fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''];
    }))),
    JSON.stringify(manifest),
  ].join('\n\n');

  try {
    const raw = execFileSync(CLAUDE_BIN, [
      '--print', '--model', 'sonnet', '--output-format', 'json', '--json-schema', schema,
      '--tools', '', '--permission-mode', 'dontAsk', prompt,
    ], { encoding: 'utf8', timeout: 270000, maxBuffer: 4 * 1024 * 1024, cwd: paths.workspaceDir });
    const envelope = JSON.parse(raw);
    const output = envelope.structured_output || envelope.result || envelope;
    const files = output.files || {};
    const written = [];
    for (const [file, content] of Object.entries(files)) {
      if (!allowedPaths.includes(file) || !isAllowedWorkspaceFile(file) || typeof content !== 'string') {
        throw new Error(`Adapter returned forbidden file: ${file}`);
      }
      const target = path.resolve(paths.workspaceDir, file);
      if (!target.startsWith(path.resolve(paths.workspaceDir) + path.sep)) throw new Error('Adapter path traversal');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      chownIfHome(paths, target);
      written.push(file);
    }
    res.json({ ok: true, adapted: true, written });
  } catch (error) {
    let claudeError = null;
    try { claudeError = JSON.parse(String(error.stdout || '')); } catch {}
    const authRevoked = Number(claudeError?.api_error_status) === 401;
    const detail = claudeError?.result || error.stderr || error.message || '';
    res.status(authRevoked ? 401 : 500).json({
      ok: false,
      error: authRevoked ? 'claude_auth_revoked' : 'Structured workspace adaptation failed',
      detail: String(detail).slice(0, 1000),
    });
  }
});

app.post('/clients/:name/verify-prerequisites', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  const paths = clientPaths(name);
  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });
  const env = openClawEnv(paths);
  let modelAuth = false;
  let modelDetail = '';
  try {
    modelDetail = execFileSync(NODE_BIN, [OPENCLAW_BIN, 'models', 'status', '--check', '--json'], {
      encoding: 'utf8', timeout: 60000, env,
    });
    modelAuth = true;
  } catch (error) {
    modelDetail = String(error.stderr || error.stdout || error.message || '').slice(0, 1000);
  }

  // Dashboard metadata is intentionally not stored in openclaw.json because
  // `meta` is not part of the OpenClaw schema. A managed client has no local
  // WhatsApp channel; delivery is owned by its managed-account gateway.
  const waMode = config.channels?.whatsapp ? 'client_number_bot' : 'managed_group_employee';
  const waCredentials = path.join(paths.stateDir, 'credentials', 'whatsapp', 'default', 'creds.json');
  const whatsapp = waMode === 'managed_group_employee' ? true : fs.existsSync(waCredentials);
  const result = {
    ok: modelAuth && whatsapp,
    model_auth_ok: modelAuth,
    whatsapp_connected: whatsapp,
    wa_mode: waMode,
    model_detail: modelDetail,
  };
  res.status(result.ok ? 200 : 422).json(result);
});

app.post('/clients/:name/crons/activate', async (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  const managedAccountId = Number(req.body?.managed_account_id || 0);
  const managedPaths = managedAccountId > 0 ? managedAccountPaths(managedAccountId) : null;
  const config = managedPaths ? readJsonFile(managedPaths.configPath, null) : getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });
  const jobs = req.body?.jobs;
  const targets = req.body?.targets;
  if (!Array.isArray(jobs) || !targets || typeof targets !== 'object') {
    return res.status(422).json({ ok: false, error: 'jobs and assistant delivery targets are required' });
  }
  const validTarget = (target) => /^120[0-9]+@g\.us$/.test(target) || /^\+[1-9][0-9]{6,14}$/.test(target);
  const invalidJob = jobs.find((job) => !job.assistant_slot || !validTarget(String(targets[job.assistant_slot] || '')));
  if (invalidJob) return res.status(422).json({ ok: false, error: `Missing or invalid WhatsApp target for assistant slot ${invalidJob.assistant_slot || '?'}` });
  const connection = ['--url', `ws://127.0.0.1:${config.gateway?.port}`, '--token', config.gateway?.auth?.token];
  const cronExecOptions = { encoding: 'utf8', timeout: 30000, ...(managedPaths ? { env: openClawEnv(managedPaths) } : {}) };
  try {
    const raw = execOpenClawAfterGatewayReady(['cron', 'list', '--all', '--json', ...connection], cronExecOptions);
    const existing = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : (JSON.parse(raw).jobs || []);
    const jobName = (slug) => managedPaths ? `${name}__${slug}` : slug;
    const requested = new Set(jobs.map((job) => jobName(job.slug)));
    const requestedJobs = new Map(jobs.map((job) => [jobName(job.slug), job]));
    const enabled = [];
    const unchanged = [];
    const edits = [];
    for (const job of existing) {
      if (!requested.has(job.name) || !job.id) continue;
      const requestedJob = requestedJobs.get(job.name);
      const target = String(targets[requestedJob.assistant_slot]);
      const activation = { name: job.name, assistant_slot: requestedJob.assistant_slot, target };
      const alreadyActive = job.enabled === true
        && job.delivery?.mode === 'announce'
        && job.delivery?.channel === 'whatsapp'
        && job.delivery?.to === target;
      if (alreadyActive) {
        enabled.push(activation);
        unchanged.push(job.name);
        continue;
      }
      edits.push(() => new Promise((resolve, reject) => {
          execFile(
            NODE_BIN,
            [OPENCLAW_BIN, 'cron', 'edit', job.id, '--enable', '--announce', '--channel', 'whatsapp', '--to', target, ...connection],
            cronExecOptions,
            (error) => {
              if (error) return reject(error);
              enabled.push(activation);
              resolve();
            },
          );
        }));
    }
    for (const edit of edits) await edit();
    if (enabled.length !== requested.size) {
      throw new Error(`Cron activation incomplete: enabled ${enabled.length}/${requested.size}. Run cron sync again before activation.`);
    }
    res.json({ ok: true, enabled, unchanged, channel: 'whatsapp', targets });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Cron activation failed', detail: String(error.stderr || error.message || '').slice(0, 1000) });
  }
});

app.post('/clients/:name/groups', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });

  const groupId = req.body.group_wa_id || req.body.groupId;
  if (!groupId || !String(groupId).endsWith('@g.us')) {
    return res.status(400).json({ ok: false, error: 'group_wa_id must look like 12036xxxx@g.us' });
  }

  config.channels = config.channels || {};
  config.channels.whatsapp = config.channels.whatsapp || {};
  config.channels.whatsapp.groups = config.channels.whatsapp.groups || {};
  config.channels.whatsapp.groups[groupId] = {
    name: req.body.name || '',
    requireMention: req.body.require_mention ?? req.body.requireMention ?? true,
    allowFrom: req.body.allowFrom,
    assistantSlot: req.body.assistantSlot || 1,
  };

  writeClientConfig(name, config);
  res.json({ ok: true, success: true, message: `Group ${groupId} added to '${name}'` });
});

app.get('/clients/:name/groups/discover', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });

  const autoRegister = req.query.auto_register === '1' || req.query.auto_register === 'true';
  const cmd = `openclaw --profile ${quote(name)} directory groups list --channel whatsapp --json 2>/dev/null`;

  exec(cmd, { encoding: 'utf8', timeout: 30000 }, (error, stdout) => {
    let discovered = [];
    try {
      const parsed = JSON.parse(stdout || '[]');
      discovered = Array.isArray(parsed) ? parsed : (parsed.groups || parsed.items || []);
    } catch {
      return res.status(500).json({ ok: false, error: 'Failed to parse group list from gateway', raw: String(stdout || '').slice(0, 500) });
    }

    if (!autoRegister) {
      return res.json({ ok: true, count: discovered.length, groups: discovered });
    }

    const registered = config.channels?.whatsapp?.groups || {};
    const newGroups = [];
    for (const g of discovered) {
      const gid = g.id || g.group_id || g.jid;
      if (!gid || !String(gid).endsWith('@g.us')) continue;
      if (registered[gid]) continue;
      config.channels = config.channels || {};
      config.channels.whatsapp = config.channels.whatsapp || {};
      config.channels.whatsapp.groups = config.channels.whatsapp.groups || {};
      config.channels.whatsapp.groups[gid] = {
        name: g.name || g.subject || '',
        requireMention: true,
        assistantSlot: 1,
      };
      newGroups.push(gid);
    }

    if (newGroups.length > 0) writeClientConfig(name, config);
    res.json({ ok: true, count: discovered.length, discovered, auto_registered: newGroups });
  });
});

app.delete('/clients/:name/groups/:groupId', (req, res) => {
  const { name, groupId } = req.params;
  const groupWaId = decodeURIComponent(groupId);
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });

  if (config.channels?.whatsapp?.groups?.[groupWaId]) {
    delete config.channels.whatsapp.groups[groupWaId];
    writeClientConfig(name, config);
    return res.json({ ok: true, success: true, message: `Group ${groupWaId} removed from '${name}'` });
  }

  res.status(404).json({ ok: false, error: 'Group not found' });
});

// ── Telegram Notification ────────────────────────────────────────────────────

app.post('/notify', (req, res) => {
  const { text, order } = req.body;

  let message = text;

  if (!message && order) {
    const a = order;
    const rawSlots = a.assistant_slots || [];
    const slots = Array.isArray(rawSlots)
      ? rawSlots.map(s => s.type || s).join(', ') || '-'
      : String(rawSlots) || '-';
    const contactWa = a.contact_wa || a.contact_whatsapp || '-';
    message = [
      '🔔 <b>Order Baru Masuk!</b>',
      '',
      `👤 <b>Nama:</b> ${a.full_name || '-'}`,
      `📱 <b>WA:</b> ${contactWa}`,
      a.email ? `📧 <b>Email:</b> ${a.email}` : null,
      `🤖 <b>Asisten:</b> ${slots}`,
      `📦 <b>Paket:</b> ${a.plan || '-'}`,
      `🔧 <b>Mode:</b> ${a.wa_mode || '-'}`,
      a.preferred_assistant_name ? `💬 <b>Nama Asisten:</b> ${a.preferred_assistant_name}` : null,
      a.preferred_trigger_word   ? `⚡ <b>Trigger:</b> ${a.preferred_trigger_word}` : null,
      a.notes || a.onboarding_notes ? `📝 <b>Catatan:</b> ${a.notes || a.onboarding_notes}` : null,
      '',
      `🔗 <a href="https://samsulhadissbackend.samsulhadiss.com/samsulhadiss/openclaw/orders">Buka Dashboard</a>`,
    ].filter(l => l !== null).join('\n');
  }

  if (!message) return res.status(400).json({ ok: false, error: 'text or order required' });

  sendTelegram(message);
  res.json({ ok: true, message: 'Notification sent' });
});

// ── Auto Create WhatsApp Group ───────────────────────────────────────────────

app.post('/clients/:name/groups/create', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });

  const user_phone = req.body.user_phone || req.body.member_phone;
  const group_name = req.body.group_name;
  const idempotencyKey = req.body.idempotency_key;
  const description = String(req.body.description || '').trim().slice(0, 500);
  if (!user_phone) return res.status(400).json({ ok: false, error: 'user_phone (or member_phone) is required' });
  if (!group_name) return res.status(400).json({ ok: false, error: 'group_name is required' });
  if (!/^\+?[0-9]{8,15}$/.test(user_phone.replace(/\s/g, ''))) {
    return res.status(400).json({ ok: false, error: 'user_phone must be a valid phone number' });
  }

  const paths = clientPaths(name);
  const credsDir = path.join(paths.stateDir, 'credentials', 'whatsapp', 'default');
  const groupRegistryFile = path.join(paths.stateDir, 'provisioned-groups.json');
  const groupRegistry = readJsonFile(groupRegistryFile, {});
  if (idempotencyKey && groupRegistry[idempotencyKey]) {
    return res.json({ ok: true, success: true, ...groupRegistry[idempotencyKey], reused: true, group_registered: true });
  }

  if (!fs.existsSync(path.join(credsDir, 'creds.json'))) {
    return res.status(400).json({
      ok: false,
      error: 'WhatsApp session not found. Run: openclaw --profile ' + name + ' channels login --channel whatsapp',
    });
  }

  const scriptPath = path.join(__dirname, 'wa-create-group.js');
  const nodebin = process.execPath;

  // Stop gateway → create group → restart gateway
  try {
    const svc = paths.serviceName;
    const scope = paths.serviceScope === 'system' ? '' : '--user ';
    try { run(`systemctl ${scope}stop ${quote(svc)}`); } catch {}

    const cmd = `${quote(nodebin)} ${quote(scriptPath)} ${quote(credsDir)} ${quote(group_name)} ${quote(user_phone)}`;

    exec(cmd, {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, WA_GROUP_DESCRIPTION: description },
    }, (error, stdout) => {
      // Always restart gateway regardless of outcome
      try { run(`systemctl ${scope}start ${quote(paths.serviceName)}`); } catch {}

      let result;
      try { result = JSON.parse(stdout.trim()); } catch {
        return res.status(500).json({ ok: false, error: 'Failed to parse group creation output', raw: stdout.slice(0, 200) });
      }

      if (!result.ok) {
        return res.status(500).json(result);
      }

      if (idempotencyKey) {
        groupRegistry[idempotencyKey] = {
          group_id: result.group_id,
          invite_link: result.invite_link || null,
          group_name,
          partial_success: Boolean(result.partial_success),
          participant_added: result.participant_added !== false,
          missing_participants: result.missing_participants || [],
          warning: result.warning || null,
        };
        fs.writeFileSync(groupRegistryFile, JSON.stringify(groupRegistry, null, 2) + '\n');
      }

      // Auto-register the new group into the client config
      const updatedConfig = getClientConfig(name);
      if (updatedConfig) {
        updatedConfig.channels = updatedConfig.channels || {};
        updatedConfig.channels.whatsapp = updatedConfig.channels.whatsapp || {};
        updatedConfig.channels.whatsapp.groups = updatedConfig.channels.whatsapp.groups || {};
        updatedConfig.channels.whatsapp.groups[result.group_id] = {
          name: group_name,
          requireMention: true,
          assistantSlot: 1,
        };
        writeClientConfig(name, updatedConfig);
      }

      sendTelegram(
        `✅ <b>Group WA berhasil dibuat!</b>\n\n` +
        `👤 Client: <code>${name}</code>\n` +
        `👥 Group: <b>${group_name}</b>\n` +
        `🆔 ID: <code>${result.group_id}</code>` +
        (result.invite_link ? `\n🔗 <a href="${result.invite_link}">Link Undangan</a>` : '')
      );

      res.json({ ok: true, success: true, ...result, group_registered: true });
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Managed Router ───────────────────────────────────────────────────────────
// Convention:
//   Creds dir : /root/.openclaw/managed-accounts/{id}/credentials/whatsapp/default/
//   Routes    : /root/.openclaw/managed-accounts/{id}/routes.json
//   Service   : openclaw-managed-{id}-gateway.service

function managedAccountPaths(accountId) {
  const base = `/root/.openclaw/managed-accounts/${accountId}`;
  return {
    base,
    stateDir: base,
    home: '/root',
    codexHome: '/root/.codex',
    credsDir:  `${base}/credentials/whatsapp/default`,
    routesFile: `${base}/routes.json`,
    configPath: `${base}/openclaw.json`,
    workspaceDir: `${base}/workspace`,
    serviceName: `openclaw-managed-${accountId}-gateway.service`,
    serviceFile: `/etc/systemd/system/openclaw-managed-${accountId}-gateway.service`,
  };
}

function readManagedRoutes(accountId) {
  const { routesFile } = managedAccountPaths(accountId);
  if (!fs.existsSync(routesFile)) return [];
  try { return JSON.parse(fs.readFileSync(routesFile, 'utf8')); } catch { return []; }
}

function writeManagedRoutes(accountId, routes) {
  const { base, routesFile } = managedAccountPaths(accountId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(routesFile, JSON.stringify(routes, null, 2) + '\n');
}

function buildManagedNativeConfig(accountId, routes, account = {}) {
  const paths = managedAccountPaths(accountId);
  const existing = readJsonFile(paths.configPath, {});
  // `meta` is not part of the OpenClaw config schema. Older dashboard builds
  // wrote provisioning metadata there, causing `channels login` and gateway
  // startup to fail validation. Keep dashboard metadata in routes/account data
  // instead and explicitly strip a legacy top-level `meta` on every rebuild.
  const existingConfig = { ...existing };
  delete existingConfig.meta;
  const clients = new Map();
  for (const route of routes) {
    if (!route.client_name || !route.agent_workspace || !route.agent_dir) continue;
    if (!clients.has(route.client_name)) clients.set(route.client_name, route);
  }
  const dmClients = Array.isArray(account.dm_clients) ? account.dm_clients : [];
  for (const client of dmClients) {
    if (!client.client_name || !client.agent_workspace || !client.agent_dir) continue;
    if (!clients.has(client.client_name)) clients.set(client.client_name, client);
  }

  const agents = [...clients.values()].map((route, index) => ({
    // A managed bot slot is exclusive to one client. Reuse that client's
    // existing `main` agent database; OpenClaw rejects the database when the
    // configured agent id differs from the id stored inside SQLite.
    id: 'main',
    default: index === 0,
    name: route.client_name,
    workspace: route.agent_workspace,
    agentDir: route.agent_dir,
    model: route.primary_model || 'openai/gpt-5.5',
    groupChat: {
      mentionPatterns: [route.trigger || 'Hey', `@${route.trigger || 'Hey'}`],
    },
  }));
  if (agents.length === 0) {
    agents.push({
      id: 'bootstrap',
      default: true,
      name: 'Managed WhatsApp Bootstrap',
      workspace: paths.workspaceDir,
      agentDir: path.join(paths.base, 'agents', 'bootstrap', 'agent'),
    });
  }

  const groupBindings = routes.map((route) => ({
    agentId: 'main',
    comment: `Managed WA account ${accountId}, assistant slot ${route.assistant_slot || 1}`,
    match: {
      channel: 'whatsapp',
      peer: { kind: 'group', id: route.group_jid },
    },
  }));
  const dmBindings = dmClients
    .filter(client => client.client_name && client.owner_phone)
    .map(client => ({
    agentId: 'main',
      comment: `Managed WA account ${accountId}, owner-only personal DM`,
      match: {
        channel: 'whatsapp',
        peer: { kind: 'direct', id: client.owner_phone },
      },
    }));
  const bindings = [...groupBindings, ...dmBindings];

  const groups = {};
  for (const route of routes) {
    groups[route.group_jid] = {
      requireMention: route.require_mention !== false,
      systemPrompt: route.system_prompt || undefined,
    };
  }

  const ownerPhones = [...new Set([
    ...routes.map(route => route.owner_phone),
    ...dmClients.map(client => client.owner_phone),
  ].filter(Boolean))];
  const allowEveryone = routes.some((route) => route.group_scope === 'everyone');
  const port = resolveManagedGatewayPort(accountId, account.gateway_port, existing.gateway?.port);
  const token = existing.gateway?.auth?.token || crypto.randomBytes(24).toString('hex');
  const incomingCronPolicy = dmClients.find(client => client.cron_policy)?.cron_policy;
  // Empty inventory slots have no client payload yet, but they still need a
  // schema-valid bootstrap config so QR pairing can start. Use the same
  // managed web-search policy that client provisioning supplies later.
  const incomingWebSearch = dmClients.find(client => client.web_search)?.web_search || {
    enabled: true,
    provider: 'parallel-free',
    fetch_enabled: true,
  };
  const webSearch = normalizeWebSearchPolicy(incomingWebSearch);
  const nvidiaClient = dmClients.find(client => client.primary_model === 'nvidia/z-ai/glm-5.2');
  const managedModelProvider = nvidiaClient
    ? normalizeDashboardModelProvider(nvidiaClient.model_provider, nvidiaClient.primary_model)
    : null;
  const existingCronPolicy = existing.plugins?.entries?.['heyurassistant-cron-limit']?.config;
  const cronPolicy = incomingCronPolicy || (existingCronPolicy ? {
    max_total: existingCronPolicy.maxTotal,
    default_count: existingCronPolicy.defaultCount,
    additional_limit: existingCronPolicy.additionalLimit,
    max_concurrent_runs: existing.cron?.maxConcurrentRuns,
    min_gap_minutes: existingCronPolicy.minGapMinutes,
  } : null);
  let cronLimitPluginPath = null;
  if (cronPolicy) {
    const maxTotal = Number(cronPolicy.max_total);
    const defaultCount = Number(cronPolicy.default_count);
    const additionalLimit = Number(cronPolicy.additional_limit);
    const maxConcurrentRuns = Number(cronPolicy.max_concurrent_runs);
    const minGapMinutes = Number(cronPolicy.min_gap_minutes);
    if (!Number.isInteger(maxTotal) || !Number.isInteger(defaultCount)
        || !Number.isInteger(additionalLimit)
        || !Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 32
        || !Number.isInteger(minGapMinutes) || minGapMinutes < 0 || minGapMinutes > 60
        || maxTotal !== defaultCount + additionalLimit) {
      throw new Error('Managed client cron_policy is invalid');
    }
    cronLimitPluginPath = ensureCronLimitPlugin(paths);
  }

  return {
    ...existingConfig,
    models: singleModelProviderConfig(managedModelProvider),
    agents: {
      defaults: {
        ...(existing.agents?.defaults || {}),
        model: {
          primary: agents[0]?.model || 'openai/gpt-5.5',
          fallbacks: [],
        },
        models: {
          [agents[0]?.model || 'openai/gpt-5.5']: {},
        },
      },
      list: agents,
    },
    bindings,
    channels: {
      whatsapp: {
        enabled: true,
        dmPolicy: ownerPhones.length > 0 ? 'allowlist' : 'disabled',
        allowFrom: ownerPhones,
        groupPolicy: 'allowlist',
        groupAllowFrom: allowEveryone ? ['*'] : ownerPhones,
        groups,
        debounceMs: 3000,
        sendReadReceipts: false,
      },
    },
    gateway: {
      mode: 'local',
      port,
      bind: 'loopback',
      auth: { mode: 'token', token },
    },
    session: { dmScope: 'per-channel-peer' },
    ...(cronPolicy ? {
      cron: {
        ...(existing.cron || {}),
        maxConcurrentRuns: Number(cronPolicy.max_concurrent_runs),
      },
    } : {}),
    tools: {
      ...(existing.tools || { profile: 'coding' }),
      web: {
        search: {
          enabled: true,
          provider: webSearch.provider,
          maxResults: 10,
          timeoutSeconds: 30,
          cacheTtlMinutes: 15,
        },
        fetch: {
          enabled: webSearch.fetchEnabled,
        },
      },
    },
    plugins: {
      allow: ['openai', 'whatsapp', 'parallel', ...(cronLimitPluginPath ? ['heyurassistant-cron-limit'] : [])],
      bundledDiscovery: 'compat',
      ...(cronLimitPluginPath ? { load: { paths: [cronLimitPluginPath] } } : {}),
      entries: {
        openai: { enabled: true },
        whatsapp: { enabled: true },
        parallel: { enabled: true },
        ...(cronLimitPluginPath ? {
          'heyurassistant-cron-limit': {
            enabled: true,
            config: {
              maxTotal: Number(cronPolicy.max_total),
              defaultCount: Number(cronPolicy.default_count),
              additionalLimit: Number(cronPolicy.additional_limit),
              stateDir: paths.stateDir,
              minGapMinutes: Number(cronPolicy.min_gap_minutes),
            },
          },
        } : {}),
      },
    },
  };
}

function installManagedNativeService(accountId, config) {
  const paths = managedAccountPaths(accountId);
  fs.mkdirSync(paths.base, { recursive: true });
  fs.mkdirSync(paths.credsDir, { recursive: true });
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  // Install through the official npm source so OpenClaw grants trusted plugin
  // capabilities (required by WhatsApp's keyed credential store). A plain
  // directory copy loads but remains untrusted and crashes the channel.
  const trustedPluginPackage = path.join(
    paths.base,
    'npm/projects/openclaw-whatsapp-290d7f7427/node_modules/@openclaw/whatsapp/package.json',
  );
  if (!fs.existsSync(trustedPluginPackage)) {
    execFileSync(NODE_BIN, [OPENCLAW_BIN, 'plugins', 'install', WHATSAPP_PLUGIN_SPEC], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        HOME: '/root',
        OPENCLAW_STATE_DIR: paths.base,
        OPENCLAW_CONFIG_PATH: paths.configPath,
        CODEX_HOME: '/root/.codex',
      },
    });
  }

  const unit = `[Unit]\nDescription=OpenClaw Managed WhatsApp Gateway #${accountId}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${paths.base}\nEnvironment=HOME=/root\nEnvironment=OPENCLAW_STATE_DIR=${paths.base}\nEnvironment=OPENCLAW_CONFIG_PATH=${paths.configPath}\nEnvironment=CODEX_HOME=/root/.codex\nExecStart=${NODE_BIN} ${OPENCLAW_BIN} gateway --port ${config.gateway.port}\nRestart=always\nRestartSec=5\nRestartPreventExitStatus=78\n\n[Install]\nWantedBy=multi-user.target\n`;
  fs.writeFileSync(paths.serviceFile, unit);
  run('systemctl daemon-reload');
}

function ensureManagedApiDeviceScopes(accountId) {
  const paths = managedAccountPaths(accountId);
  const identity = readJsonFile('/root/.openclaw/identity/device.json', {});
  const deviceId = identity.deviceId;
  if (!deviceId) throw new Error('API device identity is missing');

  const devicesDir = path.join(paths.base, 'devices');
  const pairedPath = path.join(devicesDir, 'paired.json');
  const pendingPath = path.join(devicesDir, 'pending.json');
  const paired = readJsonFile(pairedPath, {});
  const device = paired[deviceId];
  // A brand-new empty slot has not started its gateway yet, so there cannot
  // be a paired API device at initialization time. Pairing is optional for
  // the QR bootstrap path and can be hardened after the gateway has started.
  if (!device?.tokens?.operator) return false;

  const scopes = ['operator.read', 'operator.admin', 'operator.write', 'operator.pairing'];
  device.scopes = scopes;
  device.tokens.operator.scopes = scopes;
  fs.writeFileSync(pairedPath, JSON.stringify(paired, null, 2) + '\n', { mode: 0o600 });

  const identityDir = path.join(paths.base, 'identity');
  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync('/root/.openclaw/identity/device.json', path.join(identityDir, 'device.json'));
  fs.chmodSync(path.join(identityDir, 'device.json'), 0o600);
  fs.writeFileSync(path.join(identityDir, 'device-auth.json'), JSON.stringify({
    version: 1,
    deviceId,
    tokens: { operator: device.tokens.operator },
  }, null, 2) + '\n', { mode: 0o600 });

  const pending = readJsonFile(pendingPath, {});
  for (const [requestId, request] of Object.entries(pending)) {
    if (request?.deviceId === deviceId) delete pending[requestId];
  }
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 });
  return true;
}

app.get('/managed-router/:accountId/status', async (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }
  const { credsDir, serviceName, routesFile, configPath } = managedAccountPaths(accountId);
  const identity = whatsappSessionIdentity(credsDir);
  const expectedPhone = normalizePhone(req.query.expected_phone);
  const actualPhone = normalizePhone(identity.session_phone);
  const phoneMatches = !expectedPhone || (Boolean(actualPhone) && actualPhone === expectedPhone);
  let serviceStatus = 'unknown';
  try { serviceStatus = run(`systemctl is-active ${quote(serviceName)} 2>/dev/null; true`); } catch { serviceStatus = 'inactive'; }
  const routes = readManagedRoutes(accountId);
  const model = getManagedModelRuntime(serviceName);
  const channel = serviceStatus === 'active'
    ? await getManagedChannelRuntime(accountId)
    : { checked: false, connected: false, running: false, linked: identity.credentials_exist, health_state: 'service-inactive', error_category: 'gateway_inactive', last_error: null };
  const connected = identity.credentials_exist && serviceStatus === 'active' && phoneMatches && channel.connected;
  res.json({
    ok: true,
    account_id: accountId,
    wa_connected: connected,
    credentials_exist: identity.credentials_exist,
    config_exists: fs.existsSync(configPath),
    session_phone: identity.session_phone,
    session_name: identity.session_name,
    expected_phone: expectedPhone ? `+${expectedPhone}` : null,
    phone_matches: phoneMatches,
    service_status: serviceStatus,
    route_count: routes.length,
    channel,
    model,
  });
});

app.put('/managed-router/:accountId/routes', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }
  const routes = req.body?.routes;
  const account = req.body?.account || {};
  if (!Array.isArray(routes)) {
    return res.status(400).json({ ok: false, error: 'routes array is required' });
  }
  try {
    const paths = managedAccountPaths(accountId);
    const previousRoutes = readManagedRoutes(accountId);
    const previousConfig = readJsonFile(paths.configPath, null);
    const config = buildManagedNativeConfig(accountId, routes, account);
    const sessionOverridesCleared = account.single_model_mode === true
      ? (account.dm_clients || []).reduce(
          (total, client) => total + (
            client?.client_name
              ? clearClientSessionModelOverrides(client.client_name).changed
              : 0
          ),
          0,
        )
      : 0;
    const routesChanged = JSON.stringify(previousRoutes) !== JSON.stringify(routes);
    const configChanged = JSON.stringify(previousConfig) !== JSON.stringify(config);
    const { serviceName } = paths;
    const active = run(`systemctl is-active ${quote(serviceName)} 2>/dev/null; true`) === 'active';

    // Provision is intentionally idempotent. Restarting an unchanged managed
    // gateway creates a 25-35 second boot window and can make the immediately
    // following cron sync exceed an upstream 30-second proxy timeout.
    if (!routesChanged && !configChanged && active) {
      return res.json({
        ok: true,
        success: true,
        route_count: routes.length,
        routing_mode: 'native-bindings',
        gateway_port: config.gateway.port,
        restarted: false,
        unchanged: true,
        session_model_overrides_cleared: sessionOverridesCleared,
      });
    }

    writeManagedRoutes(accountId, routes);
    const restarted = active;
    if (restarted) run(`systemctl stop ${quote(serviceName)}`);
    installManagedNativeService(accountId, config);
    ensureManagedApiDeviceScopes(accountId);
    run(`systemctl start ${quote(serviceName)}`);
    res.json({
      ok: true,
      success: true,
      route_count: routes.length,
      routing_mode: 'native-bindings',
      gateway_port: config.gateway.port,
      restarted,
      session_model_overrides_cleared: sessionOverridesCleared,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Failed to compile native managed gateway', detail: error.message });
  }
});

app.post('/managed-router/:accountId/routes', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }
  const route = req.body;
  if (!route?.group_jid) {
    return res.status(400).json({ ok: false, error: 'group_jid is required' });
  }
  const routes = readManagedRoutes(accountId);
  const idx = routes.findIndex(r => r.group_jid === route.group_jid);
  if (idx >= 0) routes[idx] = route; else routes.push(route);
  writeManagedRoutes(accountId, routes);
  res.json({ ok: true, success: true, upserted: route.group_jid });
});

app.delete('/managed-router/:accountId/routes/:groupJid', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }
  const groupJid = decodeURIComponent(req.params.groupJid);
  const routes = readManagedRoutes(accountId);
  const next = routes.filter(r => r.group_jid !== groupJid);
  writeManagedRoutes(accountId, next);
  res.json({ ok: true, success: true, removed: routes.length - next.length });
});

app.post('/managed-router/:accountId/reload', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }
  const { serviceName } = managedAccountPaths(accountId);
  try {
    const active = run(`systemctl is-active ${quote(serviceName)} 2>/dev/null; true`) === 'active';
    if (active) run(`systemctl restart ${quote(serviceName)}`);
    res.json({ ok: true, success: true, active, message: active ? 'Native gateway restarted' : 'Config ready; QR login is still required' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/managed-router/:accountId/activate', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const { credsDir, serviceName } = managedAccountPaths(accountId);
  if (!fs.existsSync(path.join(credsDir, 'creds.json'))) {
    return res.status(422).json({ ok: false, error: 'WhatsApp belum login. Jalankan login QR terlebih dahulu.' });
  }
  try {
    run(`systemctl enable ${quote(serviceName)}`);
    run(`systemctl restart ${quote(serviceName)}`);
    res.json({ ok: true, success: true, service_status: 'active' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/managed-router/:accountId/login/start', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const current = managedLoginSessions.get(accountId);
  if (current?.status === 'running') return res.json({ ok: true, status: 'running' });
  const paths = managedAccountPaths(accountId);
  if (!fs.existsSync(paths.configPath)) return res.status(422).json({ ok: false, error: 'Push managed routes terlebih dahulu.' });
  const identity = whatsappSessionIdentity(paths.credsDir);
  if (identity.credentials_exist) {
    return res.status(409).json({
      ok: false,
      error: 'Session WhatsApp sudah ada. Reset session terlebih dahulu jika ingin pair ulang.',
      session_phone: identity.session_phone,
    });
  }

  const command = `${NODE_BIN} ${OPENCLAW_BIN} channels login --channel whatsapp`;
  const child = spawn('/usr/bin/script', ['-qefc', command, '/dev/null'], {
    env: { ...process.env, HOME: '/root', OPENCLAW_STATE_DIR: paths.base, OPENCLAW_CONFIG_PATH: paths.configPath, CODEX_HOME: '/root/.codex', TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const session = { status: 'running', output: '', started_at: new Date().toISOString(), exit_code: null, child };
  managedLoginSessions.set(accountId, session);
  // A WhatsApp QR rendered with ANSI background cells can exceed 30 KB.
  // Keep enough terminal output for at least one complete OpenClaw QR; cutting
  // through the matrix produces a wide, incomplete image that cannot be scanned.
  const append = (chunk) => { session.output = (session.output + chunk.toString()).slice(-250000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => { session.status = 'failed'; session.output += `\n${error.message}`; });
  child.on('exit', (code) => {
    session.exit_code = code;
    const paired = fs.existsSync(path.join(paths.credsDir, 'creds.json'));
    session.status = paired ? 'activating' : (code === 0 ? 'finished' : 'failed');

    // QR login and the permanent gateway are separate processes. Activate the
    // gateway here as soon as credentials exist so success does not depend on
    // a browser polling /login/status at exactly the right time.
    if (paired) {
      try {
        run(`systemctl enable ${quote(paths.serviceName)}`);
        run(`systemctl restart ${quote(paths.serviceName)}`);
        session.status = 'connected';
        session.activated_at = new Date().toISOString();
      } catch (error) {
        session.status = 'activation_failed';
        session.activation_error = error.message;
      }
    }
  });
  setTimeout(() => {
    if (session.status === 'running') { child.kill('SIGTERM'); session.status = 'timeout'; }
  }, 180000);
  res.json({ ok: true, status: 'running' });
});

app.post('/managed-router/:accountId/session/reset', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });

  const paths = managedAccountPaths(accountId);
  const session = managedLoginSessions.get(accountId);
  if (session?.status === 'running' && session.child) {
    session.child.kill('SIGTERM');
    session.status = 'cancelled';
  }

  try { run(`systemctl stop ${quote(paths.serviceName)} 2>/dev/null || true`); } catch {}

  const credsRoot = path.dirname(paths.credsDir);
  let backup_path = null;
  if (fs.existsSync(credsRoot)) {
    backup_path = `${credsRoot}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(credsRoot, backup_path);
  }
  fs.mkdirSync(paths.credsDir, { recursive: true, mode: 0o700 });
  managedLoginSessions.delete(accountId);

  res.json({ ok: true, reset: true, backup_path, service_status: 'stopped' });
});

app.get('/managed-router/:accountId/login/status', async (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const paths = managedAccountPaths(accountId);
  const session = managedLoginSessions.get(accountId);
  const credentialsExist = fs.existsSync(path.join(paths.credsDir, 'creds.json'));
  const runtime = credentialsExist ? await getManagedChannelRuntime(accountId) : null;
  const connected = runtime?.connected === true;
  const renderTerminalOutput = (value) => String(value || '')
    // OpenClaw renders QR modules as two spaces with ANSI background colors.
    // Convert them before removing ANSI so browsers receive a scannable,
    // monochrome QR instead of blank lines.
    .replace(/\x1B\[40m {2}\x1B\[0m/g, '██')
    .replace(/\x1B\[47m {2}\x1B\[0m/g, '  ')
    // OSC sequences (terminal title, hyperlinks, and similar payloads).
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    // CSI sequences (colors, cursor movement, erase-line, etc.).
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // Remaining two-byte escape sequences.
    .replace(/\x1B[@-_]/g, '')
    .replace(/\r/g, '');
  res.json({
    ok: true,
    status: connected ? 'connected' : (credentialsExist ? 'linked_not_connected' : (session?.status || 'idle')),
    connected,
    credentials_exist: credentialsExist,
    runtime,
    output: renderTerminalOutput(session?.output || ''),
    started_at: session?.started_at || null,
    exit_code: session?.exit_code ?? null,
    activated_at: session?.activated_at || null,
    activation_error: session?.activation_error || null,
  });
});

app.post('/managed-router/:accountId/create-group', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }

  const { group_name, participant_phone, idempotency_key } = req.body;
  const description = String(req.body.description || '').trim().slice(0, 500);
  if (!group_name) return res.status(400).json({ ok: false, error: 'group_name is required' });
  if (!participant_phone) return res.status(400).json({ ok: false, error: 'participant_phone is required' });
  if (!/^\+?[0-9]{8,15}$/.test(participant_phone.replace(/\s/g, ''))) {
    return res.status(400).json({ ok: false, error: 'participant_phone must be a valid phone number' });
  }

  const { base, credsDir, serviceName } = managedAccountPaths(accountId);
  const groupRegistryFile = path.join(base, 'provisioned-groups.json');
  const groupRegistry = readJsonFile(groupRegistryFile, {});
  if (idempotency_key && groupRegistry[idempotency_key]) {
    return res.json({ ok: true, success: true, ...groupRegistry[idempotency_key], reused: true });
  }
  if (!fs.existsSync(path.join(credsDir, 'creds.json'))) {
    return res.status(400).json({
      ok: false,
      error: `Managed WA account ${accountId} has no active session. Scan QR first and store creds at: ${credsDir}`,
    });
  }

  const scriptPath = path.join(__dirname, 'wa-create-group.js');
  const nodebin = process.execPath;

  try {
    try { run(`systemctl stop ${quote(serviceName)} 2>/dev/null || true`); } catch {}

    const cmd = `${quote(nodebin)} ${quote(scriptPath)} ${quote(credsDir)} ${quote(group_name)} ${quote(participant_phone)}`;

    exec(cmd, {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, WA_GROUP_DESCRIPTION: description },
    }, (error, stdout) => {
      try { run(`systemctl start ${quote(serviceName)} 2>/dev/null || true`); } catch {}

      let result;
      try { result = JSON.parse(stdout.trim()); } catch {
        return res.status(500).json({ ok: false, error: 'Failed to parse group creation output', raw: stdout.slice(0, 200) });
      }

      if (!result.ok) return res.status(500).json(result);

      if (idempotency_key) {
        fs.mkdirSync(base, { recursive: true });
        groupRegistry[idempotency_key] = {
          group_id: result.group_id,
          invite_link: result.invite_link || null,
          group_name,
          partial_success: Boolean(result.partial_success),
          participant_added: result.participant_added !== false,
          missing_participants: result.missing_participants || [],
          warning: result.warning || null,
        };
        fs.writeFileSync(groupRegistryFile, JSON.stringify(groupRegistry, null, 2) + '\n');
      }

      sendTelegram(
        `✅ <b>Group WA Managed berhasil dibuat!</b>\n\n` +
        `🏦 Account: <code>#${accountId}</code>\n` +
        `👥 Group: <b>${group_name}</b>\n` +
        `🆔 JID: <code>${result.group_id}</code>` +
        (result.invite_link ? `\n🔗 <a href="${result.invite_link}">Link Undangan</a>` : '')
      );

      res.json({ ok: true, success: true, ...result });
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/managed-router/:accountId/group-invites', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }

  const registry = readJsonFile(path.join(managedAccountPaths(accountId).base, 'provisioned-groups.json'), {});
  const groups = Object.entries(registry).map(([idempotencyKey, entry]) => ({
    idempotency_key: idempotencyKey,
    group_id: entry.group_id || null,
    group_name: entry.group_name || null,
    invite_link: entry.invite_link || null,
    participant_added: entry.participant_added !== false,
    partial_success: Boolean(entry.partial_success),
    warning: entry.warning || null,
  }));

  res.json({ ok: true, groups });
});

app.delete('/managed-router/:accountId/clients/:clientId/registry', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  const clientId = parseInt(req.params.clientId);
  if (!Number.isInteger(accountId) || accountId < 1 || !Number.isInteger(clientId) || clientId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId or clientId' });
  }
  const clientName = String(req.query.client_name || '');
  if (!validName(clientName)) {
    return res.status(400).json({ ok: false, error: 'Valid client_name is required' });
  }

  const registryFile = path.join(managedAccountPaths(accountId).base, 'provisioned-groups.json');
  const registry = readJsonFile(registryFile, {});
  const prefix = `client:${clientId}:`;
  let removed = 0;
  for (const key of Object.keys(registry)) {
    if (!key.startsWith(prefix)) continue;
    delete registry[key];
    removed += 1;
  }
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n');
  const cronJobsRemoved = removeManagedClientCronJobs(accountId, clientName);
  res.json({ ok: true, removed, cron_jobs_removed: cronJobsRemoved });
});

app.post('/managed-router/:accountId/create-groups', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }

  const requested = req.body?.groups;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 8) {
    return res.status(400).json({ ok: false, error: 'groups must contain 1-8 entries' });
  }
  for (const group of requested) {
    if (!group?.group_name || !group?.participant_phone || !group?.idempotency_key) {
      return res.status(400).json({ ok: false, error: 'Each group requires group_name, participant_phone, and idempotency_key' });
    }
    if (!/^\+?[0-9]{8,15}$/.test(String(group.participant_phone).replace(/\s/g, ''))) {
      return res.status(400).json({ ok: false, error: 'participant_phone must be a valid phone number' });
    }
    if (group.description !== undefined && typeof group.description !== 'string') {
      return res.status(400).json({ ok: false, error: 'description must be a string' });
    }
    group.description = String(group.description || '').trim().slice(0, 500);
  }

  const { base, credsDir, serviceName } = managedAccountPaths(accountId);
  if (!fs.existsSync(path.join(credsDir, 'creds.json'))) {
    return res.status(400).json({ ok: false, error: 'Managed WhatsApp session is not paired' });
  }

  const registryFile = path.join(base, 'provisioned-groups.json');
  const registry = readJsonFile(registryFile, {});
  const reused = [];
  const pending = [];
  for (const group of requested) {
    const existing = registry[group.idempotency_key];
    if (existing) reused.push({ ...existing, idempotency_key: group.idempotency_key, reused: true });
    else pending.push(group);
  }
  if (pending.length === 0) {
    return res.json({ ok: true, success: true, groups: reused, reused_count: reused.length, created_count: 0 });
  }

  try { run(`systemctl stop ${quote(serviceName)} 2>/dev/null || true`); } catch {}
  const scriptPath = path.join(__dirname, 'wa-create-groups.js');
  execFile(process.execPath, [scriptPath, credsDir, JSON.stringify(pending)], {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  }, (error, stdout) => {
    try { run(`systemctl start ${quote(serviceName)} 2>/dev/null || true`); } catch {}

    let result;
    try { result = JSON.parse(stdout.trim()); } catch {
      return res.status(500).json({ ok: false, error: 'Failed to parse batch group output', raw: stdout.slice(0, 300) });
    }
    if (error || !result.ok) {
      return res.status(500).json({ ok: false, error: result?.error || error?.message || 'Batch group creation failed', groups: result?.groups || [] });
    }

    for (const group of result.groups) {
      const source = pending.find(item => item.idempotency_key === group.idempotency_key);
      registry[group.idempotency_key] = {
        group_id: group.group_id,
        invite_link: group.invite_link || null,
        group_name: source?.group_name || group.group_name,
        partial_success: Boolean(group.partial_success),
        participant_added: group.participant_added !== false,
        missing_participants: group.missing_participants || [],
        warning: group.warning || null,
      };
    }
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n');

    sendTelegram(
      `✅ <b>${result.groups.length} Group WA Managed dibuat</b>\n\n` +
      result.groups.map(group => {
        const saved = registry[group.idempotency_key];
        return `👥 <b>${saved.group_name}</b>\n🆔 <code>${saved.group_id}</code>` +
          (saved.invite_link ? `\n🔗 <a href="${saved.invite_link}">Link Undangan</a>` : '');
      }).join('\n\n')
    );

    res.json({
      ok: true,
      success: true,
      groups: [...reused, ...result.groups],
      reused_count: reused.length,
      created_count: result.groups.length,
    });
  });
});

// ── ChatGPT Model Pool ─────────────────────────────────────────────────────

app.get('/model-pool/:accountId/status', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const profiles = readModelPoolProfiles(accountId);
  const health = checkModelPoolHealth(accountId, profiles);
  res.json({
    ok: true,
    account_id: accountId,
    auth_status: health.status,
    health,
    profiles,
    login_status: modelPoolLoginSessions.get(accountId)?.status || 'idle',
  });
});

app.post('/model-pool/:accountId/login/start', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const current = modelPoolLoginSessions.get(accountId);
  if (current?.status === 'running') return res.json({ ok: true, status: 'running' });
  const paths = ensureModelPool(accountId);
  let backup = null;
  if (req.body?.force === true && fs.existsSync(paths.sqlitePath)) {
    try {
      backup = JSON.parse(execFileSync('python3', [MODEL_POOL_SCRIPT, 'backup', '--db', paths.sqlitePath, '--backup-dir', paths.backupsDir], { encoding: 'utf8', timeout: 30000 }));
    } catch (error) {
      return res.status(500).json({ ok: false, error: 'Pool backup failed; reconnect was not started', detail: String(error.stderr || error.message || '').slice(0, 500) });
    }
  }
  const args = [OPENCLAW_BIN, 'models', 'auth', 'login', '--provider', 'openai'];
  if (req.body?.force === true) args.push('--force');
  const command = [NODE_BIN, ...args].map(quote).join(' ');
  const child = spawn('/usr/bin/script', ['-qefc', command, '/dev/null'], {
    env: modelPoolEnv(paths),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = { status: 'running', output: '', started_at: new Date().toISOString(), exit_code: null, child };
  modelPoolLoginSessions.set(accountId, session);
  const append = chunk => { session.output = (session.output + chunk.toString()).slice(-250000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => { session.status = 'failed'; session.output += `\n${error.message}`; });
  child.on('exit', code => {
    session.exit_code = code;
    const activeProfile = readModelPoolProfiles(accountId).some(profile => !profile.expired);
    session.status = code === 0 && activeProfile ? 'connected' : (code === 0 ? 'finished' : 'failed');
    delete session.child;
  });
  setTimeout(() => {
    if (session.status === 'running') { session.child?.kill('SIGTERM'); session.status = 'timeout'; }
  }, 300000);
  res.json({ ok: true, status: 'running', backup: backup?.backup_name || null });
});

app.post('/model-pool/:accountId/login/input', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const session = modelPoolLoginSessions.get(accountId);
  if (!session?.child || session.status !== 'running') return res.status(409).json({ ok: false, error: 'No active login session' });
  const input = String(req.body?.input || '');
  if (!input || input.length > 4096) return res.status(422).json({ ok: false, error: 'Input must contain 1-4096 characters' });
  // Interactive prompts running inside a PTY submit on carriage return. A
  // newline alone is rendered but does not trigger the prompt's Enter key.
  session.child.stdin.write(input);
  session.child.stdin.write('\r');
  res.json({ ok: true, accepted: true });
});

app.get('/model-pool/:accountId/login/status', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const session = modelPoolLoginSessions.get(accountId);
  const profiles = readModelPoolProfiles(accountId);
  res.json({
    ok: true,
    status: session?.status || (profiles.some(profile => !profile.expired) ? 'connected' : 'idle'),
    output: sanitizeTerminalOutput(session?.output || ''),
    profiles,
    started_at: session?.started_at || null,
    exit_code: session?.exit_code ?? null,
  });
});

app.post('/model-pool/:accountId/login/cancel', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const session = modelPoolLoginSessions.get(accountId);
  if (session?.child && session.status === 'running') session.child.kill('SIGTERM');
  if (session) session.status = 'cancelled';
  res.json({ ok: true, status: session?.status || 'idle' });
});

app.post('/model-pool/:accountId/sync', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const profileId = String(req.body?.profile_id || '');
  const clients = [...new Set(Array.isArray(req.body?.clients) ? req.body.clients.map(String) : [])];
  if (!profileId.startsWith('openai:')) return res.status(422).json({ ok: false, error: 'A valid OpenAI profile_id is required' });
  if (clients.length < 1 || clients.length > 20) return res.status(422).json({ ok: false, error: 'Select 1-20 clients' });
  if (!readModelPoolProfiles(accountId).some(profile => profile.profile_id === profileId && !profile.expired)) {
    return res.status(422).json({ ok: false, error: 'Selected pool profile is missing or expired' });
  }
  if (modelPoolLoginSessions.get(accountId)?.status === 'running') {
    return res.status(409).json({ ok: false, error: 'Finish or cancel the pool login before syncing clients' });
  }
  if ([...modelPoolSyncJobs.values()].some(job => job.account_id === accountId && job.status === 'running')) {
    return res.status(409).json({ ok: false, error: 'Another sync job is already running for this pool' });
  }
  const paths = ensureModelPool(accountId);
  const job = {
    id: crypto.randomUUID(), account_id: accountId, profile_id: profileId,
    clients, replace_existing: req.body?.replace_existing !== false,
    status: 'running', results: [], started_at: new Date().toISOString(), finished_at: null,
  };
  modelPoolSyncJobs.set(job.id, job);
  writeModelPoolJob(paths, job);
  job.promise = (async () => {
    for (const client of clients) {
      job.results.push(await syncModelPoolClient(accountId, profileId, client, job.replace_existing));
      writeModelPoolJob(paths, job);
    }
    job.status = job.results.every(result => result.ok) ? 'completed' : (job.results.some(result => result.ok) ? 'partial' : 'failed');
    job.finished_at = new Date().toISOString();
    writeModelPoolJob(paths, job);
    sendTelegram(`🤖 <b>ChatGPT Pool sync ${job.status}</b>\nPool: <code>#${accountId}</code>\nSuccess: ${job.results.filter(item => item.ok).length}/${job.results.length}`);
  })();
  res.status(202).json({ ok: true, job_id: job.id, status: job.status });
});

app.get('/model-pool/:accountId/sync/:jobId', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) return res.status(400).json({ ok: false, error: 'Invalid jobId' });
  const paths = ensureModelPool(accountId);
  const memory = modelPoolSyncJobs.get(req.params.jobId);
  const persisted = readJsonFile(path.join(paths.jobsDir, `${req.params.jobId}.json`), null);
  const job = memory || persisted;
  if (!job || job.account_id !== accountId) return res.status(404).json({ ok: false, error: 'Sync job not found' });
  const safe = { ...job };
  delete safe.promise;
  res.json({ ok: true, job: safe });
});

app.get('/model-pool/:accountId/backups', (req, res) => {
  const accountId = Number(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const paths = ensureModelPool(accountId);
  const backups = fs.readdirSync(paths.backupsDir)
    .filter(name => /^pool-auth-[0-9]+\.sqlite$/.test(name))
    .map(name => ({ name, created_at: fs.statSync(path.join(paths.backupsDir, name)).mtime.toISOString() }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ ok: true, backups });
});

app.post('/model-pool/:accountId/backups/:backupName/restore', (req, res) => {
  const accountId = Number(req.params.accountId);
  const backupName = String(req.params.backupName || '');
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  if (!/^pool-auth-[0-9]+\.sqlite$/.test(backupName)) return res.status(400).json({ ok: false, error: 'Invalid backup name' });
  if (modelPoolLoginSessions.get(accountId)?.status === 'running') return res.status(409).json({ ok: false, error: 'Cancel login before restoring a backup' });
  const paths = ensureModelPool(accountId);
  const backupPath = path.join(paths.backupsDir, backupName);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ ok: false, error: 'Backup not found' });
  try {
    let safetyBackup = null;
    if (fs.existsSync(paths.sqlitePath)) {
      safetyBackup = JSON.parse(execFileSync('python3', [MODEL_POOL_SCRIPT, 'backup', '--db', paths.sqlitePath, '--backup-dir', paths.backupsDir], { encoding: 'utf8', timeout: 30000 }));
    }
    const restored = JSON.parse(execFileSync('python3', [MODEL_POOL_SCRIPT, 'restore', '--backup', backupPath, '--target', paths.sqlitePath], { encoding: 'utf8', timeout: 30000 }));
    res.json({ ok: true, restored: restored.restored, safety_backup: safetyBackup?.backup_name || null, profiles: readModelPoolProfiles(accountId) });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Pool restore failed', detail: String(error.stderr || error.message || '').slice(0, 500) });
  }
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`OpenClaw API Server running on ${HOST}:${PORT}`);
    recoverInterruptedModelPoolJobs();
    setTimeout(() => {
      try { monitorDisk(); } catch {}
    }, 3000);
    setInterval(() => {
      try { monitorDisk(); } catch {}
    }, DISK_MONITOR_INTERVAL_MS);
    setTimeout(() => {
      try { monitorCronHealth(); } catch (error) { console.error(`Cron health monitor failed: ${error.message}`); }
    }, 10000);
    setInterval(() => {
      try { monitorCronHealth(); } catch (error) { console.error(`Cron health monitor failed: ${error.message}`); }
    }, CRON_HEALTH_MONITOR_INTERVAL_MS);
    setTimeout(() => monitorManagedWhatsApp().catch(() => {}), 5000);
    setInterval(() => monitorManagedWhatsApp().catch(() => {}), 300000);
    setTimeout(() => monitorModelPools().catch(() => {}), 15000);
    setInterval(() => monitorModelPools().catch(() => {}), 300000);
  });
}

module.exports = { cronHealthIssue, normalizeWebSearchPolicy };
