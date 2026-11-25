import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerEnvFactice } from './aides/cloudflare-factice.js';
import worker from '../worker/index.js';
import { signer } from '../worker/crypto.js';
import { chargerTables } from '../worker/depot-d1.js';

const SECRET = 'secret-de-test';

// Environnement tel que Cloudflare le donne au Worker, avec la passerelle et l'horloge imitées.
async function envWorker() {
  const e = await creerEnvFactice();
  e.SECRET_PASSERELLE = SECRET;
  e.passerelle.adherents = async () => e.adherents;
  return e;
}

const post = (env, corps, chemin = '/') => worker.fetch(new Request(`https://essai.test${chemin}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: typeof corps === 'string' ? corps : JSON.stringify(corps) }), env);

async function tic(env, { secret = SECRET, decalage = 0, signature } = {}) {
  const c = JSON.stringify({ action: 'tic' });
  const h = env.maintenant().getTime() + decalage;
  const s = signature || await signer(secret, h, c);
  return post(env, { h, s, c }, '/tic');
}

test('GET / : « API Sorties VTT : OK » ; OPTIONS : 204 avec CORS', async () => {
  const env = await envWorker();
  const r = await worker.fetch(new Request('https://essai.test/'), env);
  assert.equal(await r.text(), 'API Sorties VTT : OK');
  const o = await worker.fetch(new Request('https://essai.test/', { method: 'OPTIONS' }), env);
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('Access-Control-Allow-Origin'), '*');
});

test('POST / : connexion puis calendrier (texte brut accepté), en-tête CORS, mesure sur demande', async () => {
  const env = await envWorker();
  const cx = await (await post(env, { action: 'connexion', telephone: '0600000002' })).json();
  assert.equal(cx.ok, true);
  const r = await post(env, { action: 'calendrier', jeton: cx.data.jeton, mesure: true });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  const cal = await r.json();
  assert.equal(cal.ok, true);
  assert.equal(cal.data.jours.length, 14);
  assert.equal(typeof cal.mesure.total_ms, 'number');
});

test('POST / : JSON invalide → requete_invalide ; passerelle en panne sans cache → service_indisponible', async () => {
  const env = await envWorker();
  assert.equal((await (await post(env, 'pas du json')).json()).erreur, 'requete_invalide');
  env.passerelle.adherents = async () => { throw new Error('injoignable'); };
  assert.equal((await (await post(env, { action: 'connexion', telephone: '0600000002' })).json()).erreur, 'service_indisponible');
});

test('statistiques : le Bilan est lu (absent des requêtes ordinaires)', async () => {
  const env = await envWorker();
  const jeton = (await (await post(env, { action: 'connexion', telephone: '0611111111' })).json()).data.jeton;
  const { sha256Hex } = await import('../worker/crypto.js');
  const { executer } = await import('../worker/contexte.js');
  await executer(env, (ctx) => ctx.depot.modifier('Jetons', (j) => j.jeton_hash === sha256Hex(jeton), { admin_verifie: true }));
  const s = await (await post(env, { action: 'admin_stats', jeton, annee: 2026 })).json();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.ok(s.data.sorties > 0, 'le bilan de démonstration est compté');
});

test('tic sans signature, signature fausse ou de plus de 5 min : 401, rien n\'est exécuté', async () => {
  const env = await envWorker();
  await (await import('../worker/contexte.js')).executer(env, (ctx) => ctx.depot.supprimer('Sorties', (s) => s.id === 'R:sm:2026-11-21:1'));
  const nonSigne = await post(env, { action: 'tic' }, '/tic');
  assert.equal(nonSigne.status, 401);
  assert.equal((await tic(env, { secret: 'autre' })).status, 401);
  assert.equal((await tic(env, { decalage: -6 * 60 * 1000 })).status, 401);
  assert.ok(!(await chargerTables(env.DB, ['Sorties'])).Sorties.some((s) => s.id === 'R:sm:2026-11-21:1'), 'rien régénéré');
});

test('tic signé : les sorties récurrentes manquantes de la quinzaine sont générées', async () => {
  const env = await envWorker();
  await (await import('../worker/contexte.js')).executer(env, (ctx) => ctx.depot.supprimer('Sorties', (s) => s.id === 'R:sm:2026-11-21:1'));
  const r = await tic(env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.ok((await chargerTables(env.DB, ['Sorties'])).Sorties.some((s) => s.id === 'R:sm:2026-11-21:1'));
});
