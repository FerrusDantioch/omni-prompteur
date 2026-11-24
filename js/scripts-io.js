/* =========================================================================
   Omni-Prompteur — js/scripts-io.js
   -------------------------------------------------------------------------
   Import de fichiers (.txt, .md, .pdf), export individuel (.txt, .md) et
   sauvegarde / restauration JSON complète de la bibliothèque de scripts.
   ========================================================================= */

import {
  $,
  nouvelIdentifiant,
  retirerCaracteresParasites,
  nettoyerTexteImporte,
  nettoyerNomFichier,
  dateDuJour,
  nombreDeScripts,
  telechargerFichier
} from './outils.js';
import { bd } from './bd.js';
import { notifier } from './dialogues.js';
import { extraireTexteDuPdf } from './pdf.js';
import { chargerScripts, creerScript, afficherBibliotheque } from './scripts.js';
import { ouvrirEditeur } from './editeur.js';

export const TAILLE_MAX_TEXTE = 10 * 1024 * 1024;    // 10 Mo : bien plus qu'un script réel
export const FORMAT_SAUVEGARDE = 'prompteur-createurs/scripts';
export const VERSION_SAUVEGARDE = 1;
export const TAILLE_MAX_SAUVEGARDE = 50 * 1024 * 1024; // 50 Mo : des milliers de scripts

/** Réagit au choix d'un ou plusieurs fichiers dans le champ d'import. */
export async function importerFichiersChoisis(evenement) {
  const champ = evenement.target;
  const fichiers = [...champ.files];
  champ.value = ''; // permet de réimporter plus tard le même fichier
  if (!fichiers.length) return;

  const etat = $('etat-import');
  const crees = [];

  for (const fichier of fichiers) {
    try {
      etat.hidden = false;
      etat.textContent = `Lecture de « ${fichier.name} »…`;
      const texte = await lireTexteDuFichier(fichier, (message) => { etat.textContent = message; });
      if (!texte.trim()) throw new Error('aucun texte trouvé dans ce fichier.');
      const titre = fichier.name.replace(/\.(txt|md|pdf)$/i, '').replace(/_+/g, ' ').trim() || 'Script importé';
      crees.push(await creerScript({ titre, texte }));
    } catch (erreur) {
      console.error(erreur);
      notifier(`« ${fichier.name} » : ${erreur.message}`, 'erreur');
    }
  }
  etat.hidden = true;

  if (crees.length === 1) {
    /* Un seul fichier : on l'ouvre dans l'éditeur pour vérifier le texte
       (un PDF demande parfois quelques retouches). */
    notifier('Fichier importé et enregistré. Vérifiez le texte si besoin.', 'succes');
    ouvrirEditeur(crees[0].id);
  } else if (crees.length > 1) {
    notifier(`${crees.length} scripts importés.`, 'succes');
    afficherBibliotheque();
  }
}

/** Choisit la bonne méthode de lecture selon le type de fichier. */
export async function lireTexteDuFichier(fichier, signalerProgression) {
  const nom = (fichier.name || '').toLowerCase();
  const type = (fichier.type || '').toLowerCase();
  if (type === 'application/pdf' || nom.endsWith('.pdf')) {
    return extraireTexteDuPdf(fichier, signalerProgression);
  }
  if (
    type.startsWith('text/')
    || type === 'text/markdown'
    || type === 'text/x-markdown'
    || nom.endsWith('.txt')
    || nom.endsWith('.md')
  ) {
    return lireFichierTexte(fichier);
  }
  throw new Error('format non pris en charge. Seuls les fichiers .txt, .md et .pdf sont acceptés.');
}

/**
 * Lit un fichier .txt ou .md en devinant son encodage (UTF-16, UTF-8, windows-1252).
 */
export async function lireFichierTexte(fichier) {
  if (fichier.size > TAILLE_MAX_TEXTE) throw new Error('fichier trop volumineux (plus de 10 Mo).');
  const octets = new Uint8Array(await fichier.arrayBuffer());
  let texte;

  if (octets[0] === 0xff && octets[1] === 0xfe) {
    texte = new TextDecoder('utf-16le').decode(octets);
  } else if (octets[0] === 0xfe && octets[1] === 0xff) {
    texte = new TextDecoder('utf-16be').decode(octets);
  } else {
    try {
      /* fatal: true = lever une erreur si les octets ne sont pas de l'UTF-8 valide. */
      texte = new TextDecoder('utf-8', { fatal: true }).decode(octets);
    } catch {
      texte = new TextDecoder('windows-1252').decode(octets);
    }
  }
  return nettoyerTexteImporte(texte);
}

/** Exporte un script individuel au format .txt ou .md. */
export function exporterScript(script, format = 'txt') {
  if (!script || !script.texte || !script.texte.trim()) {
    notifier('Le script est vide : rien à exporter.');
    return;
  }
  const extension = format === 'md' ? 'md' : 'txt';
  const typeMime = extension === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  const nomFichier = `${nettoyerNomFichier(script.titre, 'script')}.${extension}`;
  const blob = new Blob([script.texte], { type: typeMime });
  telechargerFichier(blob, nomFichier);
}

/** Bouton « Sauvegarder mes scripts » : télécharge un fichier .json. */
export async function sauvegarderTousLesScripts() {
  let scripts;
  try {
    scripts = await chargerScripts();
  } catch (erreur) {
    notifier('Impossible de lire la bibliothèque : ' + erreur.message, 'erreur');
    return;
  }
  if (!scripts.length) {
    notifier('La bibliothèque est vide : il n\'y a rien à sauvegarder.');
    return;
  }
  const contenu = {
    format: FORMAT_SAUVEGARDE,
    version: VERSION_SAUVEGARDE,
    sauvegardeLe: new Date().toISOString(),
    scripts: scripts.map(({ id, titre, texte, creeLe, modifieLe }) => ({ id, titre, texte, creeLe, modifieLe }))
  };
  /* JSON.stringify(…, null, 2) : fichier indenté, lisible dans un éditeur de texte. */
  const fichier = new Blob([JSON.stringify(contenu, null, 2)], { type: 'application/json' });
  telechargerFichier(fichier, `omni-prompteur-scripts-${dateDuJour()}.json`);
  notifier(`Sauvegarde créée : ${nombreDeScripts(scripts.length)}. Rangez ce fichier en lieu sûr.`, 'succes');
}

/**
 * Lit et vérifie un fichier de sauvegarde. Rien n'est cru sur parole : chaque
 * script est contrôlé (types, longueurs, caractères) avant d'entrer dans la base.
 */
export async function lireSauvegarde(fichier) {
  if (fichier.size > TAILLE_MAX_SAUVEGARDE) throw new Error('fichier trop volumineux (plus de 50 Mo).');
  let donnees;
  try {
    donnees = JSON.parse(await fichier.text());
  } catch {
    throw new Error('ce fichier n\'est pas une sauvegarde lisible.');
  }
  if (!donnees || donnees.format !== FORMAT_SAUVEGARDE || !Array.isArray(donnees.scripts)) {
    throw new Error('ce fichier n\'est pas une sauvegarde d\'Omni-Prompteur.');
  }
  if (Number(donnees.version) > VERSION_SAUVEGARDE) {
    throw new Error('cette sauvegarde vient d\'une version plus récente de l\'application. Mettez l\'application à jour, puis réessayez.');
  }

  const maintenant = Date.now();
  const dateValide = (valeur) => (Number.isFinite(valeur) && valeur > 0 ? valeur : maintenant);
  const identifiantsVus = new Set();
  const scripts = [];

  for (const brut of donnees.scripts) {
    if (!brut || typeof brut.texte !== 'string') continue;
    const titre = typeof brut.titre === 'string'
      ? retirerCaracteresParasites(brut.titre).replace(/\s+/g, ' ').trim().slice(0, 120)
      : '';
    const texte = retirerCaracteresParasites(brut.texte);
    if (!titre && !texte.trim()) continue; // script vide : inutile

    /* Identifiant absent, farfelu ou en double dans le fichier : on en fabrique un. */
    let id = typeof brut.id === 'string' && brut.id.length > 0 && brut.id.length <= 100 ? brut.id : '';
    if (!id || identifiantsVus.has(id)) id = nouvelIdentifiant();
    identifiantsVus.add(id);

    scripts.push({ id, titre, texte, creeLe: dateValide(brut.creeLe), modifieLe: dateValide(brut.modifieLe) });
  }
  if (!scripts.length) throw new Error('aucun script trouvé dans cette sauvegarde.');
  return scripts;
}

/**
 * Bouton « Restaurer une sauvegarde ». Aucun script existant n'est jamais
 * écrasé.
 */
export async function restaurerSauvegarde(evenement) {
  const champ = evenement.target;
  const fichier = champ.files[0];
  champ.value = ''; // permet de choisir à nouveau le même fichier plus tard
  if (!fichier) return;

  try {
    const scripts = await lireSauvegarde(fichier);
    const existants = new Map((await chargerScripts()).map((script) => [script.id, script]));

    const aEcrire = [];
    let dejaPresents = 0;
    for (const script of scripts) {
      const existant = existants.get(script.id);
      if (!existant) {
        aEcrire.push(script);
      } else if (existant.titre === script.titre && existant.texte === script.texte) {
        dejaPresents += 1;
      } else {
        const titre = `${script.titre || 'Sans titre'} (sauvegarde)`.slice(0, 120);
        aEcrire.push({ ...script, id: nouvelIdentifiant(), titre });
      }
    }

    /* Une seule transaction : soit tous les scripts sont ajoutés, soit aucun. */
    if (aEcrire.length) await bd.ecrireEnsemble(aEcrire.map((objet) => ({ magasin: 'scripts', objet })));

    let message = aEcrire.length
      ? `${nombreDeScripts(aEcrire.length)} restauré${aEcrire.length > 1 ? 's' : ''}.`
      : 'Rien à restaurer : tous ces scripts sont déjà sur cet appareil.';
    if (aEcrire.length && dejaPresents) message += ` ${nombreDeScripts(dejaPresents)} déjà présent${dejaPresents > 1 ? 's' : ''}, ignoré${dejaPresents > 1 ? 's' : ''}.`;
    notifier(message, aEcrire.length ? 'succes' : 'info');
  } catch (erreur) {
    console.error(erreur);
    notifier(`« ${fichier.name} » : ${erreur.message}`, 'erreur');
  }
  afficherBibliotheque();
}
