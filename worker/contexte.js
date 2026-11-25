// Exécution du noyau (synchrone) sur Cloudflare (asynchrone).
// Chaque passe construit, à partir des tables déjà lues, le contexte attendu par le noyau et exécute le travail.
// Quand le noyau a besoin de l'extérieur, le besoin est noté au lieu d'attendre ; on le satisfait, puis on rejoue sur un
// état neuf (rien n'a été écrit). Besoins possibles :
//   - une table pas encore chargée (chargement à la demande : chaque action ne lit que ce qu'elle utilise) ;
//   - une réponse HTTP (météo, géocodage) ou le contenu d'un GPX dans KV ;
//   - l'envoi d'un mail : envoyé par la passerelle, puis la passe suivante sait s'il est parti. Un échec lève donc une
//     erreur dans le noyau, qui le note et le retentera, comme avec MailApp sur Google.
// Les passes sont identiques entre elles : même heure et mêmes identifiants (uuid) d'une passe à l'autre, pour qu'un
// mail envoyé (un code d'accès, par exemple) corresponde à ce qui est finalement enregistré.
// Dernière passe sans besoin : fichiers KV écrits, écritures D1 en un lot, fichiers KV supprimés.
import { assurerSchema, chargerTables, creerDepotEnregistreur, appliquerChangements, ONGLETS_REQUETE } from './depot-d1.js';
import { sha256Hex } from './crypto.js';
import { TRACES_DEMO } from '../backend/noyau/traces-demo.js';

export const MAX_PASSES = 8;
const ERREUR_TECHNIQUE = { ok: false, erreur: 'erreur_interne', message: 'Erreur technique, réessayez.' };

class BesoinExterieur extends Error {}

// Nom d'expéditeur des mails : le nom de l'association (paramètre nom_appli), comme sur Google.
function nomExpediteur(depot) {
  const ligne = depot.lire('Parametres').find((l) => l.cle === 'nom_appli');
  const nom = ligne ? String(ligne.valeur).trim() : '';
  return nom || 'Sorties VTT';
}

function creerContexte({ depot, adherents, maintenant, uuid, connus, besoins, effets }) {
  const besoin = (ensemble, valeur, texte) => {
    ensemble.add(valeur);
    throw new BesoinExterieur(texte);
  };
  return {
    depot,
    adherents: { lire: () => adherents.map((a) => ({ ...a })) },
    services: {
      maintenant,
      uuid,
      hacher: sha256Hex,
      mail: (destinataires, objet, texte, html) => {
        const m = { to: destinataires, subject: objet, body: texte, html: html || '', name: nomExpediteur(depot) };
        const cle = JSON.stringify(m);
        if (!connus.mails.has(cle)) { besoins.mails.set(cle, m); return; } // envoyé avant la passe suivante
        const issue = connus.mails.get(cle);
        if (issue.erreur) throw new Error(issue.erreur);
      },
      http: (url) => {
        if (!connus.http.has(url)) besoin(besoins.http, url, `réponse attendue : ${url}`);
        const r = connus.http.get(url);
        if (r.erreur) throw new Error(r.erreur);
        return r.donnees;
      },
      fichiers: {
        enregistrer: (nom, contenu) => {
          const id = `kv:${uuid()}`;
          effets.kvEcritures.push([id, contenu]);
          connus.fichiers.set(id, contenu);
          return id;
        },
        lire: (id) => {
          if (String(id).startsWith('demo:')) return TRACES_DEMO[String(id).slice(5)];
          if (!connus.fichiers.has(id)) besoin(besoins.fichiers, id, `fichier attendu : ${id}`);
          const contenu = connus.fichiers.get(id);
          if (contenu === null) throw new Error('Fichier de trace introuvable.');
          return contenu;
        },
        supprimer: (id) => {
          if (!String(id).startsWith('demo:')) effets.kvSuppressions.push(id);
        },
      },
    },
    journal: (type, detail) => depot.ajouter('Journal', [{ horodatage: maintenant().toISOString(), type, detail: String(detail).slice(0, 2000) }]),
  };
}

const aDesBesoins = (b) => b.tables.size || b.http.size || b.fichiers.size || b.mails.size;

async function satisfaire(env, besoins, connus, tables) {
  const fetchImpl = env.fetchImpl || ((...a) => fetch(...a));
  // Table manquante : le choix de départ était trop court ; on charge d'un coup toutes les tables ordinaires encore
  // absentes (plus celle demandée), pour ne pas les découvrir une par une.
  if (besoins.tables.size) {
    const manquantes = new Set([...besoins.tables, ...ONGLETS_REQUETE.filter((o) => !(o in tables))]);
    Object.assign(tables, await chargerTables(env.DB, [...manquantes]));
  }
  for (const url of besoins.http) {
    try {
      const rep = await fetchImpl(url);
      connus.http.set(url, { donnees: await rep.json() });
    } catch (e) {
      connus.http.set(url, { erreur: String(e && e.message ? e.message : e) });
    }
  }
  for (const id of besoins.fichiers) connus.fichiers.set(id, await env.TRACES.get(id));
  for (const [cle, m] of besoins.mails) {
    try {
      await env.passerelle.mail(m);
      connus.mails.set(cle, { ok: true });
    } catch (e) {
      connus.mails.set(cle, { erreur: `Envoi par la passerelle impossible : ${e && e.message ? e.message : e}` });
    }
  }
}

export async function executer(env, travail, { onglets = ONGLETS_REQUETE, adherents = [] } = {}) {
  const instant = (env.maintenant ? env.maintenant() : new Date()).getTime();
  const maintenant = () => new Date(instant);
  const uuids = [];
  await assurerSchema(env.DB);
  const tables = await chargerTables(env.DB, onglets);
  const connus = { http: new Map(), fichiers: new Map(), mails: new Map() };
  for (let passe = 1; passe <= MAX_PASSES; passe++) {
    let n = 0;
    const uuid = () => (uuids[n] ||= crypto.randomUUID(), uuids[n++]);
    const besoins = { tables: new Set(), http: new Set(), fichiers: new Set(), mails: new Map() };
    const effets = { kvEcritures: [], kvSuppressions: [] };
    const depot = creerDepotEnregistreur(tables, { absente: (o) => { besoins.tables.add(o); throw new BesoinExterieur(`table attendue : ${o}`); } });
    const ctx = creerContexte({ depot, adherents, maintenant, uuid, connus, besoins, effets });
    let resultat;
    try {
      resultat = travail(ctx);
    } catch (e) {
      if (!aDesBesoins(besoins)) throw e; // vraie erreur, pas un besoin noté hors d'un try du noyau
    }
    if (aDesBesoins(besoins)) {
      if (passe === MAX_PASSES) break;
      await satisfaire(env, besoins, connus, tables);
      continue;
    }
    // Les fichiers d'abord : une ligne Traces ne désigne jamais un fichier absent.
    for (const [id, contenu] of effets.kvEcritures) await env.TRACES.put(id, contenu);
    await appliquerChangements(env.DB, depot.changements());
    for (const id of effets.kvSuppressions) await env.TRACES.delete(id);
    return resultat;
  }
  return { ...ERREUR_TECHNIQUE };
}
