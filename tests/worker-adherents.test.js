import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerKvFactice } from './aides/cloudflare-factice.js';
import { adherentsPourRequete, DUREE_CACHE_ADHERENTS_MS } from '../worker/adherents.js';
import { creerPasserelle } from '../worker/passerelle-client.js';
import { verifier } from '../worker/crypto.js';

const BRUTS = [
  { nom: 'Ana', telephone: '06 00 00 00 01', email: '', actif: true, admin: false },
  { nom: ' Ben ', telephone: '+33 6 00 00 00 02', email: 'ben@example.org', actif: true, admin: true },
  { nom: '', telephone: '0600000009', email: '', actif: true, admin: false },
];

function env({ cache, panne = false, liste = BRUTS, maintenant = 10_000_000 } = {}) {
  const TRACES = creerKvFactice();
  if (cache) TRACES.m.set('adherents', JSON.stringify(cache));
  const passerelle = { appels: 0, adherents: async () => { passerelle.appels++; if (panne) throw new Error('injoignable'); return liste; } };
  return { TRACES, passerelle, maintenant: () => new Date(maintenant) };
}

test('liste fraîche en cache : aucun appel à la passerelle', async () => {
  const e = env({ cache: { lu_a: 10_000_000 - 1000, liste: [{ nom: 'Ana', telephone: '+33600000001' }] } });
  assert.deepEqual(await adherentsPourRequete(e, { action: 'calendrier' }), [{ nom: 'Ana', telephone: '+33600000001' }]);
  assert.equal(e.passerelle.appels, 0);
});

test("liste de plus d'une heure : relue à la passerelle, numéros normalisés, lignes sans nom ou sans numéro écartées, cache mis à jour", async () => {
  const e = env({ cache: { lu_a: 10_000_000 - DUREE_CACHE_ADHERENTS_MS - 1, liste: [] } });
  const liste = await adherentsPourRequete(e, { action: 'calendrier' });
  assert.equal(e.passerelle.appels, 1);
  assert.deepEqual(liste.map((a) => [a.nom, a.telephone]), [['Ana', '+33600000001'], ['Ben', '+33600000002']]);
  assert.equal(JSON.parse(e.TRACES.m.get('adherents')).lu_a, 10_000_000);
  const vide = env();
  assert.equal((await adherentsPourRequete(vide, { action: 'calendrier' })).length, 2, 'pas de cache : lecture');
});

test("connexion d'un numéro absent du cache : relecture aussitôt (une seule fois par minute)", async () => {
  const e = env({ cache: { lu_a: 10_000_000 - 120_000, liste: [] } });
  const liste = await adherentsPourRequete(e, { action: 'connexion', telephone: '06 00 00 00 02' });
  assert.equal(e.passerelle.appels, 1);
  assert.ok(liste.some((a) => a.telephone === '+33600000002'));
  const e2 = env({ cache: { lu_a: 10_000_000 - 10_000, liste: [] } });
  await adherentsPourRequete(e2, { action: 'connexion', telephone: '0699999999' });
  assert.equal(e2.passerelle.appels, 0, 'relue il y a 10 s : pas de nouvel appel');
});

test("passerelle en panne : la liste en cache sert ; connexion d'un numéro inconnu → service_indisponible", async () => {
  const cache = { lu_a: 10_000_000 - DUREE_CACHE_ADHERENTS_MS - 1, liste: [{ nom: 'Ana', telephone: '+33600000001' }] };
  assert.equal((await adherentsPourRequete(env({ cache, panne: true }), { action: 'calendrier' })).length, 1);
  await assert.rejects(adherentsPourRequete(env({ cache, panne: true }), { action: 'connexion', telephone: '0600000002' }), (e) => e.code === 'service_indisponible');
  await assert.rejects(adherentsPourRequete(env({ panne: true }), { action: 'calendrier' }), (e) => e.code === 'service_indisponible');
});

test('client de la passerelle : enveloppe { h, s, c } signée, vérifiable ; réponse non « ok » → erreur', async () => {
  const recus = [];
  const p = creerPasserelle({
    url: 'https://passerelle.test/exec',
    secret: 'chut',
    maintenant: () => new Date(1_700_000_000_000),
    fetchImpl: async (url, init) => { recus.push({ url, init }); return { json: async () => ({ ok: true, data: BRUTS }) }; },
  });
  assert.deepEqual(await p.adherents(), BRUTS);
  const env1 = JSON.parse(recus[0].init.body);
  assert.equal(recus[0].init.method, 'POST');
  assert.equal(await verifier('chut', env1.h, env1.c, env1.s, 1_700_000_000_000), true);
  assert.deepEqual(JSON.parse(env1.c), { action: 'adherents_lire' });
  const enEchec = creerPasserelle({ url: 'u', secret: 's', fetchImpl: async () => ({ json: async () => ({ ok: false, erreur: 'refuse', message: 'Refusé' }) }) });
  await assert.rejects(enEchec.mail({ to: 'a@b', subject: 'x', body: 'y' }), /Refusé/);
});

test("I4 : écriture KV impossible (quota) — la liste fraîche sert quand même, et la relecture reste limitée à une par minute", async () => {
  const e = env({ cache: { lu_a: 10_000_000 - DUREE_CACHE_ADHERENTS_MS - 1, liste: [] } });
  e.TRACES.put = async () => { throw new Error('KV : quota quotidien atteint'); };
  const memoire = {};
  const liste = await adherentsPourRequete(e, { action: 'calendrier' }, { memoire });
  assert.equal(liste.length, 2, 'liste fraîche, pas l\'ancienne');
  await adherentsPourRequete(e, { action: 'connexion', telephone: '0699999999' }, { memoire });
  await adherentsPourRequete(e, { action: 'calendrier' }, { memoire });
  assert.equal(e.passerelle.appels, 1, 'gardée en mémoire : pas de nouvel appel');
});

test("I4 : liste inchangée à la relecture — aucune écriture KV", async () => {
  const e = env({ cache: { lu_a: 10_000_000 - DUREE_CACHE_ADHERENTS_MS - 1, liste: [] } });
  const memoire = {};
  await adherentsPourRequete(e, { action: 'calendrier' }, { memoire });
  let ecritures = 0;
  const put = e.TRACES.put;
  e.TRACES.put = async (...a) => { ecritures++; return put(...a); };
  await adherentsPourRequete(e, { action: 'tic' }, { memoire, forcer: true });
  assert.equal(e.passerelle.appels, 2);
  assert.equal(ecritures, 0);
});
