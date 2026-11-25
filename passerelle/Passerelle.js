/* Passerelle Apps Script de l'essai Cloudflare : seul lien entre le Worker et Google.
 *   doPost      : adherents_lire (lecture seule du fichier des adhérents) et mail_envoyer (MailApp).
 *   ticHoraire  : appelle toutes les heures l'adresse /tic du Worker (le compte Cloudflare n'a plus de Cron Trigger).
 *   installer   : crée le déclencheur horaire de ticHoraire (sans doublon).
 * Chaque échange est signé : enveloppe { h: horodatage, s: HMAC-SHA256 hexadécimal de « h.c », c: contenu JSON },
 * refusée si la signature est fausse ou date de plus de 5 minutes.
 *
 * Propriétés du script (Paramètres du projet → Propriétés du script) :
 *   SECRET_PASSERELLE  même valeur que le secret du Worker
 *   ADHERENTS_ID       identifiant du fichier des adhérents (une copie pendant l'essai)
 *   URL_WORKER         adresse du Worker (https://resavtt-essai.<compte>.workers.dev)
 *   PORTEUR_EMAIL      seul destinataire des mails pendant l'essai
 *   MODE_ESSAI         « non » pour envoyer aux vrais destinataires (par défaut : essai)
 */

var VALIDITE_MS = 5 * 60 * 1000;
var COLONNES_ADHERENTS = ['nom', 'telephone', 'email', 'actif', 'admin'];

function propriete(cle) {
  return PropertiesService.getScriptProperties().getProperty(cle);
}

function repondre(objet) {
  return ContentService.createTextOutput(JSON.stringify(objet)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Passerelle Sorties VTT : OK').setMimeType(ContentService.MimeType.TEXT);
}

function signature(secret, h, c) {
  return Utilities.computeHmacSha256Signature(h + '.' + c, secret, Utilities.Charset.UTF_8)
    .map(function (o) { var v = (o < 0 ? o + 256 : o).toString(16); return v.length < 2 ? '0' + v : v; })
    .join('');
}

// Comparaison à durée constante.
function egales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function enveloppeValide(env) {
  var secret = propriete('SECRET_PASSERELLE');
  if (!secret || !env || typeof env.c !== 'string') return false;
  var h = Number(env.h);
  if (!isFinite(h) || Math.abs(Date.now() - h) > VALIDITE_MS) return false;
  return egales(signature(secret, h, env.c), String(env.s || ''));
}

function doPost(e) {
  var env;
  try { env = JSON.parse(e.postData.contents); } catch (err) { env = null; }
  if (!enveloppeValide(env)) return repondre({ ok: false, erreur: 'refuse', message: 'Signature absente ou invalide.' });
  var req = JSON.parse(env.c);
  if (req.action === 'adherents_lire') return repondre({ ok: true, data: lireAdherents() });
  if (req.action === 'mail_envoyer') {
    envoyerMail(req);
    return repondre({ ok: true, data: null });
  }
  return repondre({ ok: false, erreur: 'action_inconnue', message: 'Action inconnue.' });
}

// Première feuille du fichier : en-têtes en ligne 1 (nom, telephone, email, actif, admin), lignes vides écartées.
function lireAdherents() {
  var valeurs = SpreadsheetApp.openById(propriete('ADHERENTS_ID')).getSheets()[0].getDataRange().getValues();
  var entetes = valeurs[0].map(function (v) { return String(v).trim().toLowerCase(); });
  return valeurs.slice(1).map(function (ligne) {
    var a = {};
    COLONNES_ADHERENTS.forEach(function (col) { var i = entetes.indexOf(col); a[col] = i >= 0 ? ligne[i] : ''; });
    return a;
  }).filter(function (a) { return String(a.nom).trim() || String(a.telephone).trim(); });
}

// Pendant l'essai, tout mail part au seul porteur, objet préfixé « [Essai] ».
function envoyerMail(req) {
  var essai = propriete('MODE_ESSAI') !== 'non';
  var options = {
    to: essai ? propriete('PORTEUR_EMAIL') : req.to,
    subject: (essai ? '[Essai] ' : '') + req.subject,
    body: req.body,
    name: req.name || 'Sorties VTT',
  };
  if (req.html) options.htmlBody = req.html;
  MailApp.sendEmail(options);
}

function ticHoraire() {
  var c = JSON.stringify({ action: 'tic' });
  var h = Date.now();
  var url = String(propriete('URL_WORKER') || '').replace(/\/+$/, '') + '/tic';
  var rep = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
    payload: JSON.stringify({ h: h, s: signature(propriete('SECRET_PASSERELLE'), h, c), c: c }),
  });
  Logger.log('tic : ' + rep.getResponseCode() + ' ' + rep.getContentText());
}

function installer() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ticHoraire') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ticHoraire').timeBased().everyHours(1).create();
  Logger.log('Déclencheur horaire ticHoraire installé.');
}
