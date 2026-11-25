// Exécution du noyau (synchrone) sur Cloudflare (asynchrone).
// Chaque passe : lit les tables utiles dans D1, construit le contexte attendu par le noyau, exécute le travail.
// Si le noyau a eu besoin de l'extérieur (réponse HTTP, contenu d'un GPX dans KV), le besoin est noté au lieu d'attendre :
// on le satisfait puis on rejoue sur un état neuf (rien n'a été écrit). Sinon, les effets sont appliqués : fichiers KV,
// écritures D1 en un lot, puis mails confiés à la passerelle Apps Script.
import { assurerSchema, chargerTables, creerDepotEnregistreur, appliquerChangements, ONGLETS_REQUETE } from './depot-d1.js';
import { sha256Hex } from './crypto.js';
import { TRACES_DEMO } from '../backend/noyau/traces-demo.js';

export const MAX_PASSES = 4;
const ERREUR_TECHNIQUE = { ok: false, erreur: 'erreur_interne', message: 'Erreur technique, réessayez.' };

class BesoinExterieur extends Error {}

// Nom d'expéditeur des mails : le nom de l'association (paramètre nom_appli), comme sur Google.
function nomExpediteur(depot) {
  const ligne = depot.lire('Parametres').find((l) => l.cle === 'nom_appli');
  const nom = ligne ? String(ligne.valeur).trim() : '';
  return nom || 'Sorties VTT';
}

function ligneJournal(maintenant, type, detail) {
  return { horodatage: maintenant().toISOString(), type, detail: String(detail).slice(0, 2000) };
}

function creerContexte({ depot, adherents, maintenant, reponsesHttp, fichiersLus, besoins, effets }) {
  return {
    depot,
    adherents: { lire: () => adherents.map((a) => ({ ...a })) },
    services: {
      maintenant,
      uuid: () => crypto.randomUUID(),
      hacher: sha256Hex,
      mail: (destinataires, objet, texte, html) => {
        effets.mails.push({ to: destinataires, subject: objet, body: texte, html: html || '', name: nomExpediteur(depot) });
      },
      http: (url) => {
        if (!reponsesHttp.has(url)) {
          besoins.http.add(url);
          throw new BesoinExterieur(`réponse attendue : ${url}`);
        }
        const r = reponsesHttp.get(url);
        if (r.erreur) throw new Error(r.erreur);
        return r.donnees;
      },
      fichiers: {
        enregistrer: (nom, contenu) => {
          const id = `kv:${crypto.randomUUID()}`;
          effets.kvEcritures.push([id, contenu]);
          fichiersLus.set(id, contenu);
          return id;
        },
        lire: (id) => {
          if (String(id).startsWith('demo:')) return TRACES_DEMO[String(id).slice(5)];
          if (!fichiersLus.has(id)) {
            besoins.fichiers.add(id);
            throw new BesoinExterieur(`fichier attendu : ${id}`);
          }
          const contenu = fichiersLus.get(id);
          if (contenu === null) throw new Error('Fichier de trace introuvable.');
          return contenu;
        },
        supprimer: (id) => {
          if (!String(id).startsWith('demo:')) effets.kvSuppressions.push(id);
        },
      },
    },
    journal: (type, detail) => depot.ajouter('Journal', [ligneJournal(maintenant, type, detail)]),
  };
}

async function satisfaire(env, besoins, reponsesHttp, fichiersLus) {
  const fetchImpl = env.fetchImpl || ((...a) => fetch(...a));
  for (const url of besoins.http) {
    try {
      const rep = await fetchImpl(url);
      reponsesHttp.set(url, { donnees: await rep.json() });
    } catch (e) {
      reponsesHttp.set(url, { erreur: String(e && e.message ? e.message : e) });
    }
  }
  for (const id of besoins.fichiers) fichiersLus.set(id, await env.TRACES.get(id));
}

export async function executer(env, travail, { onglets = ONGLETS_REQUETE, adherents = [] } = {}) {
  const maintenant = env.maintenant || (() => new Date());
  await assurerSchema(env.DB);
  const reponsesHttp = new Map();
  const fichiersLus = new Map();
  for (let passe = 1; passe <= MAX_PASSES; passe++) {
    const depot = creerDepotEnregistreur(await chargerTables(env.DB, onglets));
    const besoins = { http: new Set(), fichiers: new Set() };
    const effets = { mails: [], kvEcritures: [], kvSuppressions: [] };
    const ctx = creerContexte({ depot, adherents, maintenant, reponsesHttp, fichiersLus, besoins, effets });
    const resultat = travail(ctx);
    if (besoins.http.size || besoins.fichiers.size) {
      if (passe === MAX_PASSES) break;
      await satisfaire(env, besoins, reponsesHttp, fichiersLus);
      continue;
    }
    // Les fichiers d'abord : une ligne Traces ne désigne jamais un fichier absent.
    for (const [id, contenu] of effets.kvEcritures) await env.TRACES.put(id, contenu);
    await appliquerChangements(env.DB, depot.changements());
    for (const id of effets.kvSuppressions) await env.TRACES.delete(id);
    const echecs = [];
    for (const m of effets.mails) {
      try {
        await env.passerelle.mail(m);
      } catch (e) {
        echecs.push(ligneJournal(maintenant, 'envoi', `Mail « ${m.subject} » à ${m.to} non envoyé : ${e && e.message ? e.message : e}`));
      }
    }
    if (echecs.length) await appliquerChangements(env.DB, { insertions: echecs.map((ligne) => ({ onglet: 'Journal', ligne })) });
    return resultat;
  }
  return { ...ERREUR_TECHNIQUE };
}
