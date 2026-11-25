// Données de l'essai Cloudflare dans D1. La liste des adhérents n'est jamais écrite : elle vient de la passerelle.
//   PORTEUR_NOM=… PORTEUR_TEL=… PORTEUR_EMAIL=… node outils/cf-donnees.js demo|vierge [--sans-envoi]
//     demo : jeu de démonstration complet ; vierge : comme une nouvelle installation. Remplacent tout.
//   node outils/cf-donnees.js repartir      (npm run cf:repartir)
//     repart sans sortie ni récurrence, en gardant Paramètres, textes des messages et comptes (voir sqlRepartir) ;
//     demande de taper « oui », puis supprime aussi les fichiers GPX de KV.
// Écrit .wrangler/donnees.sql puis l'exécute sur la base D1 distante (wrangler d1 execute --remote).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ONGLETS_TOUS, instructionsCreation, nom, colonnes } from '../worker/depot-d1.js';
import { creerDonneesDemo, creerDonneesVierges } from '../backend/noyau/donnees-demo.js';
import { aujourdhuiLocal } from '../site/sorties/js/logique/dates.js';
import { normaliserTelephone } from '../site/sorties/js/logique/telephone.js';

const litteral = (valeur) => `'${JSON.stringify(valeur).replace(/'/g, "''")}'`;

export function sqlDonnees(donnees) {
  const lignes = [...instructionsCreation()];
  for (const o of ONGLETS_TOUS) lignes.push(`DELETE FROM ${nom(o)}`);
  for (const [o, objets] of Object.entries(donnees.tables)) {
    for (const objet of objets) {
      const cols = colonnes(o).filter((c) => objet[c] !== undefined);
      lignes.push(cols.length
        ? `INSERT INTO ${nom(o)} (${cols.map(nom).join(', ')}) VALUES (${cols.map((c) => litteral(objet[c])).join(', ')})`
        : `INSERT INTO ${nom(o)} DEFAULT VALUES`);
    }
  }
  return `${lignes.join(';\n')};\n`;
}

// Repartir sans sortie paramétrée : on garde le réglage de l'association (Parametres), les textes des messages
// (Modeles) et les comptes (Jetons : personne n'est déconnecté ; Personnes : les personnes de chaque compte).
// Tout le reste est vidé : sorties, inscriptions, discussions, traces, récurrences et leurs créneaux, fermetures,
// rappels groupés (ils ne viseraient plus aucune récurrence), envois, journal, bilan des statistiques.
export const TABLES_GARDEES = ['Parametres', 'Modeles', 'Jetons', 'Personnes'];

export function sqlRepartir() {
  const lignes = [...instructionsCreation(), ...ONGLETS_TOUS.filter((o) => !TABLES_GARDEES.includes(o)).map((o) => `DELETE FROM ${nom(o)}`)];
  return `${lignes.join(';\n')};\n`;
}

const wrangler = (args, options = {}) => spawnSync('npx', ['--yes', 'wrangler@4', ...args], { shell: true, encoding: 'utf8', ...options });

async function repartir() {
  const question = createInterface({ input: process.stdin, output: process.stdout });
  const reponse = await question.question(
    'Supprimer définitivement sorties, inscriptions, discussions, traces, récurrences, fermetures, rappels groupés,\n'
    + "envois, journal et statistiques de l'essai Cloudflare (Paramètres, textes et comptes gardés) ? Tapez « oui » : ");
  question.close();
  if (reponse.trim().toLowerCase() !== 'oui') { console.log("Abandon : rien n'a été modifié."); return; }
  mkdirSync('.wrangler', { recursive: true });
  writeFileSync('.wrangler/donnees.sql', sqlRepartir());
  const d1 = wrangler(['d1', 'execute', 'resavtt-essai', '--remote', '--file', '.wrangler/donnees.sql', '-c', 'worker/wrangler.toml'], { stdio: 'inherit' });
  if (d1.status !== 0) process.exit(d1.status || 1);
  // Fichiers GPX (clés « kv:… ») ; la copie de la liste des adhérents (clé « adherents ») reste.
  const idKv = /\[\[kv_namespaces\]\][^[]*?id\s*=\s*"([^"]+)"/.exec(readFileSync('worker/wrangler.toml', 'utf8'))[1];
  const liste = wrangler(['kv', 'key', 'list', '--namespace-id', idKv, '--prefix', 'kv:', '--remote']);
  const cles = JSON.parse(liste.stdout.slice(liste.stdout.indexOf('['))).map((k) => k.name);
  if (cles.length) {
    writeFileSync('.wrangler/traces-a-supprimer.json', JSON.stringify(cles));
    const kv = wrangler(['kv', 'bulk', 'delete', '.wrangler/traces-a-supprimer.json', '--namespace-id', idKv, '--remote', '--force'], { stdio: 'inherit' });
    if (kv.status !== 0) process.exit(kv.status || 1);
  }
  console.log(`Terminé : données vidées, ${cles.length} fichier(s) GPX supprimé(s). Paramètres, textes et comptes gardés.`);
}

async function principal(argv) {
  const mode = argv[2];
  if (mode === 'repartir') return repartir();
  if (!['demo', 'vierge'].includes(mode)) throw new Error('Usage : node outils/cf-donnees.js demo|vierge|repartir [--sans-envoi]');
  const porteur = { nom: process.env.PORTEUR_NOM, telephone: normaliserTelephone(process.env.PORTEUR_TEL || ''), email: process.env.PORTEUR_EMAIL };
  if (!porteur.nom || !porteur.telephone || !String(porteur.email).includes('@')) {
    throw new Error('Renseignez PORTEUR_NOM, PORTEUR_TEL et PORTEUR_EMAIL (le porteur doit aussi figurer dans le fichier des adhérents lu par la passerelle).');
  }
  const donnees = mode === 'demo' ? creerDonneesDemo(aujourdhuiLocal(new Date()), porteur) : creerDonneesVierges(porteur);
  mkdirSync('.wrangler', { recursive: true });
  writeFileSync('.wrangler/donnees.sql', sqlDonnees(donnees));
  console.log(`.wrangler/donnees.sql écrit (${mode}).`);
  if (argv.includes('--sans-envoi')) return;
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'resavtt-essai', '--remote', '--file', '.wrangler/donnees.sql', '-c', 'worker/wrangler.toml'], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status || 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal(process.argv).catch((e) => { console.error(e.message); process.exit(1); });
}
