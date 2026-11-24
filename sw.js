/* =========================================================================
   Service worker d'Omni-Prompteur
   -------------------------------------------------------------------------
   Un « service worker » est un petit script que le navigateur installe à
   côté de la page. Il s'intercale entre l'application et le réseau : ici,
   il range une copie de TOUS les fichiers de l'application sur l'appareil,
   pour qu'elle démarre et fonctionne ensuite sans aucune connexion.

   ⚠️ RÈGLE D'OR : après toute modification d'un fichier listé dans FICHIERS,
   incrémenter VERSION ci-dessous (v11 → v12 → v13…). Sans ce changement, le
   navigateur ne détecte aucune nouveauté et continue de servir l'ancienne
   copie indéfiniment, même si le dépôt GitHub est à jour.
   Un fichier AJOUTÉ doit aussi être inscrit dans FICHIERS, sinon il
   manquera hors ligne.
   ========================================================================= */

const VERSION = 'omni-prompteur-v11';

/* Début commun à tous nos caches. Il permet de reconnaître (et de supprimer)
   les caches de nos anciennes versions sans toucher à rien d'autre. */
const PREFIXE_CACHE = 'omni-prompteur-';

/* Début des caches de l'époque où l'application s'appelait « Prompteur
   Créateurs » : eux aussi sont supprimés, ils ne servent plus. */
const ANCIEN_PREFIXE_CACHE = 'prompteur-createurs-';

/* La liste complète des fichiers nécessaires au fonctionnement hors ligne. */
const FICHIERS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './js/outils.js',
  './js/bd.js',
  './js/navigation.js',
  './js/dialogues.js',
  './js/ecran-systeme.js',
  './js/pdf.js',
  './js/webm-wav.js',
  './js/reglages.js',
  './js/scripts.js',
  './js/defilement.js',
  './js/media.js',
  './js/enregistrements.js',
  './js/editeur.js',
  './js/enregistrement.js',
  './js/scripts-io.js',
  './js/pwa.js',
  './js/prompteur.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './fonts/atkinson-hyperlegible-next.woff2',
  './fonts/lexend.woff2',
  './fonts/literata.woff2',
  './fonts/roboto-mono.woff2',
  './fonts/opendyslexic-400.woff2',
  './fonts/opendyslexic-700.woff2'
];

/* Cache dédié pour pdf.js (~1,84 Mo) : téléchargé à la demande lors du
   premier import PDF, puis conservé entre les mises à jour de l'application.
   Incrémenter CACHE_PDF uniquement lors d'une mise à jour de libs/pdfjs/. */
const CACHE_PDF = 'omni-prompteur-pdf-v1';
const FICHIERS_PDF = [
  './libs/pdfjs/pdf.min.mjs',
  './libs/pdfjs/pdf.worker.min.mjs'
];

const estFichierPdf = (url) => {
  const chemin = new URL(url).pathname;
  return FICHIERS_PDF.some((fichier) => chemin.endsWith(fichier.slice(1)));
};

async function migrerCachePdf(noms) {
  const anciensCachesApp = noms.filter(
    (nom) => nom.startsWith(PREFIXE_CACHE) && !nom.startsWith('omni-prompteur-pdf-') && nom !== VERSION
  );
  if (!anciensCachesApp.length) return;
  const cachePdf = await caches.open(CACHE_PDF);
  for (const fichier of FICHIERS_PDF) {
    if (await cachePdf.match(fichier, { ignoreSearch: true })) continue;
    for (const ancien of anciensCachesApp) {
      const cacheAncien = await caches.open(ancien);
      const reponse = await cacheAncien.match(fichier, { ignoreSearch: true });
      if (reponse) {
        await cachePdf.put(fichier, reponse.clone());
        break;
      }
    }
  }
}

/* 1. INSTALLATION : on télécharge et on range les fichiers de base. -------- */
self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches.open(VERSION).then((cache) =>
      /* { cache: 'reload' } force un vrai téléchargement. Sans cette option,
         le navigateur pourrait reprendre une copie encore présente dans son
         cache HTTP ordinaire (GitHub Pages l'autorise pendant 10 minutes). */
      cache.addAll(FICHIERS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  /* Volontairement, PAS de self.skipWaiting() ici. Une nouvelle version
     attend sagement que l'utilisateur accepte la mise à jour (voir l'étape 3) :
     remplacer l'application en plein enregistrement serait une très mauvaise
     surprise. */
});

/* 2. ACTIVATION : on supprime les caches des versions précédentes. -------- */
self.addEventListener('activate', (evenement) => {
  evenement.waitUntil((async () => {
    const noms = await caches.keys();
    await migrerCachePdf(noms);
    await Promise.all(
      noms
        .filter((nom) =>
          (nom.startsWith(PREFIXE_CACHE) || nom.startsWith(ANCIEN_PREFIXE_CACHE))
          && nom !== VERSION
          && nom !== CACHE_PDF
        )
        .map((nom) => caches.delete(nom))
    );
    /* clients.claim() : le service worker prend immédiatement le contrôle
       des pages déjà ouvertes, sans attendre qu'elles soient rechargées. */
    await self.clients.claim();
  })());
});

/* 3. MESSAGE DE LA PAGE : l'utilisateur a touché « Mettre à jour ». ------- */
self.addEventListener('message', (evenement) => {
  if (evenement.data && evenement.data.type === 'ACTIVER_NOUVELLE_VERSION') {
    /* skipWaiting() met cette version en service ; la page le remarque
       (événement « controllerchange ») et se recharge d'elle-même. */
    self.skipWaiting();
  }
});

/* 4. REQUÊTES : on sert d'abord la copie rangée sur l'appareil. ----------- */
self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;

  /* On ne s'occupe que des lectures (GET) dans le périmètre de l'application.
     Sur ferrusdantioch.github.io, self.registration.scope isole strictement
     Omni-Prompteur des autres applications du même domaine. */
  if (requete.method !== 'GET') return;
  if (!requete.url.startsWith(self.registration.scope)) return;

  if (estFichierPdf(requete.url)) {
    evenement.respondWith((async () => {
      const cachePdf = await caches.open(CACHE_PDF);
      const copie = await cachePdf.match(requete, { ignoreSearch: true });
      if (copie) return copie;

      const reponse = await fetch(requete);
      if (reponse && reponse.status === 200 && reponse.type === 'basic') {
        await cachePdf.put(requete, reponse.clone());
        evenement.waitUntil((async () => {
          for (const url of FICHIERS_PDF) {
            if (await cachePdf.match(url, { ignoreSearch: true })) continue;
            const autre = await fetch(new Request(url, { cache: 'reload' })).catch(() => null);
            if (autre && autre.status === 200 && autre.type === 'basic') {
              await cachePdf.put(url, autre);
            }
          }
        })());
      }
      return reponse;
    })());
    return;
  }

  evenement.respondWith((async () => {
    /* On cherche dans le cache de CETTE version précisément (et non dans
       tous les caches à la fois), pour ne jamais mélanger deux versions. */
    const cache = await caches.open(VERSION);
    const copie = await cache.match(requete, { ignoreSearch: true });
    if (copie) return copie;

    try {
      /* Fichier absent du cache : on tente le réseau. */
      return await fetch(requete);
    } catch (erreur) {
      /* Hors ligne : pour l'ouverture d'une page, on renvoie l'accueil. */
      if (requete.mode === 'navigate') {
        const accueil = await cache.match('./index.html');
        if (accueil) return accueil;
      }
      throw erreur;
    }
  })());
});
