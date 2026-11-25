import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerEnvFactice } from './aides/cloudflare-factice.js';
import { contexteTest } from './aides/contexte-test.js';
import { executer, MAX_PASSES } from '../worker/contexte.js';
import { chargerTables } from '../worker/depot-d1.js';
import { sha256Hex } from '../worker/crypto.js';
import { traiter } from '../backend/noyau/actions.js';

const GPX = '<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="48.4" lon="2.7"></trkpt></trkseg></trk></gpx>';

const appel = (env, requete) => executer(env, (ctx) => traiter(requete, ctx), { adherents: env.adherents });

async function connecter(env, tel) {
  const r = await appel(env, { action: 'connexion', telephone: tel });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data.jeton;
}

test("parité : le calendrier calculé sur D1 est celui du dépôt en mémoire", async () => {
  const env = await creerEnvFactice();
  const jeton = await connecter(env, '0600000002');
  const surD1 = (await appel(env, { action: 'calendrier', jeton })).data;
  const t = contexteTest();
  const enMemoire = t.appel('calendrier', { jeton: t.connecter('0600000002') }).data;
  assert.deepEqual(surD1, enMemoire);
});

test('une inscription est enregistrée dans D1 et relue par la requête suivante', async () => {
  const env = await creerEnvFactice();
  const jeton = await connecter(env, '0600000002');
  const cal = (await appel(env, { action: 'calendrier', jeton })).data;
  const p = cal.personnes[0].id;
  assert.equal((await appel(env, { action: 'inscription', jeton, sortie_id: 'R:sm:2026-11-21:1', personne_ids: [p], inscrit: true })).ok, true);
  const s = (await appel(env, { action: 'calendrier', jeton })).data.jours.flatMap((j) => j.sorties).find((x) => x.id === 'R:sm:2026-11-21:1');
  assert.ok(s.inscrits.some((i) => i.personne_id === p));
});

test('trace : le GPX va dans KV ; relu à l\'identique (la requête est rejouée une fois pour le lire)', async () => {
  const env = await creerEnvFactice();
  const jeton = await connecter(env, '0600000003'); // Ludo, créateur de la sortie libre
  const r = await appel(env, { action: 'trace_ajouter', jeton, sortie_id: 'libre-etangs', nom_fichier: 'b.gpx', contenu: GPX, km: '1', dplus: '0' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ligne = (await chargerTables(env.DB, ['Traces'])).Traces.find((x) => x.id === r.data.id);
  assert.match(ligne.drive_id, /^kv:/);
  assert.equal(env.TRACES.m.get(ligne.drive_id), GPX);
  let passes = 0;
  const lu = await executer(env, (ctx) => { passes++; return traiter({ action: 'trace_lire', jeton, trace_id: r.data.id }, ctx); }, { adherents: env.adherents });
  assert.deepEqual(lu.data, { nom_fichier: 'b.gpx', contenu: GPX });
  assert.equal(passes, 2);
  const demo = await appel(env, { action: 'trace_lire', jeton, trace_id: 't-boucle-foret' });
  assert.match(demo.data.contenu, /^<\?xml/);
});

async function adminVerifie(env) {
  const jeton = await connecter(env, '0611111111');
  await executer(env, (ctx) => ctx.depot.modifier('Jetons', (j) => j.jeton_hash === sha256Hex(jeton), { admin_verifie: true }), { adherents: env.adherents });
  return jeton;
}

test('rappel envoyé : la météo est cherchée une fois, puis les mails partent par la passerelle', async () => {
  const env = await creerEnvFactice();
  const jeton = await adminVerifie(env);
  const r = await appel(env, { action: 'rappel_envoyer_maintenant', jeton, type: 'G', id: 'g-weekend' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(env.appels.filter((u) => u.includes('api.open-meteo.com')).length, 1);
  assert.equal(env.passerelle.mails.length, 2);
  assert.equal(env.passerelle.mails[0].to, 'porteur@example.org');
  assert.ok(env.passerelle.mails[0].name, "nom d'expéditeur");
});

test("passerelle en panne à l'envoi d'un mail : la requête répond, une ligne Journal « envoi » le signale", async () => {
  const env = await creerEnvFactice();
  const jeton = await adminVerifie(env);
  env.passerelle.enPanne = true;
  const r = await appel(env, { action: 'rappel_envoyer_maintenant', jeton, type: 'G', id: 'g-weekend' });
  assert.equal(r.ok, true);
  const journal = (await chargerTables(env.DB, ['Journal'])).Journal;
  assert.ok(journal.some((l) => l.type === 'envoi' && /passerelle injoignable/.test(l.detail)), JSON.stringify(journal));
});

test('trop de passes : erreur technique, rien n\'est écrit', async () => {
  const env = await creerEnvFactice();
  let n = 0;
  const r = await executer(env, (ctx) => {
    ctx.depot.ajouter('Personnes', [{ id: `x${n}` }]);
    n++;
    try { ctx.services.http(`https://exemple.test/${n}`); } catch (e) { /* besoin noté */ }
    return 'jamais';
  }, { adherents: env.adherents });
  assert.equal(r.erreur, 'erreur_interne');
  assert.equal(n, MAX_PASSES);
  assert.ok(!(await chargerTables(env.DB, ['Personnes'])).Personnes.some((p) => String(p.id).startsWith('x')));
});
