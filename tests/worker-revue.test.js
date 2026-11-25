// Corrections de la revue finale : requêtes sérialisées (C1), mails comme besoin extérieur (I1),
// tables chargées à la demande (I3). Les cas de la liste des adhérents (I4) sont dans worker-adherents.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerEnvFactice } from './aides/cloudflare-factice.js';
import worker, { VerrouSorties } from '../worker/index.js';
import { executer } from '../worker/contexte.js';
import { chargerTables } from '../worker/depot-d1.js';
import { sha256Hex } from '../worker/crypto.js';
import { traiter } from '../backend/noyau/actions.js';

// Environnement du Worker avec un Durable Object imité : une seule instance, comme idFromName('principal').
async function envWorker() {
  const e = await creerEnvFactice();
  e.SECRET_PASSERELLE = 'secret';
  e.passerelle.adherents = async () => e.adherents;
  let instance = null;
  e.VERROU = { idFromName: () => 'principal', get: () => ({ fetch: (req) => (instance ||= new VerrouSorties({}, e)).fetch(req) }) };
  return e;
}

const poster = async (env, corps) => (await worker.fetch(new Request('https://essai.test/', { method: 'POST', body: JSON.stringify(corps) }), env)).json();

test('C1 : dix codes administrateur faux envoyés en même temps — la limite de 5 essais tient', async () => {
  const env = await envWorker();
  const jeton = (await poster(env, { action: 'connexion', telephone: '0611111111' })).data.jeton;
  assert.equal((await poster(env, { action: 'admin_code_demander', jeton })).ok, true);
  const vrai = env.passerelle.mails.at(-1).body.match(/\d{6}/)[0];
  const faux = vrai === '000000' ? '111111' : '000000';
  const reponses = await Promise.all(Array.from({ length: 10 }, () => poster(env, { action: 'admin_code_verifier', jeton, code: faux })));
  const codes = reponses.map((r) => r.erreur);
  assert.equal(codes.filter((c) => c === 'code_faux').length, 4, codes.join(','));
  assert.equal(codes.filter((c) => c === 'trop_essais').length, 6, codes.join(','));
});

test('C1 : deux calendriers chargés en même temps ne génèrent pas deux fois la même sortie récurrente', async () => {
  const env = await envWorker();
  await executer(env, (ctx) => ctx.depot.supprimer('Sorties', (s) => s.id === 'R:sm:2026-11-21:1'));
  const jeton = (await poster(env, { action: 'connexion', telephone: '0600000002' })).data.jeton;
  await Promise.all([poster(env, { action: 'calendrier', jeton }), poster(env, { action: 'calendrier', jeton })]);
  const n = (await chargerTables(env.DB, ['Sorties'])).Sorties.filter((s) => s.id === 'R:sm:2026-11-21:1').length;
  assert.equal(n, 1);
});

async function adminVerifie(env) {
  const appel = (r) => executer(env, (ctx) => traiter(r, ctx), { adherents: env.adherents });
  const jeton = (await appel({ action: 'connexion', telephone: '0611111111' })).data.jeton;
  await executer(env, (ctx) => ctx.depot.modifier('Jetons', (j) => j.jeton_hash === sha256Hex(jeton), { admin_verifie: true }));
  return { jeton, appel };
}

test("I1 : passerelle en panne — l'envoi du rappel reste à refaire (pas noté « ok »), comme sur Google", async () => {
  const env = await creerEnvFactice();
  const { jeton, appel } = await adminVerifie(env);
  env.passerelle.enPanne = true;
  await appel({ action: 'rappel_envoyer_maintenant', jeton, type: 'G', id: 'g-weekend' });
  const envoi = (await chargerTables(env.DB, ['Envois'])).Envois.find((e) => e.cle.startsWith('rappel-manuel:G:g-weekend'));
  assert.ok(envoi, 'envoi noté');
  assert.notEqual(envoi.etape_mail, 'ok');
  assert.notEqual(envoi.etape_whatsapp, 'ok');
  assert.equal(envoi.tentatives, '2', 'deux étapes en échec (mail et WhatsApp), comme sur Google');
  assert.match(envoi.derniere_erreur, /passerelle injoignable/);
});

test("I1 : demande de code administrateur, passerelle en panne → erreur (pas « envoyé ») ; passerelle en service → le code reçu est le bon", async () => {
  const env = await creerEnvFactice();
  const appel = (r) => executer(env, (ctx) => traiter(r, ctx), { adherents: env.adherents });
  const jeton = (await appel({ action: 'connexion', telephone: '0611111111' })).data.jeton;
  env.passerelle.enPanne = true;
  assert.equal((await appel({ action: 'admin_code_demander', jeton })).ok, false);
  env.passerelle.enPanne = false;
  assert.equal((await appel({ action: 'admin_code_demander', jeton })).ok, true);
  assert.equal(env.passerelle.mails.length, 1, 'un seul mail, même si la requête est rejouée');
  const code = env.passerelle.mails[0].body.match(/\d{6}/)[0];
  assert.equal((await appel({ action: 'admin_code_verifier', jeton, code })).ok, true);
});

test('I3 : relecture de la discussion — seules les tables utiles sont lues, même résultat', async () => {
  const env = await envWorker();
  const jeton = (await poster(env, { action: 'connexion', telephone: '0600000002' })).data.jeton;
  env.DB.stats.tablesLues = [];
  const r = await poster(env, { action: 'discussion_lire', jeton, sortie_id: 'R:sm:2026-11-14:1', avec_inscrits: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.messages.length, 3);
  assert.deepEqual([...new Set(env.DB.stats.tablesLues)].sort(), ['Discussions', 'Inscriptions', 'Jetons']);
});

test("I3 : une table manquante au départ est chargée à la demande (résultat identique au chargement complet)", async () => {
  const env = await creerEnvFactice();
  const appel = (r, opts) => executer(env, (ctx) => traiter(r, ctx), { adherents: env.adherents, ...opts });
  const jeton = (await appel({ action: 'connexion', telephone: '0600000002' })).data.jeton;
  const complet = await appel({ action: 'calendrier', jeton });
  const aLaDemande = await appel({ action: 'calendrier', jeton }, { onglets: ['Jetons'] });
  assert.deepEqual(aLaDemande, complet);
});
