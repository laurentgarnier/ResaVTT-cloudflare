import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { sha256Hex, signer, verifier } from '../worker/crypto.js';

const reference = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

test('sha256Hex : identique au SHA-256 de Node (vide, ascii, accents et emoji, 1 Mo)', () => {
  for (const t of ['', 'abc', 'é🚵', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'é'.repeat(1024 * 1024 / 2)]) {
    assert.equal(sha256Hex(t), reference(t), `longueur ${t.length}`);
  }
});

test('signer : HMAC-SHA256 hexadécimal de « horodatage.corps », identique à Node', async () => {
  const corps = JSON.stringify({ action: 'adherents_lire', é: '🚵' });
  const attendu = createHmac('sha256', 'secret-123').update(`1700000000000.${corps}`, 'utf8').digest('hex');
  assert.equal(await signer('secret-123', 1700000000000, corps), attendu);
});

test('verifier : bonne signature acceptée ; signature modifiée, autre secret ou écart de plus de 5 min refusés', async () => {
  const t = 1700000000000;
  const sig = await signer('s', t, 'corps');
  assert.equal(await verifier('s', t, 'corps', sig, t + 1000), true);
  assert.equal(await verifier('s', t, 'corps', sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')), t), false);
  assert.equal(await verifier('autre', t, 'corps', sig, t), false);
  assert.equal(await verifier('s', t, 'corps', sig, t + 301000), false);
  assert.equal(await verifier('s', t, 'corps', sig, t - 301000), false);
  assert.equal(await verifier('s', t, 'autre corps', sig, t), false);
  assert.equal(await verifier('s', t, 'corps', undefined, t), false);
});
