// Client de la passerelle Apps Script (liste des adhérents, envoi des mails).
// Une application web Apps Script ne lit pas les en-têtes HTTP : la signature voyage dans le corps, en enveloppe
// { h: horodatage, s: signature, c: contenu JSON signé }. La passerelle refuse une signature fausse ou de plus de 5 min.
import { signer } from './crypto.js';

export function creerPasserelle({ url, secret, fetchImpl = (...a) => fetch(...a), maintenant = () => new Date() }) {
  async function appeler(action, donnees = {}) {
    const c = JSON.stringify({ action, ...donnees });
    const h = maintenant().getTime();
    const s = await signer(secret, h, c);
    const rep = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ h, s, c }) });
    const r = await rep.json();
    if (!r || !r.ok) throw new Error((r && (r.message || r.erreur)) || 'Réponse invalide de la passerelle.');
    return r.data;
  }
  return {
    adherents: () => appeler('adherents_lire'),
    mail: ({ to, subject, body, html, name }) => appeler('mail_envoyer', { to, subject, body, html: html || '', name: name || '' }),
  };
}
