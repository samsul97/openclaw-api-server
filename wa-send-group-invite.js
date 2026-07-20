#!/usr/bin/env node
// Send an existing WhatsApp group's current invite link to one owner via DM.
// Run only while the OpenClaw gateway using the same credentials is stopped.

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const NOOP_LOGGER = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
  error: () => {}, fatal: () => {}, child: () => NOOP_LOGGER,
};

function out(data) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

async function main() {
  const [,, credsDir, groupId, rawPhone, groupName = 'grup WhatsApp'] = process.argv;
  if (!credsDir || !groupId || !rawPhone) {
    out({ ok: false, error: 'Usage: wa-send-group-invite.js <creds_dir> <group_id> <phone> [group_name]' });
    process.exit(1);
  }

  const ownerJid = `${rawPhone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  const timeout = setTimeout(() => {
    out({ ok: false, error: 'Timeout: WA connection took too long' });
    process.exit(1);
  }, 45000);

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
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        try {
          const code = await sock.groupInviteCode(groupId);
          const inviteLink = `https://chat.whatsapp.com/${code}`;
          await sock.sendMessage(ownerJid, {
            text: `Anda diundang bergabung ke grup WhatsApp “${groupName}”.\n\n${inviteLink}\n\nBuka link lalu tekan Join Group.`,
          });
          clearTimeout(timeout);
          out({ ok: true, group_id: groupId, owner_jid: ownerJid, invite_sent: true });
          await sock.end();
          process.exit(0);
        } catch (error) {
          clearTimeout(timeout);
          out({ ok: false, error: error.message });
          await sock.end();
          process.exit(1);
        }
      } else if (connection === 'close' && lastDisconnect && !lastDisconnect.error) {
        clearTimeout(timeout);
      }
    });
  } catch (error) {
    clearTimeout(timeout);
    out({ ok: false, error: error.message });
    process.exit(1);
  }
}

main();
