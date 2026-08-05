'use strict';

const assert = require('node:assert/strict');
const { findMissingParticipants, jidUser } = require('./wa-group-participants');

async function run() {
  assert.equal(jidUser('6287781014545:12@s.whatsapp.net'), '6287781014545');

  const requested = ['6287781014545@s.whatsapp.net'];
  assert.deepEqual(await findMissingParticipants({
    participants: [{ id: '6287781014545@s.whatsapp.net' }],
  }, requested), []);

  assert.deepEqual(await findMissingParticipants({
    participants: [{ id: '172863927656526@lid', phoneNumber: '6287781014545@s.whatsapp.net' }],
  }, requested), []);

  const keys = {
    get: async (type, ids) => ({ [ids[0]]: '6287781014545' }),
  };
  assert.deepEqual(await findMissingParticipants({
    participants: [{ id: '172863927656526@lid' }],
  }, requested, keys), []);

  assert.deepEqual(await findMissingParticipants({
    participants: [{ id: '6285117728764@s.whatsapp.net' }],
  }, requested), requested);

  process.stdout.write('wa-group-participants tests passed\n');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
