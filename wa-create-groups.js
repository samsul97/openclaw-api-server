#!/usr/bin/env node
// Create several WhatsApp groups through one Baileys connection. The caller
// must stop the gateway first and start it again after this process exits.

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const NOOP_LOGGER = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
  error: () => {}, fatal: () => {}, child: () => NOOP_LOGGER,
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  const timer = setTimeout(() => output({ ok: false, error: 'Timeout: batch group creation took too long' }, 1), 150000);
  try {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1023926] }));
    const { state, saveCreds } = await useMultiFileAuthState(credsDir);
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: NOOP_LOGGER,
      browser: ['OpenClaw', 'Chrome', '10.0'],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 20000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);

    let handled = false;
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open' && !handled) {
        handled = true;
        const results = [];
        try {
          for (let index = 0; index < groups.length; index += 1) {
            const spec = groups[index];
            const participantJid = `${String(spec.participant_phone).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            const created = await sock.groupCreate(spec.group_name, [participantJid]);
            let metadata = created;
            try { metadata = await sock.groupMetadata(created.id); } catch {}
            const participantIds = (metadata?.participants || created?.participants || [])
              .flatMap(participant => [participant?.id, participant?.phoneNumber])
              .filter(Boolean);
            const digits = participantJid.replace(/[^0-9]/g, '');
            const participantAdded = participantIds.some(actual => String(actual).replace(/[^0-9]/g, '').startsWith(digits));
            let inviteLink = null;
            if (!participantAdded) {
              try { inviteLink = `https://chat.whatsapp.com/${await sock.groupInviteCode(created.id)}`; } catch {}
            }
            results.push({
              idempotency_key: spec.idempotency_key,
              group_id: created.id,
              group_name: spec.group_name,
              partial_success: !participantAdded,
              participant_added: participantAdded,
              missing_participants: participantAdded ? [] : [participantJid],
              invite_link: inviteLink,
              warning: participantAdded ? null : 'Owner belum masuk; gunakan link undangan tanpa retry otomatis.',
            });
            if (index < groups.length - 1) await delay(5000);
          }
          await delay(1000);
          await sock.end();
          clearTimeout(timer);
          output({ ok: true, groups: results });
        } catch (error) {
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

main();
