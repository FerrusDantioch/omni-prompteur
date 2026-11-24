/* =========================================================================
   Petit serveur local pour tester l'application (facultatif).
   -------------------------------------------------------------------------
   L'application elle-même n'a besoin d'AUCUN outil : ce sont de simples
   fichiers HTML/CSS/JS. Mais les navigateurs n'autorisent la caméra, le
   micro et le mode hors ligne (service worker) que sur une adresse sécurisée :
   « https:// » ou « http://localhost ». Jamais sur un fichier ouvert par
   double-clic (« file:// »). Ce fichier sert juste à ça.

   Utilisation :   node serveur-local.js
   Puis ouvrir :   http://localhost:5190
   ========================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5190;
const RACINE = __dirname;

/* Sécurité : par défaut, le serveur ne répond QU'À CET ORDINATEUR
   (127.0.0.1, l'adresse « moi-même »). Les autres appareils du réseau, par
   exemple sur le Wi-Fi d'un café, ne peuvent donc pas lire les fichiers du
   dossier. Pour un essai volontaire depuis un autre appareil du réseau :
     HOTE=0.0.0.0 node serveur-local.js
   (le texte s'affichera, mais caméra et micro resteront bloqués : sur une
   adresse autre que localhost, le navigateur exige https://). */
const HOTE = process.env.HOTE || '127.0.0.1';

/* À chaque extension de fichier correspond un « type de contenu ».
   Détail important : les modules JavaScript (.mjs, utilisés par pdf.js)
   DOIVENT être annoncés comme du JavaScript, sinon le navigateur les refuse. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};

function envoyerTexte(reponse, statut, corps, methode, entetesExtra = {}) {
  const tampon = Buffer.from(corps, 'utf8');
  reponse.writeHead(statut, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': tampon.length,
    ...entetesExtra
  });
  reponse.end(methode === 'HEAD' ? undefined : tampon);
}

const serveur = http.createServer((requete, reponse) => {
  /* Un serveur de fichiers statiques n'accepte que la lecture (GET et HEAD). */
  const methode = (requete.method || 'GET').toUpperCase();
  if (methode !== 'GET' && methode !== 'HEAD') {
    envoyerTexte(reponse, 405, 'Méthode non autorisée', methode, {
      Allow: 'GET, HEAD'
    });
    return;
  }

  let demande;
  try {
    /* On retire les paramètres (?…) et l'ancre (#…), puis on décode les accents. */
    const urlBrute = (requete.url || '/').split('?')[0].split('#')[0];
    demande = decodeURIComponent(urlBrute);
  } catch {
    envoyerTexte(reponse, 400, 'Adresse invalide', methode);
    return;
  }

  if (demande.includes('\0')) {
    envoyerTexte(reponse, 400, 'Adresse invalide', methode);
    return;
  }

  /* On ramène les antislashs (Windows) en slashs avant d'inspecter le chemin. */
  const demandeNorm = demande.replace(/\\/g, '/');
  const chemin = demandeNorm.endsWith('/') ? demandeNorm + 'index.html' : demandeNorm;
  const cheminRelatif = chemin.replace(/^\/+/, '');
  const fichier = path.resolve(RACINE, cheminRelatif);

  /* Sécurité : le fichier demandé doit rester à l'intérieur du dossier de
     l'application (pas de « ../../ ») et ne doit jamais viser un fichier
     ou dossier caché commençant par « . » (.git, .claude, .gitignore, .env…). */
  const racinePrefixe = RACINE.endsWith(path.sep) ? RACINE : RACINE + path.sep;
  const relatif = path.relative(RACINE, fichier);
  const segmentCacheDemande = demandeNorm
    .split('/')
    .some((segment) => segment.startsWith('.') && segment !== '.');
  const segmentCacheResolu = relatif
    .split(/[/\\]+/)
    .some((segment) => segment.startsWith('.'));

  if (
    !fichier.startsWith(racinePrefixe) ||
    !relatif ||
    relatif.startsWith('..') ||
    path.isAbsolute(relatif) ||
    segmentCacheDemande ||
    segmentCacheResolu
  ) {
    envoyerTexte(reponse, 403, 'Accès refusé', methode);
    return;
  }

  fs.readFile(fichier, (erreur, contenu) => {
    if (erreur) {
      envoyerTexte(reponse, 404, 'Fichier introuvable : ' + chemin, methode);
      return;
    }
    reponse.writeHead(200, {
      'Content-Type': TYPES[path.extname(fichier).toLowerCase()] || 'application/octet-stream',
      'Content-Length': contenu.length,
      /* Pendant les tests, on évite que le navigateur garde d'anciennes
         versions des fichiers dans son cache ordinaire. */
      'Cache-Control': 'no-cache'
    });
    reponse.end(methode === 'HEAD' ? undefined : contenu);
  });
});

serveur.listen(PORT, HOTE, () => {
  const adresse = serveur.address();
  const portEffectif = typeof adresse === 'object' && adresse ? adresse.port : PORT;
  console.log('Omni-Prompteur : http://localhost:' + portEffectif);
  if (HOTE !== '127.0.0.1') console.log('Attention : le serveur est aussi accessible depuis le réseau (' + HOTE + ').');
});
