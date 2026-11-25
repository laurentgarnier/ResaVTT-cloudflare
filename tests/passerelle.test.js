import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { signer } from '../worker/crypto.js';

const SECRET = 'secret-passerelle';
const MAINTENANT = 1_700_000_000_000;

// Google imité, juste ce qu'utilise la passerelle.
function google({ proprietes = {} } = {}) {
  const props = { SECRET_PASSERELLE: SECRET, ADHERENTS_ID: 'fichier-adh', URL_WORKER: 'https://worker.test/', PORTEUR_EMAIL: 'porteur@example.org', ...proprietes };
  const mails = [];
  const requetes = [];
  const declencheurs = [];
  const lectures = { n: 0 };
  const lignes = [
    ['nom', 'telephone', 'email', 'actif', 'admin'],
    ['Ana', '06 00 00 00 01', '', true, false],
    ['Ben', '0600000002', 'ben@example.org', true, true],
    ['', '', '', '', ''],
  ];
  const globaux = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: { openById: (id) => { lectures.n++; assert.equal(id, 'fichier-adh'); return { getSheets: () => [{ getDataRange: () => ({ getValues: () => lignes.map((l) => [...l]) }) }] }; } },
    MailApp: { sendEmail: (o) => mails.push(o) },
    UrlFetchApp: { fetch: (url, o) => { requetes.push({ url, o }); return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' }; } },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      computeHmacSha256Signature: (valeur, cle) => [...createHmac('sha256', cle).update(valeur, 'utf8').digest()].map((o) => (o > 127 ? o - 256 : o)),
    },
    ScriptApp: {
      getProjectTriggers: () => declencheurs.map((d) => ({ getHandlerFunction: () => d.fonction, d })),
      deleteTrigger: (t) => declencheurs.splice(declencheurs.indexOf(t.d), 1),
      newTrigger: (fonction) => ({ timeBased: () => ({ everyHours: (n) => ({ create: () => declencheurs.push({ fonction, n }) }) }) }),
    },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (t) => ({ setMimeType: () => ({ getContent: () => t }), getContent: () => t }) },
    Logger: { log: () => {} },
    Date: class extends Date { static now() { return MAINTENANT; } },
  };
  const contexte = vm.createContext({ ...globaux, JSON, Math, String, Number, Array, Object });
  vm.runInContext(readFileSync('passerelle/Passerelle.js', 'utf8'), contexte);
  const poster = async (charge, { secret = SECRET, h = MAINTENANT } = {}) => {
    const c = JSON.stringify(charge);
    const s = await signer(secret, h, c);
    return JSON.parse(contexte.doPost({ postData: { contents: JSON.stringify({ h, s, c }) } }).getContent());
  };
  return { contexte, mails, requetes, declencheurs, lectures, poster };
}

test('signature de la passerelle = celle du Worker (HMAC-SHA256 hexadécimal de « h.c »)', async () => {
  const g = google();
  assert.equal(g.contexte.signature(SECRET, MAINTENANT, '{"a":"é🚵"}'), await signer(SECRET, MAINTENANT, '{"a":"é🚵"}'));
});

test('requête non signée, mal signée ou de plus de 5 min : refusée, le fichier des adhérents n\'est pas ouvert', async () => {
  const g = google();
  assert.equal(JSON.parse(g.contexte.doPost({ postData: { contents: '{"action":"adherents_lire"}' } }).getContent()).erreur, 'refuse');
  assert.equal((await g.poster({ action: 'adherents_lire' }, { secret: 'autre' })).erreur, 'refuse');
  assert.equal((await g.poster({ action: 'adherents_lire' }, { h: MAINTENANT - 301_000 })).erreur, 'refuse');
  assert.equal(g.lectures.n, 0);
});

test('adherents_lire : les lignes du fichier (première feuille), sans les lignes vides', async () => {
  const g = google();
  const r = await g.poster({ action: 'adherents_lire' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [
    { nom: 'Ana', telephone: '06 00 00 00 01', email: '', actif: true, admin: false },
    { nom: 'Ben', telephone: '0600000002', email: 'ben@example.org', actif: true, admin: true },
  ]);
});

test("mail_envoyer en mode essai : seulement au porteur, objet préfixé « [Essai] », nom d'expéditeur et HTML gardés", async () => {
  const g = google();
  const r = await g.poster({ action: 'mail_envoyer', to: 'liste@club.example', subject: 'Rappel', body: 'texte', html: '<p>x</p>', name: 'Corbas VTT' });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(g.mails)), [{ to: 'porteur@example.org', subject: '[Essai] Rappel', body: 'texte', htmlBody: '<p>x</p>', name: 'Corbas VTT' }]);
});

test("mail_envoyer hors essai (MODE_ESSAI = non) : aux destinataires demandés ; action inconnue refusée", async () => {
  const g = google({ proprietes: { MODE_ESSAI: 'non' } });
  await g.poster({ action: 'mail_envoyer', to: 'liste@club.example', subject: 'Rappel', body: 'texte' });
  assert.deepEqual(JSON.parse(JSON.stringify(g.mails)), [{ to: 'liste@club.example', subject: 'Rappel', body: 'texte', name: 'Sorties VTT' }]);
  assert.equal((await g.poster({ action: 'supprimer_tout' })).erreur, 'action_inconnue');
});

test('ticHoraire : POST signé vers /tic du Worker ; installer deux fois → un seul déclencheur horaire', async () => {
  const g = google();
  g.contexte.ticHoraire();
  assert.equal(g.requetes.length, 1);
  assert.equal(g.requetes[0].url, 'https://worker.test/tic');
  const env = JSON.parse(g.requetes[0].o.payload);
  assert.equal(env.s, await signer(SECRET, env.h, env.c));
  assert.deepEqual(JSON.parse(env.c), { action: 'tic' });
  g.contexte.installer();
  g.contexte.installer();
  assert.deepEqual(g.declencheurs, [{ fonction: 'ticHoraire', n: 1 }]);
});
