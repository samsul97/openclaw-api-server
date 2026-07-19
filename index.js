const express = require('express');
const { exec, execSync, execFileSync, spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
const managedLoginSessions = new Map();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8731741557:AAFjdZjoXrcCdZPTHiJFjCjuo2ZRtOYP8YE';
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID  || '652689793';

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
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return execFileSync(NODE_BIN, [OPENCLAW_BIN, ...args], options);
    } catch (error) {
      lastError = error;
      const detail = String(error.stderr || error.message || '');
      const transient = /1006|ECONNREFUSED|not yet ready|closed before connect/i.test(detail);
      if (!transient || attempt === 8) throw error;
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

  return {
    name,
    trigger: firstAgent.groupChat?.mentionPatterns?.[0] || '',
    phone: wa.allowFrom?.[0] || '',
    port: config.gateway?.port,
    scope_package: groupAllowFrom.includes('*') ? 'team' : 'personal',
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
  const fallbacks = Array.isArray(payload.fallback_models) ? payload.fallback_models : [];

  const next = {
    ...existingConfig,
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
    tools: existing.tools || { profile: 'coding' },
    plugins: {
      ...(existing.plugins || {}),
      allow: [...new Set([...(existing.plugins?.allow || []), 'openai', 'whatsapp'])],
      bundledDiscovery: 'compat',
      entries: {
        ...(existing.plugins?.entries || {}),
        openai: { enabled: true },
        whatsapp: { enabled: true },
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
    req.body.workspace_dir ||
    req.body.codex_home
  );

  if (fullDashboardPayload) {
    const next = buildConfigFromDashboard(name, req.body, existing);
    writeClientConfig(name, next);
    if (req.body.blueprint !== undefined) writeBlueprint(name, req.body.blueprint);
    return res.json({ ok: true, success: true, restarted: false, message: `Client '${name}' full config updated`, port: next.gateway?.port });
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

  const cmd = `echo ${quote(name)} | bash ${quote(path.join(SCRIPTS_DIR, 'delete-client.sh'))} ${quote(name)} 2>&1`;
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
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return res.status(400).json({ ok: false, error: 'files object is required' });
  }

  const paths = clientPaths(name);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });

  const written = [];
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
    fs.writeFileSync(target, String(content ?? ''));
    chownIfHome(paths, target);
    written.push(file);
  }

  chownTreeIfHome(paths, paths.workspaceDir);
  res.json({ ok: true, success: true, written, workspace_dir: paths.workspaceDir });
});

app.put('/clients/:name/crons', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });

  const jobs = req.body?.jobs;
  if (!Array.isArray(jobs)) return res.status(400).json({ ok: false, error: 'jobs array is required' });

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

  try {
    const raw = execOpenClawAfterGatewayReady(['cron', 'list', '--json', ...connection], {
      encoding: 'utf8', timeout: 30000,
    });
    const parsed = JSON.parse(raw || '{}');
    const existingJobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    const existingByName = new Map(existingJobs.map((job) => [job.name, job]));
    const created = [];
    const existing = [];

    for (const job of jobs) {
      if (existingByName.has(job.slug)) {
        const current = existingByName.get(job.slug);
        if (!current.id) throw new Error(`Existing cron has no id: ${job.slug}`);
        execFileSync(NODE_BIN, [
          OPENCLAW_BIN, 'cron', 'edit', current.id,
          '--cron', job.schedule, '--tz', job.timezone || 'Asia/Jakarta',
          '--agent', job.agent || 'main', '--session', job.session || 'isolated',
          '--message', job.message, '--disable', '--no-deliver', ...connection,
        ], { encoding: 'utf8', timeout: 30000 });
        existing.push(job.slug);
        continue;
      }
      execFileSync(NODE_BIN, [
        OPENCLAW_BIN, 'cron', 'add', '--json', '--name', job.slug,
        '--cron', job.schedule, '--tz', job.timezone || 'Asia/Jakarta',
        '--agent', job.agent || 'main', '--session', job.session || 'isolated',
        '--message', job.message, '--disabled', '--no-deliver', ...connection,
      ], { encoding: 'utf8', timeout: 30000 });
      created.push(job.slug);
    }

    res.json({ ok: true, success: true, created, existing, enabled: 0 });
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
    ], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, cwd: paths.workspaceDir });
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
    res.status(500).json({ ok: false, error: 'Structured workspace adaptation failed', detail: String(error.stderr || error.message || '').slice(0, 1000) });
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

app.post('/clients/:name/crons/activate', (req, res) => {
  const { name } = req.params;
  if (!validName(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
  const config = getClientConfig(name);
  if (!config) return res.status(404).json({ ok: false, error: 'Client not found' });
  const jobs = req.body?.jobs;
  const target = String(req.body?.target || '');
  if (!Array.isArray(jobs) || !target) return res.status(422).json({ ok: false, error: 'jobs and delivery target are required' });
  if (!/^120[0-9]+@g\.us$/.test(target) && !/^\+[1-9][0-9]{6,14}$/.test(target)) {
    return res.status(422).json({ ok: false, error: 'Invalid WhatsApp delivery target' });
  }
  const connection = ['--url', `ws://127.0.0.1:${config.gateway?.port}`, '--token', config.gateway?.auth?.token];
  try {
    const raw = execOpenClawAfterGatewayReady(['cron', 'list', '--json', ...connection], { encoding: 'utf8', timeout: 30000 });
    const existing = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : (JSON.parse(raw).jobs || []);
    const requested = new Set(jobs.map((job) => job.slug));
    const enabled = [];
    for (const job of existing) {
      if (!requested.has(job.name) || !job.id) continue;
      execFileSync(NODE_BIN, [OPENCLAW_BIN, 'cron', 'edit', job.id, '--enable', '--announce', '--channel', 'whatsapp', '--to', target, ...connection], { encoding: 'utf8', timeout: 30000 });
      enabled.push(job.name);
    }
    res.json({ ok: true, enabled, channel: 'whatsapp', target });
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

    exec(cmd, { encoding: 'utf8', timeout: 60000 }, (error, stdout) => {
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

  const agents = [...clients.values()].map((route, index) => ({
    id: route.client_name,
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

  const bindings = routes.map((route) => ({
    agentId: route.client_name,
    comment: `Managed WA account ${accountId}, assistant slot ${route.assistant_slot || 1}`,
    match: {
      channel: 'whatsapp',
      peer: { kind: 'group', id: route.group_jid },
    },
  }));

  const groups = {};
  for (const route of routes) {
    groups[route.group_jid] = {
      requireMention: route.require_mention !== false,
      systemPrompt: route.system_prompt || undefined,
    };
  }

  const ownerPhones = [...new Set(routes.map((route) => route.owner_phone).filter(Boolean))];
  const allowEveryone = routes.some((route) => route.group_scope === 'everyone');
  const port = Number(account.gateway_port || existing.gateway?.port || (21000 + accountId * 20));
  const token = existing.gateway?.auth?.token || crypto.randomBytes(24).toString('hex');

  return {
    ...existingConfig,
    agents: {
      defaults: {
        ...(existing.agents?.defaults || {}),
        model: existing.agents?.defaults?.model || {
          primary: 'openai/gpt-5.5',
          fallbacks: [],
        },
      },
      list: agents,
    },
    bindings,
    channels: {
      whatsapp: {
        enabled: true,
        dmPolicy: 'disabled',
        allowFrom: [],
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
    tools: existing.tools || { profile: 'coding' },
    plugins: {
      allow: ['openai', 'whatsapp'],
      bundledDiscovery: 'compat',
      entries: {
        openai: { enabled: true },
        whatsapp: { enabled: true },
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

app.get('/managed-router/:accountId/status', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }
  const { credsDir, serviceName, routesFile } = managedAccountPaths(accountId);
  const credsExist = fs.existsSync(path.join(credsDir, 'creds.json'));
  let serviceStatus = 'unknown';
  try { serviceStatus = run(`systemctl is-active ${quote(serviceName)} 2>/dev/null; true`); } catch { serviceStatus = 'inactive'; }
  const routes = readManagedRoutes(accountId);
  res.json({ ok: true, account_id: accountId, wa_connected: credsExist, service_status: serviceStatus, route_count: routes.length });
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
  writeManagedRoutes(accountId, routes);
  try {
    const config = buildManagedNativeConfig(accountId, routes, account);
    installManagedNativeService(accountId, config);
    const { serviceName } = managedAccountPaths(accountId);
    let restarted = false;
    try {
      if (run(`systemctl is-active ${quote(serviceName)} 2>/dev/null; true`) === 'active') {
        run(`systemctl restart ${quote(serviceName)}`);
        restarted = true;
      }
    } catch {}
    res.json({ ok: true, success: true, route_count: routes.length, routing_mode: 'native-bindings', restarted });
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

  const command = `${NODE_BIN} ${OPENCLAW_BIN} channels login --channel whatsapp`;
  const child = spawn('/usr/bin/script', ['-qefc', command, '/dev/null'], {
    env: { ...process.env, HOME: '/root', OPENCLAW_STATE_DIR: paths.base, OPENCLAW_CONFIG_PATH: paths.configPath, CODEX_HOME: '/root/.codex', TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const session = { status: 'running', output: '', started_at: new Date().toISOString(), exit_code: null };
  managedLoginSessions.set(accountId, session);
  const append = (chunk) => { session.output = (session.output + chunk.toString()).slice(-30000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => { session.status = 'failed'; session.output += `\n${error.message}`; });
  child.on('exit', (code) => {
    session.exit_code = code;
    session.status = fs.existsSync(path.join(paths.credsDir, 'creds.json')) ? 'connected' : (code === 0 ? 'finished' : 'failed');
  });
  setTimeout(() => {
    if (session.status === 'running') { child.kill('SIGTERM'); session.status = 'timeout'; }
  }, 180000);
  res.json({ ok: true, status: 'running' });
});

app.get('/managed-router/:accountId/login/status', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  const paths = managedAccountPaths(accountId);
  const session = managedLoginSessions.get(accountId);
  const connected = fs.existsSync(path.join(paths.credsDir, 'creds.json'));
  const stripAnsi = (value) => String(value || '')
    // OSC sequences (terminal title, hyperlinks, and similar payloads).
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    // CSI sequences (colors, cursor movement, erase-line, etc.).
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // Remaining two-byte escape sequences.
    .replace(/\x1B[@-_]/g, '')
    .replace(/\r/g, '');
  res.json({ ok: true, status: connected ? 'connected' : (session?.status || 'idle'), connected, output: stripAnsi(session?.output || ''), started_at: session?.started_at || null, exit_code: session?.exit_code ?? null });
});

app.post('/managed-router/:accountId/create-group', (req, res) => {
  const accountId = parseInt(req.params.accountId);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid accountId' });
  }

  const { group_name, participant_phone, idempotency_key } = req.body;
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

    exec(cmd, { encoding: 'utf8', timeout: 60000 }, (error, stdout) => {
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

app.listen(PORT, HOST, () => {
  console.log(`OpenClaw API Server running on ${HOST}:${PORT}`);
});
