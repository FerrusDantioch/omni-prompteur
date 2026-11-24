/* =========================================================================
   Omni-Prompteur — js/pdf.js
   -------------------------------------------------------------------------
   Chargement à la demande de pdf.js (Mozilla, libs/pdfjs/) et extraction
   du texte d'un PDF avec reconstitution des paragraphes.
   ========================================================================= */

import { nettoyerTexteImporte } from './outils.js';

export const TAILLE_MAX_PDF = 150 * 1024 * 1024; // 150 Mo

let promessePdfJs = null;

/**
 * Charge pdf.js seulement quand on en a besoin (environ 1,8 Mo) : le
 * démarrage de l'application reste ainsi rapide. import() est la version
 * « à la demande » de l'instruction import.
 */
export function chargerPdfJs() {
  if (!promessePdfJs) {
    promessePdfJs = import('../libs/pdfjs/pdf.min.mjs')
      .then((pdfjs) => {
        /* Le gros du travail se fait dans un « worker » : un script qui tourne
           en parallèle, pour que l'interface ne se fige pas pendant la lecture. */
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('../libs/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
        return pdfjs;
      })
      .catch((erreur) => {
        promessePdfJs = null; // on pourra réessayer
        throw erreur;
      });
  }
  return promessePdfJs;
}

/** Extrait le texte de toutes les pages d'un PDF. */
export async function extraireTexteDuPdf(fichier, signalerProgression) {
  if (fichier.size > TAILLE_MAX_PDF) throw new Error('fichier trop volumineux (plus de 150 Mo).');

  let pdfjs;
  try {
    pdfjs = await chargerPdfJs();
  } catch (erreur) {
    console.error(erreur);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('l\'import PDF nécessite une connexion Internet lors de la première utilisation (le lecteur est ensuite conservé hors ligne).');
    }
    throw new Error('le lecteur de PDF n\'a pas pu démarrer.');
  }

  const donnees = new Uint8Array(await fichier.arrayBuffer());
  /* getDocument() renvoie une « tâche de chargement » : sa propriété promise
     fournit le document, et sa méthode destroy() libère tout à la fin. */
  const tache = pdfjs.getDocument({
    data: donnees,
    /* Sécurité : pdf.js n'a jamais le droit de fabriquer et d'exécuter du
       code à partir du contenu du PDF. */
    isEvalSupported: false,
    enableXfa: false
  });
  let documentPdf;
  try {
    documentPdf = await tache.promise;
  } catch (erreur) {
    tache.destroy().catch(() => {});
    if (erreur && erreur.name === 'PasswordException') throw new Error('ce PDF est protégé par un mot de passe.');
    if (erreur && erreur.name === 'InvalidPDFException') throw new Error('ce fichier PDF est invalide ou endommagé.');
    throw new Error('ce PDF n\'a pas pu être ouvert.');
  }

  try {
    const pages = [];
    for (let numero = 1; numero <= documentPdf.numPages; numero += 1) {
      if (signalerProgression) signalerProgression(`Extraction du texte : page ${numero} sur ${documentPdf.numPages}…`);
      const page = await documentPdf.getPage(numero);
      const contenu = await page.getTextContent();
      pages.push(reconstituerLignes(contenu.items));
      page.cleanup();
    }
    const texte = assemblerParagraphes(pages);
    if (!texte.trim()) {
      throw new Error('ce PDF ne contient pas de texte sélectionnable (document scanné ?). Seul un texte « numérique » peut être extrait.');
    }
    return nettoyerTexteImporte(texte);
  } finally {
    tache.destroy().catch(() => {}); // libère la mémoire et arrête le worker
  }
}

/**
 * pdf.js ne renvoie pas des lignes, mais des petits morceaux de texte avec
 * leur position sur la page. On les regroupe en lignes : deux morceaux à la
 * même hauteur appartiennent à la même ligne.
 *
 * Rappel : dans un PDF, la position verticale (y) part du BAS de la page.
 * Une ligne plus bas sur la page a donc un y plus petit.
 *
 * @returns {Array<{texte: string, x: number, y: number, fin: number, hauteur: number}>}
 */
export function reconstituerLignes(elements) {
  const lignes = [];
  let ligne = null;

  const terminerLigne = () => {
    if (ligne && ligne.texte.trim()) {
      ligne.texte = ligne.texte.replace(/\s+/g, ' ').trim();
      lignes.push(ligne);
    }
    ligne = null;
  };

  for (const element of elements) {
    if (typeof element.str !== 'string') continue;
    const x = element.transform[4];
    const y = element.transform[5];
    const hauteur = Math.abs(element.transform[3]) || element.height || 10;

    /* Changement net de hauteur : c'est une nouvelle ligne. */
    if (ligne && element.str.trim() && Math.abs(y - ligne.y) > hauteur * 0.5) terminerLigne();

    if (element.str) {
      if (!ligne) {
        ligne = { texte: '', x, y, fin: x, hauteur };
      } else if (x - ligne.fin > hauteur * 0.15 && !/\s$/.test(ligne.texte) && !/^\s/.test(element.str)) {
        ligne.texte += ' '; // espace visuel entre deux morceaux, sans caractère espace
      }
      if (!ligne.texte.trim()) ligne.x = x;
      ligne.texte += element.str;
      ligne.fin = Math.max(ligne.fin, x + (element.width || 0));
      ligne.hauteur = Math.max(ligne.hauteur, hauteur);
    }
    if (element.hasEOL) terminerLigne(); // pdf.js signale lui-même certaines fins de ligne
  }
  terminerLigne();
  return lignes;
}

/**
 * Recolle les lignes en paragraphes.
 * Dans un PDF, chaque ligne s'arrête au bord de la page. Sur le prompteur,
 * dont la largeur est différente, ces retours à la ligne forcés donneraient
 * un texte haché. On rejoint donc les lignes d'un même paragraphe, et on ne
 * garde une séparation que là où un nouveau paragraphe commence vraiment.
 */
export function assemblerParagraphes(pages) {
  const paragraphes = [];
  let courant = '';

  const terminerParagraphe = () => {
    if (courant.trim()) paragraphes.push(courant.trim());
    courant = '';
  };

  for (const lignesDeLaPage of pages) {
    const lignes = lignesDeLaPage.filter((ligne) => !estNumeroDePage(ligne.texte));
    if (!lignes.length) continue;

    /* Écart « habituel » entre deux lignes de cette page : la médiane,
       c'est-à-dire la valeur du milieu, insensible aux quelques grands
       sauts entre paragraphes. */
    const ecarts = [];
    for (let i = 1; i < lignes.length; i += 1) {
      const ecart = lignes[i - 1].y - lignes[i].y;
      if (ecart > 0) ecarts.push(ecart);
    }
    const ecartHabituel = medianeBasse(ecarts) || lignes[0].hauteur * 1.2;
    const bordGauche = Math.min(...lignes.map((l) => l.x));
    const bordDroit = Math.max(...lignes.map((l) => l.fin));
    const largeurColonne = bordDroit - bordGauche;

    lignes.forEach((ligne, i) => {
      if (i > 0) {
        const precedente = lignes[i - 1];
        const ecart = precedente.y - ligne.y;
        /* Indices d'un nouveau paragraphe : */
        const grandEcart = ecart > ecartHabituel * 1.45;                      // une ligne vide
        const changementDeTaille =
          Math.abs(ligne.hauteur - precedente.hauteur) > Math.min(ligne.hauteur, precedente.hauteur) * 0.25; // un titre
        const ligneCourteTerminee =
          precedente.fin < bordGauche + largeurColonne * 0.8 && /[.!?:…»"”)]$/.test(precedente.texte); // fin de phrase avant le bord
        const elementDeListe = /^([•◦▪‣·*–—-]|\d{1,2}[.)])\s/.test(ligne.texte); // puce ou numéro
        if (grandEcart || changementDeTaille || ligneCourteTerminee || elementDeListe) terminerParagraphe();
      }
      courant = recollerLigne(courant, ligne.texte);
    });

    /* Fin de page : on ne coupe que si la phrase est terminée (sinon le
       paragraphe continue sur la page suivante). */
    if (/[.!?:…»"”]$/.test(courant.trim())) terminerParagraphe();
  }
  terminerParagraphe();
  return paragraphes.join('\n\n');
}

/** Ajoute une ligne à la fin d'un paragraphe en cours. */
export function recollerLigne(courant, texte) {
  if (!courant) return texte;
  /* Mot coupé en fin de ligne (« porte-» + « monnaie ») : pas d'espace. */
  if (/\p{L}-$/u.test(courant) && /^\p{Ll}/u.test(texte)) return courant + texte;
  return `${courant} ${texte}`;
}

/** Repère les numéros de page (« 3 », « - 3 - », « Page 3 / 10 ») pour les ignorer. */
export function estNumeroDePage(texte) {
  return /^[\s–—-]*(page\s*)?\d{1,4}(\s*(\/|sur|of)\s*\d{1,4})?[\s–—-]*$/i.test(texte);
}

/**
 * Médiane « basse » : la valeur du milieu une fois les nombres triés ; s'il y
 * en a un nombre pair, la plus petite des deux valeurs du milieu (et non leur
 * moyenne).
 */
export function medianeBasse(nombres) {
  if (!nombres.length) return 0;
  const tries = [...nombres].sort((a, b) => a - b);
  return tries[Math.floor((tries.length - 1) / 2)];
}
