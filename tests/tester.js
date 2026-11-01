/* Omni-Prompteur — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* ============================================================
   Tests automatiques d'Omni-Prompteur.
   Ils ouvrent l'application dans un vrai navigateur (Chromium, piloté
   par Playwright) avec une FAUSSE caméra et un FAUX micro fournis par
   Chromium, écrivent un texte, le font défiler, enregistrent une courte
   vidéo et vérifient le résultat. Rien n'est envoyé sur internet.

   Lancer (Playwright doit être installé) :  node tests/tester.js
   ============================================================ */
'use strict';
const fs = require('fs');
const { lancer, section, verifier, nouvellePage, controlesCommuns } = require('./outils.js');

const texte = (p, sel) => p.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
async function aller(p, sel) { await p.click(sel); await p.waitForTimeout(400); }
const camera = async (ctx) => { await ctx.grantPermissions(['camera', 'microphone']); };

const SCRIPT = '# Introduction\nBonjour à tous, aujourd’hui on parle de peut-être trois choses.\n[sourire]\n# Conclusion\nMerci et à bientôt #tuto';

lancer('Omni-Prompteur', async () => {
  await controlesCommuns({ serviceWorker: 'sw.js' });

  const { ctx, p } = await nouvellePage({ avant: camera });
  await p.waitForTimeout(800);

  await section('Écrire un texte', async () => {
    await aller(p, '[data-aller="bibliotheque"]');
    await aller(p, '#bouton-nouveau-script');
    await p.fill('#champ-titre', 'Ma vidéo test');
    await p.fill('#champ-texte', SCRIPT);
    await p.waitForTimeout(800);
    const stats = await texte(p, '#statistiques-texte');
    // Bonjour à tous aujourd’hui on parle de peut-être trois choses Merci et à bientôt tuto = 15
    verifier(stats.startsWith('15 mots'), '15 mots : titres « # … » et [indications] non comptés', stats);
    verifier(stats.includes('2 sections'), '2 sections repérées', stats);
    await aller(p, '#bouton-utiliser-script');
    verifier((await texte(p, '#script-actif-titre')).includes('Ma vidéo test'), 'il devient le texte actif de l’accueil', await texte(p, '#script-actif-titre'));
  });

  await section('Le texte est enregistré', async () => {
    await p.waitForTimeout(1500);
    await p.reload();
    await p.waitForTimeout(800);
    await aller(p, '[data-aller="bibliotheque"]');
    verifier((await texte(p, '#liste-scripts')).includes('Ma vidéo test'), 'le texte est dans la bibliothèque après fermeture');
  });

  await section('Sauvegarde puis restauration sans rien écraser', async () => {
    const [telechargement] = await Promise.all([p.waitForEvent('download'), p.click('#bouton-sauvegarder-scripts')]);
    const chemin = await telechargement.path();
    const contenu = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    verifier(contenu.format === 'prompteur-createurs/scripts' && contenu.version === 1, 'fichier de sauvegarde au bon format', [contenu.format, contenu.version]);
    const avant = await p.$$eval('#liste-scripts > *', (l) => l.length);
    await p.setInputFiles('#champ-restauration', chemin);
    await p.waitForTimeout(1200);
    const apres = await p.$$eval('#liste-scripts > *', (l) => l.length);
    verifier(apres >= avant, 'la restauration n’efface aucun texte existant', [avant, apres]);
  });

  await section('Prompteur et enregistrement (fausse caméra)', async () => {
    await p.goto(p.url().split('#')[0]);
    await p.waitForTimeout(800);
    await aller(p, '#bouton-mode-videaste');
    await p.waitForSelector('#ecran-prompteur:not([hidden])');
    await p.waitForFunction(() => document.getElementById('video-camera').readyState >= 2, null, { timeout: 10000 });
    verifier(true, 'l’image de la caméra s’affiche');
    verifier((await texte(p, '#texte-defilant')).includes('Bonjour à tous'), 'le texte est affiché sur le prompteur');
    await p.click('#bouton-enregistrer');
    await p.waitForSelector('#indicateur-enregistrement:not([hidden])', { timeout: 15000 });
    await p.waitForTimeout(2500);
    await p.click('#bouton-arreter-enregistrement');
    await p.waitForTimeout(2000);
    await p.click('#bouton-quitter-prompteur').catch(() => {});
    await p.waitForTimeout(500);
    await p.goto(p.url().split('#')[0]);
    await p.waitForTimeout(800);
    await aller(p, '[data-aller="enregistrements"]');
    const nb = await p.$$eval('#liste-enregistrements > *', (l) => l.length);
    verifier(nb === 1, 'un enregistrement est rangé dans « Mes enregistrements »', nb);
  });

  await ctx.close();
}, { argsNavigateur: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
