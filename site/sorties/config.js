// Configuration de l'appli. urlApi : adresse de l'API (essai : le Worker Cloudflare).
// En local (localhost), l'appli parle au serveur de développement (outils/serveur-dev.js) sur /api,
// sauf si localStorage['sorties-vtt-api'] contient une autre URL.
const enLocal = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

function surcharge() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('sorties-vtt-api') : null;
  } catch (e) {
    return null;
  }
}

export const CONFIG = {
  urlApi: surcharge() || (enLocal ? '/api' : 'https://resavtt-essai.lologar69.workers.dev/'),
  urlAppli: '',
  indiceDemo: 'Démo : essayez 06 00 00 00 02 (Ben) ou votre propre numéro (administrateur).',
};
