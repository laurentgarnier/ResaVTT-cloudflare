// Dépôt D1 : même interface synchrone que le dépôt en mémoire (lire, ajouter, modifier, supprimer), pour que le noyau
// tourne sans changement. Les tables utiles sont lues d'un coup (un seul lot), le noyau travaille en mémoire, et ses
// écritures, enregistrées au passage, sont appliquées à D1 en un seul lot à la fin.
//
// Une table par onglet, colonnes = ONGLETS[onglet] en TEXT, plus _rid (clé SQLite). Chaque cellule contient la valeur
// encodée en JSON : booléens, nombres et textes reviennent à l'identique. Une colonne jamais remplie se lit '' (comme
// une cellule vide de Google Sheets). Les écritures visent les lignes par _rid : deux requêtes simultanées qui touchent
// des lignes différentes ne s'écrasent pas.
import { ONGLETS } from '../backend/noyau/schema.js';

export const ONGLETS_TOUS = Object.keys(ONGLETS);
// Journal et Bilan ne servent qu'à la purge et aux statistiques : pas lus par une requête ordinaire.
export const ONGLETS_REQUETE = ONGLETS_TOUS.filter((o) => o !== 'Journal' && o !== 'Bilan');

const nom = (identifiant) => `"${String(identifiant).replace(/"/g, '""')}"`;
const colonnes = (onglet) => ONGLETS[onglet] || [];

const schemasAssures = new WeakSet();

export async function assurerSchema(db) {
  if (schemasAssures.has(db)) return;
  await db.batch(ONGLETS_TOUS.map((o) => db.prepare(
    `CREATE TABLE IF NOT EXISTS ${nom(o)} (_rid INTEGER PRIMARY KEY, ${colonnes(o).map((c) => `${nom(c)} TEXT`).join(', ')})`,
  )));
  const infos = await db.batch(ONGLETS_TOUS.map((o) => db.prepare(`PRAGMA table_info(${nom(o)})`)));
  const ajouts = [];
  ONGLETS_TOUS.forEach((o, i) => {
    const existantes = new Set(infos[i].results.map((r) => r.name));
    for (const c of colonnes(o)) if (!existantes.has(c)) ajouts.push(db.prepare(`ALTER TABLE ${nom(o)} ADD COLUMN ${nom(c)} TEXT`));
  });
  if (ajouts.length) await db.batch(ajouts);
  schemasAssures.add(db);
}

function decoder(onglet, brute) {
  const ligne = { _rid: brute._rid };
  for (const c of colonnes(onglet)) {
    const v = brute[c];
    if (v === null || v === undefined) ligne[c] = '';
    else {
      try { ligne[c] = JSON.parse(v); } catch (e) { ligne[c] = v; } // valeur saisie à la main, hors JSON
    }
  }
  return ligne;
}

export async function chargerTables(db, onglets) {
  const res = await db.batch(onglets.map((o) => db.prepare(`SELECT * FROM ${nom(o)} ORDER BY _rid`)));
  const tables = {};
  onglets.forEach((o, i) => { tables[o] = res[i].results.map((r) => decoder(o, r)); });
  return tables;
}

export function creerDepotEnregistreur(tablesInitiales) {
  const t = {};
  for (const [o, lignes] of Object.entries(tablesInitiales)) t[o] = lignes.map((l) => ({ ...l }));
  const table = (o) => (t[o] ||= []);
  const nouvelles = new Set(); // lignes ajoutées pendant la requête (pas encore de _rid)
  const misesAJour = new Map(); // `${onglet}#${_rid}` → { onglet, _rid, champs }
  const suppressions = [];

  return {
    lire: (o) => table(o).map((l) => ({ ...l })),
    ajouter: (o, objets) => {
      for (const obj of objets) {
        const { _rid, ...ligne } = obj;
        table(o).push(ligne);
        nouvelles.add(ligne);
      }
    },
    modifier: (o, filtre, champs) => {
      let n = 0;
      for (const l of table(o)) {
        if (!filtre(l)) continue;
        Object.assign(l, champs);
        n++;
        if (nouvelles.has(l)) continue; // l'insertion portera les valeurs finales
        const cle = `${o}#${l._rid}`;
        const prec = misesAJour.get(cle);
        misesAJour.set(cle, { onglet: o, _rid: l._rid, champs: { ...(prec ? prec.champs : {}), ...champs } });
      }
      return n;
    },
    supprimer: (o, filtre) => {
      const gardees = [];
      let n = 0;
      for (const l of table(o)) {
        if (!filtre(l)) { gardees.push(l); continue; }
        n++;
        if (nouvelles.has(l)) { nouvelles.delete(l); continue; }
        misesAJour.delete(`${o}#${l._rid}`);
        suppressions.push({ onglet: o, _rid: l._rid });
      }
      t[o] = gardees;
      return n;
    },
    changements: () => ({
      insertions: Object.entries(t).flatMap(([o, lignes]) => lignes.filter((l) => nouvelles.has(l)).map((l) => ({ onglet: o, ligne: { ...l } }))),
      misesAJour: [...misesAJour.values()],
      suppressions: [...suppressions],
    }),
  };
}

const encoder = (v) => JSON.stringify(v);

export async function appliquerChangements(db, { insertions = [], misesAJour = [], suppressions = [] }) {
  const instructions = [];
  for (const { onglet, _rid, champs } of misesAJour) {
    const cols = colonnes(onglet).filter((c) => champs[c] !== undefined);
    if (!cols.length) continue;
    instructions.push(db.prepare(`UPDATE ${nom(onglet)} SET ${cols.map((c) => `${nom(c)} = ?`).join(', ')} WHERE _rid = ?`)
      .bind(...cols.map((c) => encoder(champs[c])), _rid));
  }
  for (const { onglet, _rid } of suppressions) instructions.push(db.prepare(`DELETE FROM ${nom(onglet)} WHERE _rid = ?`).bind(_rid));
  for (const { onglet, ligne } of insertions) {
    const cols = colonnes(onglet).filter((c) => ligne[c] !== undefined);
    instructions.push(cols.length
      ? db.prepare(`INSERT INTO ${nom(onglet)} (${cols.map(nom).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => encoder(ligne[c])))
      : db.prepare(`INSERT INTO ${nom(onglet)} DEFAULT VALUES`));
  }
  if (instructions.length) await db.batch(instructions);
}
