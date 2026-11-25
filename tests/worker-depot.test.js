import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerD1Factice } from './aides/d1-factice.js';
import { assurerSchema, chargerTables, creerDepotEnregistreur, appliquerChangements, ONGLETS_REQUETE, ONGLETS_TOUS } from '../worker/depot-d1.js';
import { creerDonneesDemo } from '../backend/noyau/donnees-demo.js';

async function baseVide() {
  const db = creerD1Factice();
  await assurerSchema(db);
  return db;
}

// Écrit des lignes par le dépôt, applique, puis relit tout.
async function ecrire(db, onglet, lignes) {
  const depot = creerDepotEnregistreur(await chargerTables(db, [onglet]));
  depot.ajouter(onglet, lignes);
  await appliquerChangements(db, depot.changements());
  return (await chargerTables(db, [onglet]))[onglet];
}

const sansRid = ({ _rid, ...reste }) => reste;

test('onglets : Journal et Bilan ne sont pas lus par une requête ordinaire', () => {
  assert.ok(ONGLETS_TOUS.includes('Journal') && ONGLETS_TOUS.includes('Bilan'));
  assert.ok(!ONGLETS_REQUETE.includes('Journal') && !ONGLETS_REQUETE.includes('Bilan'));
  assert.ok(ONGLETS_REQUETE.includes('Sorties'));
});

test('aller-retour des valeurs : booléens, texte « TRUE », nombre, chaîne vide, multiligne et emoji', async () => {
  const db = await baseVide();
  const ligne = { cle: 'a', valeur: true };
  const lignes = await ecrire(db, 'Parametres', [ligne, { cle: 'b', valeur: 'TRUE' }, { cle: 'c', valeur: 42 }, { cle: 'd', valeur: '' }, { cle: 'e', valeur: 'L1\nL2 🚵 é' }]);
  assert.deepEqual(lignes.map(sansRid), [{ cle: 'a', valeur: true }, { cle: 'b', valeur: 'TRUE' }, { cle: 'c', valeur: 42 }, { cle: 'd', valeur: '' }, { cle: 'e', valeur: 'L1\nL2 🚵 é' }]);
  assert.ok(lignes.every((l) => Number.isInteger(l._rid)));
});

test('modifier : seules les lignes visées et les champs donnés changent ; supprimer : seules les lignes filtrées partent', async () => {
  const db = await baseVide();
  await ecrire(db, 'Personnes', [
    { id: 'p1', telephone: '+331', nom_affiche: 'Ana', actif: true },
    { id: 'p2', telephone: '+332', nom_affiche: 'Ben', actif: true },
    { id: 'p3', telephone: '+333', nom_affiche: 'Cid', actif: true },
  ]);
  const depot = creerDepotEnregistreur(await chargerTables(db, ['Personnes']));
  assert.equal(depot.modifier('Personnes', (p) => p.id === 'p2', { nom_affiche: 'Benoît' }), 1);
  assert.equal(depot.supprimer('Personnes', (p) => p.id === 'p3'), 1);
  await appliquerChangements(db, depot.changements());
  assert.deepEqual((await chargerTables(db, ['Personnes'])).Personnes.map(sansRid), [
    { id: 'p1', telephone: '+331', nom_affiche: 'Ana', actif: true },
    { id: 'p2', telephone: '+332', nom_affiche: 'Benoît', actif: true },
  ]);
});

test('ligne ajoutée puis modifiée ou supprimée dans la même requête : une seule écriture, la bonne', async () => {
  const db = await baseVide();
  const depot = creerDepotEnregistreur(await chargerTables(db, ['Personnes']));
  depot.ajouter('Personnes', [{ id: 'n1', nom_affiche: 'Nouveau' }, { id: 'n2', nom_affiche: 'Éphémère' }]);
  depot.modifier('Personnes', (p) => p.id === 'n1', { nom_affiche: 'Renommé' });
  depot.supprimer('Personnes', (p) => p.id === 'n2');
  await appliquerChangements(db, depot.changements());
  assert.deepEqual((await chargerTables(db, ['Personnes'])).Personnes.map((l) => [l.id, l.nom_affiche]), [['n1', 'Renommé']]);
});

test('champs inconnus ou _rid dans une ligne ajoutée : ignorés, pas d\'erreur SQL', async () => {
  const db = await baseVide();
  const lignes = await ecrire(db, 'Personnes', [{ _rid: 999, id: 'p1', nom_affiche: 'Ana', inconnu: 'x', 'col"onne': 'y' }]);
  assert.deepEqual(lignes.map((l) => [l.id, l.nom_affiche, l.inconnu]), [['p1', 'Ana', undefined]]);
  assert.notEqual(lignes[0]._rid, 999);
  const depot = creerDepotEnregistreur(await chargerTables(db, ['Personnes']));
  depot.modifier('Personnes', () => true, { inconnu: 'z', nom_affiche: 'Anne' });
  await appliquerChangements(db, depot.changements());
  assert.equal((await chargerTables(db, ['Personnes'])).Personnes[0].nom_affiche, 'Anne');
});

test('deux requêtes simultanées (lues avant d\'écrire) : aucune inscription ni modification perdue', async () => {
  const db = await baseVide();
  await ecrire(db, 'Sorties', [{ id: 's1', titre: 'A' }, { id: 's2', titre: 'B' }]);
  const a = creerDepotEnregistreur(await chargerTables(db, ONGLETS_REQUETE));
  const b = creerDepotEnregistreur(await chargerTables(db, ONGLETS_REQUETE));
  a.ajouter('Inscriptions', [{ sortie_id: 's1', personne_id: 'pa' }]);
  a.modifier('Sorties', (s) => s.id === 's1', { titre: 'A modifiée' });
  b.ajouter('Inscriptions', [{ sortie_id: 's1', personne_id: 'pb' }]);
  b.modifier('Sorties', (s) => s.id === 's2', { titre: 'B modifiée' });
  await appliquerChangements(db, a.changements());
  await appliquerChangements(db, b.changements());
  const t = await chargerTables(db, ['Sorties', 'Inscriptions']);
  assert.deepEqual(t.Inscriptions.map((i) => i.personne_id).sort(), ['pa', 'pb']);
  assert.deepEqual(t.Sorties.map((s) => s.titre), ['A modifiée', 'B modifiée']);
});

test('schéma : une colonne ajoutée au noyau est créée dans une table existante, ses lignes gardées ; une lecture groupée = un seul lot', async () => {
  const db = creerD1Factice();
  await db.exec('CREATE TABLE "Regles" (_rid INTEGER PRIMARY KEY, "id" TEXT, "nom" TEXT)');
  await db.exec('INSERT INTO "Regles" ("id", "nom") VALUES (\'"sm"\', \'"Samedi"\')');
  await assurerSchema(db);
  const cols = db.base.prepare('PRAGMA table_info("Regles")').all().map((c) => c.name);
  assert.ok(cols.includes('autres_departs'));
  const avant = db.stats.batch;
  const t = await chargerTables(db, ONGLETS_REQUETE);
  assert.equal(db.stats.batch - avant, 1);
  assert.equal(t.Regles.length, 1);
  // Comme une cellule vide de Google Sheets : une colonne jamais remplie se lit ''.
  assert.equal(t.Regles[0].id, 'sm');
  assert.equal(t.Regles[0].nom, 'Samedi');
  assert.equal(t.Regles[0].autres_departs, '');
});

test('jeu de démonstration écrit puis relu : mêmes lignes', async () => {
  const db = await baseVide();
  const { tables } = creerDonneesDemo('2026-11-12', { nom: 'Porteur', telephone: '+33611111111', email: 'porteur@example.org' });
  const depot = creerDepotEnregistreur(await chargerTables(db, ONGLETS_TOUS));
  for (const [onglet, lignes] of Object.entries(tables)) depot.ajouter(onglet, lignes);
  await appliquerChangements(db, depot.changements());
  const relu = await chargerTables(db, ONGLETS_TOUS);
  for (const [onglet, lignes] of Object.entries(tables)) {
    assert.equal(relu[onglet].length, lignes.length, onglet);
    lignes.forEach((l, i) => {
      for (const [cle, v] of Object.entries(l)) if (v !== undefined) assert.deepEqual(relu[onglet][i][cle], v, `${onglet}[${i}].${cle}`);
    });
  }
});
