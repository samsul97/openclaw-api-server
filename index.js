const express = require('express');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = 18799;
const HOST = '127.0.0.1';
const API_TOKEN = process.env.OPENCLAW_API_TOKEN || 'changeme-set-env-var';
const SCRIPTS_DIR = '/root';

const WORKSPACE_FILES = new Set([
  'SOUL.md',
  'USER.md',
  'AGENTS.md',
  'MEMORY.md',
  'IDENTITY.md',
  'HEARTBEAT.md',
]);

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

function run(cmd, options = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 60000, ...options }).trim();
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

  return {
    ...existing,
    meta: {
      ...(existing.meta || {}),
      name,
      assistantType: payload.assistant_type || existing.meta?.assistantType || 'custom',
      dashboardManaged: true,
      assistants: payload.assistants || [],
      integrations: payload.integrations || [],
      linuxUser: payload.linux_user || paths.linuxUser,
      stateDir: payload.state_dir || paths.stateDir,
      workspaceDir: payload.workspace_dir || paths.workspaceDir,
      codexHome: payload.codex_home || paths.codexHome,
    },
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
        groupAllowFrom: inferGlobalGroupAllowFrom(payload.groups || [], allowFrom, existing.channels?.whatsapp?.groupAllowFrom || []),
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
      entries: {
        openai: { enabled: true },
        whatsapp: { enabled: true },
      },
    },
  };
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
  if (!['creator', 'finance', 'jobseeker', 'custom'].includes(assistant_type)) return res.status(400).json({ ok: false, error: 'assistant_type must be creator|finance|jobseeker|custom' });

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

app.listen(PORT, HOST, () => {
  console.log(`OpenClaw API Server running on ${HOST}:${PORT}`);
  console.log(`Token: ${API_TOKEN.slice(0, 8)}...`);
});
