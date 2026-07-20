#!/usr/bin/env node
// wa-create-group.js — Create a WhatsApp group using existing Baileys session
// Usage: node wa-create-group.js <creds_dir> <group_name> <phone1> [phone2...]
// Output: JSON line to stdout: { ok, group_id, invite_link } or { ok, error }
//
// IMPORTANT: Run this ONLY while the openclaw gateway for this profile is STOPPED.
// The caller (VPS API) is responsible for stop/start of the gateway service.

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const NOOP_LOGGER = {
  trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {},  error: () => {}, fatal: () => {},
  child: () => NOOP_LOGGER,
};

async function main() {
  const [,, credsDir, groupName, ...rawPhones] = process.argv;

  if (!credsDir || !groupName || rawPhones.length === 0) {
    out({ ok: false, error: 'Usage: wa-create-group.js <creds_dir> <group_name> <phone1> [phone2...]' });
    process.exit(1);
  }

  // Format phones to WA JID: remove non-digits, append @s.whatsapp.net
  const participantJIDs = rawPhones.map(p => `${p.replace(/[^0-9]/g, '')}@s.whatsapp.net`);

  let settled = false;

  function out(data) {
    if (settled) return;
    settled = true;
    process.stdout.write(JSON.stringify(data) + '\n');
  }

  // Timeout guard: if nothing happens in 45s, exit with error
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
          const result = await sock.groupCreate(groupName, participantJIDs);
          const groupId = result.id;

          let metadata = result;
          try {
            metadata = await sock.groupMetadata(groupId);
          } catch {
            // The creation response still contains participant information on
            // most WhatsApp versions, so metadata refresh is best-effort.
          }

          const participantIds = (metadata?.participants || result?.participants || [])
            .flatMap(participant => [participant?.id, participant?.phoneNumber])
            .filter(Boolean);
          const addedPhones = participantJIDs.filter(requested => {
            const digits = requested.replace(/[^0-9]/g, '');
            return participantIds.some(actual => String(actual).replace(/[^0-9]/g, '').startsWith(digits));
          });
          const missingPhones = participantJIDs.filter(phone => !addedPhones.includes(phone));

          let inviteLink = null;
          try {
            const code = await sock.groupInviteCode(groupId);
            inviteLink = `https://chat.whatsapp.com/${code}`;
          } catch {
            // invite link is optional
          }

          let inviteSent = false;
          let inviteSendError = null;
          if (missingPhones.length > 0 && inviteLink) {
            try {
              for (const phone of missingPhones) {
                await sock.sendMessage(phone, {
                  text: `Anda diundang bergabung ke grup WhatsApp “${groupName}”.\n\n${inviteLink}\n\nBuka link lalu tekan Join Group.`,
                });
              }
              inviteSent = true;
            } catch (err) {
              inviteSendError = err.message;
            }
          }

          clearTimeout(timeout);
          out({
            ok: true,
            partial_success: missingPhones.length > 0,
            participant_added: missingPhones.length === 0,
            requested_participants: participantJIDs,
            missing_participants: missingPhones,
            participant_count: participantIds.length,
            group_id: groupId,
            invite_link: inviteLink,
            invite_sent: inviteSent,
            invite_send_error: inviteSendError,
            warning: missingPhones.length > 0
              ? (inviteSent
                  ? 'Group dibuat; link undangan sudah dikirim otomatis ke owner.'
                  : 'Group dibuat, tetapi member belum terverifikasi masuk. Gunakan link undangan.')
              : null,
          });
          await sock.end();
        } catch (err) {
          clearTimeout(timeout);
          out({ ok: false, error: err.message });
          await sock.end();
        }
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (!settled) {
          clearTimeout(timeout);
          out({ ok: false, error: `WA connection closed (code: ${code ?? 'unknown'}). Session may be inactive — scan QR first.` });
        }
      }
    });
  } catch (err) {
    clearTimeout(timeout);
    out({ ok: false, error: err.message });
    process.exit(1);
  }
}

main();
