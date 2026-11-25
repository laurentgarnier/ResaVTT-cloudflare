import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerD1Factice } from './aides/d1-factice.js';
import { sqlDonnees } from '../outils/cf-donnees.js';
import { chargerTables, ONGLETS_TOUS, assurerSchema } from '../worker/depot-d1.js';
import { creerDonneesDemo, creerDonneesVierges } from '../backend/noyau/donnees-demo.js';

const PORTEUR = { nom: "L'Équipe « Porteur »", telephone: '+33611111111', email: 'porteur@example.org' };

async function verifierRelecture(donnees) {
  const db = creerD1Factice();
  await db.exec(sqlDonnees(donnees)); // base neuve : le SQL crée aussi les tables
  await assurerSchema(db);
  const relu = await chargerTables(db, ONGLETS_TOUS);
  for (const [onglet, lignes] of Object.entries(donnees.tables)) {
    assert.equal(relu[onglet].length, lignes.length, onglet);
    lignes.forEach((l, i) => {
      for (const [cle, v] of Object.entries(l)) if (v !== undefined) assert.deepEqual(relu[onglet][i][cle], v, `${onglet}[${i}].${cle}`);
    });
  }
  return db;
}

test('SQL du jeu de démonstration complet : relu à l\'identique (apostrophes, guillemets, multiligne compris)', async () => {
  const d = creerDonneesDemo('2026-11-12', PORTEUR);
  d.tables.Discussions.push({ id: 'x', sortie_id: 'libre-etangs', auteur_nom: "O'Neil", texte: "L'eau\n« ok »", horodatage: '2026-11-12T08:00:00Z', supprime: false, systeme: false });
  await verifierRelecture(d);
});

test('SQL des données vierges : relu à l\'identique ; rechargé par-dessus, remplace tout (pas de doublon)', async () => {
  const db = await verifierRelecture(creerDonneesVierges(PORTEUR));
  await db.exec(sqlDonnees(creerDonneesDemo('2026-11-12', PORTEUR)));
  await db.exec(sqlDonnees(creerDonneesVierges(PORTEUR)));
  const relu = await chargerTables(db, ONGLETS_TOUS);
  assert.equal(relu.Sorties.length, 0);
  assert.equal(relu.Regles.length, 0);
  assert.equal(relu.Parametres.length, creerDonneesVierges(PORTEUR).tables.Parametres.length);
});

test("la liste des adhérents n'est pas écrite dans D1 (elle vient de la passerelle)", () => {
  assert.doesNotMatch(sqlDonnees(creerDonneesDemo('2026-11-12', PORTEUR)), /Adherents|adherents/);
});

test('repartir : sorties, récurrences, rappels, inscriptions, traces et historique vidés ; paramètres, textes et comptes gardés', async () => {
  const { sqlRepartir, TABLES_GARDEES } = await import('../outils/cf-donnees.js');
  assert.deepEqual([...TABLES_GARDEES].sort(), ['Jetons', 'Modeles', 'Parametres', 'Personnes']);
  const d = creerDonneesDemo('2026-11-12', PORTEUR);
  d.tables.Parametres.find((p) => p.cle === 'nom_appli').valeur = 'Corbas VTT';
  d.tables.Modeles[0].valeur = 'Texte réglé par l\'admin';
  const db = await verifierRelecture(d);
  await db.exec(sqlRepartir());
  const relu = await chargerTables(db, ONGLETS_TOUS);
  for (const o of ONGLETS_TOUS) {
    if (TABLES_GARDEES.includes(o)) assert.equal(relu[o].length, d.tables[o].length, `${o} gardé`);
    else assert.equal(relu[o].length, 0, `${o} vidé`);
  }
  assert.equal(relu.Parametres.find((p) => p.cle === 'nom_appli').valeur, 'Corbas VTT');
  assert.equal(relu.Modeles[0].valeur, 'Texte réglé par l\'admin');
});
