# Omni-Prompteur — notes pour Claude

PWA de télé-prompteur (modes Vidéaste et Podcast) en **HTML/CSS/JS pur, sans
framework ni étape de compilation**. Dépôt **public sous licence Creative Commons
BY-NC-ND 4.0** (ni vente ni modification, voir `LICENSE`) ; l'application
en ligne est gratuite et un bouton de don est prévu. Code et commentaires en
français, rédigés pour un développeur débutant : conserver ce niveau
d'explication dans toute modification.

## ⚠️ Avant de pousser : incrémenter la version du service worker

Après toute modification d'un fichier **mis en cache** (`index.html`, `styles.css`,
`app.js`, `manifest.json`, `icons/`, `fonts/`, `libs/`), incrémenter la constante en
haut de `sw.js` :

```js
const VERSION = 'omni-prompteur-v9';   // → v10
```

Sans ce changement, le navigateur ne détecte aucun service worker différent, ne
retélécharge rien, et **toute personne ayant déjà ouvert l'application continue de
voir l'ancienne version**. Le symptôme est trompeur : le dépôt est à jour, mais
l'application ne change pas.

En cas d'**ajout de fichier**, l'inscrire aussi dans la liste `FICHIERS` de `sw.js`,
sinon il manquera hors ligne.

**Ne pas** incrémenter pour un changement qui ne touche aucun fichier du cache
(README, CLAUDE.md, `.gitignore`, `.gitattributes`, `serveur-local.js`, `.claude/`).

La mise à jour n'est pas imposée : le nouveau service worker attend, et un bandeau
propose « Mettre à jour » (refusé pendant un enregistrement).

## Contraintes du projet

- **Licence Creative Commons BY-NC-ND 4.0** (`LICENSE`, depuis octobre 2026, après
  une licence propriétaire puis une autre licence non commerciale) : le code peut être utilisé
  et partagé à l'identique en citant l'auteur, mais jamais modifié ni utilisé dans
  un but commercial. Le fichier commence par « © 2026 Ferrus Dantioch », puis
  contient le texte officiel anglais et la traduction française officielle de
  Creative Commons, copiés sans aucune
  modification (ne jamais les retoucher). Ne pas proposer d'autre licence, et ne
  pas modifier `LICENSE` sans demande explicite.
- **Aucun appel réseau externe, aucun CDN.** La CSP de `index.html`
  (`default-src 'self'`) les bloquerait de toute façon. Une bibliothèque doit être
  copiée dans `libs/`, sous licence permissive uniquement (MIT, Apache 2.0, BSD ;
  jamais GPL), et ajoutée au tableau des licences du README.
- **Pas de style en ligne** (`style="…"`) dans le HTML : la CSP le bloque. Passer par
  `styles.css`, ou par `element.style` en JavaScript (autorisé).
- Texte venant de l'utilisateur ou d'un fichier importé : toujours `textContent`,
  jamais `innerHTML`.
- Aucune donnée personnelle, clé ou identifiant dans le code.

## Architecture en bref

- `app.js` : 17 sections numérotées, sommaire en tête de fichier. Les écrans sont des
  éléments `data-ecran` affichés un par un ; chaque changement est inscrit dans
  l'historique pour que le bouton retour d'Android fonctionne.
- Réglages : `localStorage`. Tout champ portant `data-reglage="nom"` est relié
  automatiquement au réglage (écran Réglages et panneau rapide du prompteur).
- IndexedDB `prompteur-createurs` : `scripts`, `enregistrements` (fiches légères),
  `fichiers` (blobs), `morceaux` (morceaux écrits chaque seconde pendant un
  enregistrement, réassemblés à l'arrêt, ou au démarrage suivant après une
  interruption).
- Scripts : une ligne `# Titre` (dièse + espace) est un titre de section
  (`LIGNE_SECTION`), exclu du compte de mots. Sauvegarde/restauration en JSON
  (`format: 'prompteur-createurs/scripts'`, `version: 1`) ; la restauration n'écrase
  jamais un script existant.
- Enregistrement : `MediaRecorder` sur le flux caméra/micro uniquement ; le texte du
  prompteur n'est jamais capté. La durée des WebM est ajoutée par un correctif de
  l'en-tête EBML (`corrigerDureeWebm`).
- pdf.js 6.3.289 (build « legacy ») dans `libs/pdfjs/`, chargé à la demande avec
  `import()`.

## Tester en local

```bash
node serveur-local.js   # puis http://localhost:5190
```

Caméra, micro et service worker exigent `https://` ou `http://localhost`.

## Piège d'outillage

Les outils d'écriture de fichiers de Claude convertissent les séquences d'échappement
Unicode (antislash, « u », quatre chiffres hexadécimaux) en vrais caractères. Dans le
code, préférer les classes Unicode des expressions régulières (`\p{Cc}`, `\p{L}`) ou
les caractères littéraux, puis vérifier avec `node --check app.js`.

## Déploiement

GitHub Pages, branche `main`, racine → https://ferrusdantioch.github.io/omni-prompteur/

## Champ `id` du manifeste : nom du dossier, jamais `./`

`manifest.json` contient `"id": "/omni-prompteur/"`. Chrome résout `id` par rapport à
la **racine du domaine** (`https://ferrusdantioch.github.io/`), pas par
rapport au dossier de l'application : `"id": "./"` (ou `"."`) donnait donc
l'identité de la racine du site, la même pour toutes les applications qui
l'utilisaient. C'est une exception voulue à la règle des chemins relatifs.

Ne plus changer cette valeur : pour Chrome, une application déjà installée
dont l'`id` change devient une autre application (il faut la désinstaller
puis la réinstaller pour qu'elle reprenne les mises à jour).

Exception unique (octobre 2026) : l'application s'appelait « Prompteur Créateurs » et
vivait à `/prompteur-createurs/`. Le renommage du dépôt a changé son adresse,
donc son `id` : les personnes qui l'avaient installée doivent la réinstaller
depuis la nouvelle adresse (leurs données restent, le stockage n'a pas changé).

## ⚠️ Plusieurs applications sur `ferrusdantioch.github.io` : limite de Chrome Android

Toutes les applications du portfolio partagent la même adresse d'origine
(`ferrusdantioch.github.io`). Constaté en octobre 2026 sur le téléphone de
l'utilisateur : **Chrome Android n'accepte d'installer qu'une seule de ces
applications**. Dès qu'une est installée, les autres affichent « Cette appli
est déjà installée », même avec des `id` et des `scope` tous différents
(corriger l'`id`, ci-dessus, n'a pas suffi). **Brave installe toutes les
applications sans problème** : ce n'est pas un défaut des applications.

Contournements : installer depuis Brave, ou choisir « Créer un raccourci »
dans Chrome (l'application s'ouvre alors dans un onglet Chrome). Solution
durable si l'application doit être distribuée : une adresse (origine)
distincte par application (Cloudflare Pages, Netlify, sous-domaine d'un nom
de domaine, organisation GitHub…). À savoir aussi : une même origine
signifie stockage (IndexedDB, localStorage) et autorisations (micro,
notifications) partagés entre toutes ces applications.
