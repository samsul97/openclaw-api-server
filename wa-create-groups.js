#!/usr/bin/env node
// Create several WhatsApp groups through one Baileys connection. The caller
// must stop the gateway first and start it again after this process exits.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ensureParticipants } = require('./wa-group-participants');

const NOOP_LOGGER = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
  error: () => {}, fatal: () => {}, child: () => NOOP_LOGGER,
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadManagedBaileys(credsDir) {
  const stateDir = path.resolve(credsDir, '../../..');
  const projectsDir = path.join(stateDir, 'npm', 'projects');
  const projects = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [];
  const candidates = projects
    .filter(name => name.startsWith('openclaw-whatsapp-'))
    .map(name => path.join(
      projectsDir, name, 'node_modules', '@openclaw', 'whatsapp', 'node_modules', 'baileys'
    ));
  const packageDir = candidates.find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  if (!packageDir) throw new Error('Managed OpenClaw WhatsApp Baileys runtime was not found');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const entry = path.join(packageDir, metadata.main || 'lib/index.js');
  const runtime = await import(pathToFileURL(entry).href);
  return { ...runtime, packageName: metadata.name, packageVersion: metadata.version };
}

function createAtomicCredsSaver(credsDir, state, BufferJSON) {
  const credsFile = path.join(credsDir, 'creds.json');
  const backupFile = `${credsFile}.bak`;
  let queue = Promise.resolve();
  const save = () => {
    queue = queue.then(async () => {
      const temporary = path.join(credsDir, `.creds.group-${process.pid}-${Date.now()}.tmp`);
      if (fs.existsSync(credsFile)) fs.copyFileSync(credsFile, backupFile);
      fs.writeFileSync(temporary, JSON.stringify(state.creds, BufferJSON.replacer), { mode: 0o600 });
      const descriptor = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, credsFile);
    });
    return queue;
  };
  return { save, flush: () => queue };
}

function output(data, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(data)}\n`, () => process.exit(exitCode));
}

async function main() {
  const [,, credsDir, groupsJson] = process.argv;
  let groups;
  try { groups = JSON.parse(groupsJson || '[]'); } catch { groups = []; }
  if (!credsDir || !Array.isArray(groups) || groups.length < 1) {
    return output({ ok: false, error: 'Usage: wa-create-groups.js <creds_dir> <groups_json>' }, 1);
  }

  const timer = setTimeout(() => output({ ok: false, error: 'Timeout: batch group creation took too long' }, 1), 240000);
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      BufferJSON,
      packageName,
      packageVersion,
    } = await loadManagedBaileys(credsDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1023926] }));
    const { state } = await useMultiFileAuthState(credsDir);
    const credsSaver = createAtomicCredsSaver(credsDir, state, BufferJSON);
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, NOOP_LOGGER),
      },
      printQRInTerminal: false,
      logger: NOOP_LOGGER,
      browser: ['openclaw', 'cli', '2026.7.1'],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 20000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', credsSaver.save);

    let handled = false;
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open' && !handled) {
        handled = true;
        const results = [];
        try {
          let participatingGroups = [];
          try {
            participatingGroups = Object.values(await sock.groupFetchAllParticipating())
              .sort((left, right) => Number(right.creation || 0) - Number(left.creation || 0));
          } catch {}
          const claimedGroupIds = new Set();
          for (let index = 0; index < groups.length; index += 1) {
            const spec = groups[index];
            const participantJid = `${String(spec.participant_phone).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            const discovered = participatingGroups.find(group =>
              group?.id && group.subject === spec.group_name && !claimedGroupIds.has(group.id)
            );
            const created = discovered || await sock.groupCreate(spec.group_name, [participantJid]);
            claimedGroupIds.add(created.id);
            let descriptionSet = false;
            if (spec.description) {
              try {
                await sock.groupUpdateDescription(created.id, String(spec.description).slice(0, 500));
                descriptionSet = true;
              } catch {}
            }
            const verification = await ensureParticipants(
              sock, state.keys, created.id, [participantJid], created
            );
            const participantAdded = verification.missing.length === 0;
            let inviteLink = null;
            if (!participantAdded) {
              try { inviteLink = `https://chat.whatsapp.com/${await sock.groupInviteCode(created.id)}`; } catch {}
            }
            results.push({
              idempotency_key: spec.idempotency_key,
              group_id: created.id,
              group_name: spec.group_name,
              description_set: descriptionSet,
              partial_success: !participantAdded,
              participant_added: participantAdded,
              missing_participants: participantAdded ? [] : [participantJid],
              participant_add_results: verification.addResults,
              participant_count: verification.participantCount,
              invite_link: inviteLink,
              warning: participantAdded ? null : 'Owner belum masuk; gunakan link undangan tanpa retry otomatis.',
              discovered_existing: Boolean(discovered),
            });
            if (index < groups.length - 1) await delay(5000);
          }
          await delay(1000);
          await credsSaver.flush();
          await sock.end();
          clearTimeout(timer);
          output({ ok: true, groups: results, runtime: `${packageName}@${packageVersion}` });
        } catch (error) {
          try { await credsSaver.flush(); } catch {}
          try { await sock.end(); } catch {}
          clearTimeout(timer);
          output({ ok: false, error: error.message, groups: results }, 1);
        }
      } else if (connection === 'close' && !handled) {
        clearTimeout(timer);
        output({ ok: false, error: `WA connection closed (${lastDisconnect?.error?.output?.statusCode || 'unknown'})` }, 1);
      }
    });
  } catch (error) {
    clearTimeout(timer);
    output({ ok: false, error: error.message }, 1);
  }
}

if (require.main === module) main();

module.exports = { loadManagedBaileys, createAtomicCredsSaver };
