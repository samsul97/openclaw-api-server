'use strict';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function jidUser(jid) {
  return String(jid || '').split('@', 1)[0].split(':', 1)[0].replace(/[^0-9]/g, '');
}

function isPhoneJid(jid) {
  return /@(s\.whatsapp\.net|hosted)$/.test(String(jid || ''));
}

function isLidJid(jid) {
  return /@(lid|hosted\.lid)$/.test(String(jid || ''));
}

async function participantPhoneDigits(participant, keys) {
  const values = [participant?.phoneNumber];
  if (isPhoneJid(participant?.id)) values.push(participant.id);

  // Newer WhatsApp groups are commonly LID-addressed. Baileys exposes
  // phoneNumber when the server supplies it; otherwise consult the persisted
  // reverse LID mapping maintained in the same auth state.
  const lid = isLidJid(participant?.id)
    ? participant.id
    : (isLidJid(participant?.lid) ? participant.lid : null);
  if (lid && keys?.get) {
    const lidUser = jidUser(lid);
    const stored = await keys.get('lid-mapping', [`${lidUser}_reverse`]).catch(() => ({}));
    values.push(stored?.[`${lidUser}_reverse`]);
  }

  return new Set(values.map(jidUser).filter(Boolean));
}

async function findMissingParticipants(metadata, requestedJids, keys) {
  const present = new Set();
  for (const participant of metadata?.participants || []) {
    for (const digits of await participantPhoneDigits(participant, keys)) present.add(digits);
  }
  return requestedJids.filter(jid => !present.has(jidUser(jid)));
}

async function fetchMetadata(sock, groupId, fallback, attempts = 3, waitMs = 1500) {
  let metadata = fallback;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 || !metadata) await delay(waitMs);
    try { metadata = await sock.groupMetadata(groupId); } catch {}
  }
  return metadata;
}

async function ensureParticipants(sock, keys, groupId, requestedJids, creationResult, options = {}) {
  const initialWaitMs = options.initialWaitMs ?? 1500;
  const retryWaitMs = options.retryWaitMs ?? 1500;
  const verificationAttempts = options.verificationAttempts ?? 3;

  await delay(initialWaitMs);
  let metadata = await fetchMetadata(sock, groupId, creationResult, 1, 0);
  let missing = await findMissingParticipants(metadata, requestedJids, keys);
  let addResults = [];

  if (missing.length > 0) {
    try {
      const response = await sock.groupParticipantsUpdate(groupId, missing, 'add');
      addResults = (response || []).map(item => ({
        jid: item?.jid || null,
        status: String(item?.status || 'unknown'),
      }));
    } catch (error) {
      addResults = missing.map(jid => ({ jid, status: 'error', error: error.message }));
    }

    metadata = await fetchMetadata(sock, groupId, metadata, verificationAttempts, retryWaitMs);
    missing = await findMissingParticipants(metadata, requestedJids, keys);
  }

  return {
    metadata,
    missing,
    addResults,
    participantCount: metadata?.participants?.length || 0,
  };
}

module.exports = {
  ensureParticipants,
  findMissingParticipants,
  jidUser,
  participantPhoneDigits,
};
