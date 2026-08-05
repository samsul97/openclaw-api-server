#!/usr/bin/env node
// wa-create-group.js — Create a WhatsApp group using existing Baileys session
// Usage: node wa-create-group.js <creds_dir> <group_name> <phone1> [phone2...]
// Output: JSON line to stdout: { ok, group_id, invite_link } or { ok, error }
//
// IMPORTANT: Run this ONLY while the openclaw gateway for this profile is STOPPED.
// The caller (VPS API) is responsible for stop/start of the gateway service.

const { ensureParticipants } = require('./wa-group-participants');
const { loadManagedBaileys, createAtomicCredsSaver } = require('./wa-create-groups');

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
      browser: ['openclaw', 'cli', '2026.6.6'],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 20000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', credsSaver.save);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        try {
          const result = await sock.groupCreate(groupName, participantJIDs);
          const groupId = result.id;
          let descriptionSet = false;
          if (process.env.WA_GROUP_DESCRIPTION) {
            try {
              await sock.groupUpdateDescription(groupId, process.env.WA_GROUP_DESCRIPTION.slice(0, 500));
              descriptionSet = true;
            } catch {}
          }

          const verification = await ensureParticipants(
            sock, state.keys, groupId, participantJIDs, result
          );
          const missingPhones = verification.missing;

          let inviteLink = null;
          try {
            const code = await sock.groupInviteCode(groupId);
            inviteLink = `https://chat.whatsapp.com/${code}`;
          } catch {
            // invite link is optional
          }

          clearTimeout(timeout);
          await credsSaver.flush();
          out({
            ok: true,
            partial_success: missingPhones.length > 0,
            participant_added: missingPhones.length === 0,
            requested_participants: participantJIDs,
            missing_participants: missingPhones,
            participant_count: verification.participantCount,
            participant_add_results: verification.addResults,
            group_id: groupId,
            description_set: descriptionSet,
            invite_link: inviteLink,
            warning: missingPhones.length > 0
              ? 'Group dibuat, tetapi member belum terverifikasi masuk. Gunakan link undangan.'
              : null,
            runtime: `${packageName}@${packageVersion}`,
          });
          await sock.end();
        } catch (err) {
          try { await credsSaver.flush(); } catch {}
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
