// Liste des adhérents : tenue dans Google Sheets, lue par la passerelle, gardée une heure dans KV (clé « adherents »).
// Relue aussitôt quand un numéro absent tente de se connecter (au plus une fois par minute), pour qu'un adhérent ajouté
// au fichier puisse se connecter tout de suite. Passerelle en panne : la liste en cache sert, même périmée.
import { normaliserTelephone } from '../site/sorties/js/logique/telephone.js';

export const DUREE_CACHE_ADHERENTS_MS = 60 * 60 * 1000;
const RELECTURE_MIN_MS = 60 * 1000;
const CLE = 'adherents';

export class ServiceIndisponible extends Error {
  constructor() {
    super('Liste des adhérents momentanément indisponible, réessayez dans un instant.');
    this.code = 'service_indisponible';
  }
}

// Comme la lecture côté Google : numéros normalisés, lignes sans nom ou sans numéro écartées.
function nettoyer(bruts) {
  return (bruts || []).map((a) => ({
    nom: String(a.nom || '').trim(),
    telephone: normaliserTelephone(String(a.telephone || '')) || '',
    email: String(a.email || '').trim(),
    actif: a.actif,
    admin: a.admin,
  })).filter((a) => a.nom && a.telephone);
}

// forcer : relire la passerelle quel que soit l'âge du cache (tic), le cache ne servant qu'en cas de panne.
// memoire : objet gardé par le Durable Object entre les requêtes. La liste y est tenue ; KV n'en garde une copie (pour
// un redémarrage) que lorsqu'elle change, et l'écriture KV peut échouer (quota) sans faire perdre la liste fraîche.
export async function adherentsPourRequete(env, requete, { forcer = false, memoire = {} } = {}) {
  const maintenant = (env.maintenant ? env.maintenant() : new Date()).getTime();
  if (!memoire.cache) {
    try { memoire.cache = JSON.parse(await env.TRACES.get(CLE)); } catch (e) { memoire.cache = null; }
  }
  const cache = memoire.cache;
  const age = cache ? maintenant - cache.lu_a : Infinity;
  const derniereLecture = Math.max(memoire.derniereLecture || 0, cache ? cache.lu_a : 0);
  const telephone = requete && requete.action === 'connexion' ? normaliserTelephone(String(requete.telephone || '')) : '';
  const inconnu = !!(telephone && cache && !cache.liste.some((a) => a.telephone === telephone));
  const aRelire = forcer || !cache || age > DUREE_CACHE_ADHERENTS_MS || (inconnu && maintenant - derniereLecture > RELECTURE_MIN_MS);
  if (!aRelire) return cache.liste;
  memoire.derniereLecture = maintenant;
  let liste;
  try {
    liste = nettoyer(await env.passerelle.adherents());
  } catch (e) {
    if (!cache || inconnu) throw new ServiceIndisponible();
    return cache.liste;
  }
  const change = !cache || JSON.stringify(cache.liste) !== JSON.stringify(liste);
  memoire.cache = { lu_a: maintenant, liste };
  if (change) {
    try { await env.TRACES.put(CLE, JSON.stringify(memoire.cache)); } catch (e) { /* quota KV : la liste fraîche sert quand même */ }
  }
  return liste;
}
