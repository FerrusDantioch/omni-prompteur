/* =========================================================================
   Omni-Prompteur — js/enregistrements.js
   -------------------------------------------------------------------------
   Écran « Mes enregistrements » et fiche de relecture / renommage /
   téléchargement / partage / conversion WAV / suppression.
   ========================================================================= */

import {
  $,
  creerElement,
  creerIcone,
  creerBouton,
  formaterDuree,
  formaterTaille,
  formaterDate,
  nettoyerNomFichier,
  telechargerFichier
} from './outils.js';
import { bd } from './bd.js';
import { notifier, demanderConfirmation, demanderTexte } from './dialogues.js';
import { ecranActuel } from './navigation.js';
import { convertirEnWav } from './webm-wav.js';

let filtreEnregistrements = 'video';

export function definirFiltreEnregistrements(filtre) {
  filtreEnregistrements = filtre;
}

/** « video/webm;codecs=vp8,opus » → « webm ». */
export function extensionDuFormat(typeMime) {
  if (/mp4/i.test(typeMime)) return 'mp4';
  if (/ogg/i.test(typeMime)) return 'ogg';
  return 'webm';
}

/** L'enregistrement affiché dans la boîte « fiche » (lecteur, nom, boutons). */
export const ficheMedia = { fiche: null, blob: null, adresse: null, promesseNom: null };

export async function afficherEnregistrements() {
  for (const onglet of document.querySelectorAll('.onglet')) {
    onglet.setAttribute('aria-selected', String(onglet.dataset.filtre === filtreEnregistrements));
  }

  let fiches = [];
  try {
    fiches = await bd.lireTout('enregistrements');
  } catch (erreur) {
    notifier('Impossible de lire vos enregistrements : ' + erreur.message, 'erreur');
  }
  const terminees = fiches.filter((fiche) => fiche.statut === 'termine');
  const visibles = terminees
    .filter((fiche) => fiche.type === filtreEnregistrements)
    .sort((a, b) => b.creeLe - a.creeLe);

  $('liste-enregistrements').replaceChildren(...visibles.map(creerElementEnregistrement));

  const messageVide = $('enregistrements-vide');
  messageVide.hidden = visibles.length > 0;
  messageVide.textContent = filtreEnregistrements === 'video'
    ? 'Aucune vidéo pour l\'instant. Lancez le mode Vidéaste, puis touchez « Enregistrer ».'
    : 'Aucun enregistrement audio pour l\'instant. Lancez le mode Podcast, puis touchez « Enregistrer ».';

  afficherEspaceStockage(terminees);
}

export function creerElementEnregistrement(fiche) {
  const extension = extensionDuFormat(fiche.mimeType);
  return creerElement('li', { classe: 'element-liste' }, [
    creerElement('h2', { classe: 'element-titre' }, [creerIcone(fiche.type === 'video' ? 'camera' : 'micro'), fiche.nom]),
    creerElement('p', {
      classe: 'element-meta',
      texte: `${formaterDate(fiche.creeLe)} · ${formaterDuree(fiche.duree)} · ${formaterTaille(fiche.taille)} · .${extension}`
    }),
    creerElement('div', { classe: 'element-actions' }, [
      creerBouton({
        texte: fiche.type === 'video' ? 'Regarder' : 'Écouter',
        icone: 'lecture',
        classe: 'bouton bouton-primaire bouton-petit',
        action: () => ouvrirFicheMedia(fiche)
      }),
      creerBouton({ texte: 'Renommer', icone: 'crayon', action: () => renommerEnregistrement(fiche) }),
      creerBouton({ texte: 'Télécharger', icone: 'telecharger', action: () => telechargerEnregistrement(fiche) }),
      creerBouton({
        texte: 'Supprimer',
        icone: 'corbeille',
        classe: 'bouton bouton-danger bouton-petit',
        action: () => supprimerEnregistrement(fiche)
      })
    ])
  ]);
}

/** Place occupée par les enregistrements et place encore disponible. */
export async function afficherEspaceStockage(fiches) {
  const total = fiches.reduce((somme, fiche) => somme + (fiche.taille || 0), 0);
  let texte = `Vos enregistrements occupent ${formaterTaille(total)} sur cet appareil.`;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (quota) texte += ` Espace encore disponible pour l'application : environ ${formaterTaille(Math.max(0, quota - usage))}.`;
    } catch {
      /* estimation indisponible */
    }
  }
  $('espace-stockage').textContent = texte;
}

/** Ouvre la fiche d'un enregistrement : lecteur, nom modifiable, actions. */
export async function ouvrirFicheMedia(fiche, { nouveau = false } = {}) {
  if (ficheMedia.promesseNom) await ficheMedia.promesseNom;

  let rangement = null;
  try {
    rangement = await bd.lire('fichiers', fiche.id);
  } catch (erreur) {
    console.error(erreur);
  }
  if (!rangement) {
    notifier('Fichier introuvable sur cet appareil.', 'erreur');
    return;
  }

  libererLecteurMedia();
  ficheMedia.fiche = fiche;
  ficheMedia.blob = rangement.blob;
  /* Une adresse « blob: » permet à la balise <video> ou <audio> de lire le
     fichier directement depuis la mémoire de l'appareil. */
  ficheMedia.adresse = URL.createObjectURL(rangement.blob);

  const lecteur = document.createElement(fiche.type === 'video' ? 'video' : 'audio');
  lecteur.controls = true;
  lecteur.preload = 'metadata';
  lecteur.playsInline = true;
  lecteur.src = ficheMedia.adresse;
  $('media-lecteur').replaceChildren(lecteur);

  const extension = extensionDuFormat(fiche.mimeType);
  $('media-titre').textContent = nouveau ? 'Enregistrement terminé ✓' : fiche.type === 'video' ? 'Vidéo' : 'Audio';
  $('media-nom').value = fiche.nom;
  $('media-infos').textContent =
    `${formaterDate(fiche.creeLe)} · ${formaterDuree(fiche.duree)} · ${formaterTaille(fiche.taille)} · format .${extension}`
    + (nouveau ? '\nSauvegardé sur cet appareil. Téléchargez-le pour le conserver ailleurs.' : '');
  $('media-telecharger-texte').textContent = `Télécharger (.${extension})`;
  $('media-wav').hidden = fiche.type !== 'audio';
  $('media-partager').hidden = !partagePossible(fiche, rangement.blob);

  const dialogue = $('dialogue-media');
  if (!dialogue.open) dialogue.showModal();
}

/** Arrête la lecture et libère la mémoire occupée par le lecteur. */
export function libererLecteurMedia() {
  const lecteur = $('media-lecteur').firstElementChild;
  if (lecteur) {
    lecteur.pause();
    lecteur.removeAttribute('src');
    lecteur.load();
  }
  $('media-lecteur').replaceChildren();
  if (ficheMedia.adresse) URL.revokeObjectURL(ficheMedia.adresse);
  ficheMedia.adresse = null;
  ficheMedia.blob = null;
}

/** Enregistre le nom tapé dans la fiche, s'il a changé (sérialisé via promesseNom). */
export async function enregistrerNomDepuisFiche() {
  if (ficheMedia.promesseNom) await ficheMedia.promesseNom;
  const fiche = ficheMedia.fiche;
  const nom = $('media-nom').value.trim();
  if (!fiche) return;
  if (!nom) {
    $('media-nom').value = fiche.nom;
    return;
  }
  if (nom !== fiche.nom) {
    const promesse = modifierNomEnregistrement(fiche, nom);
    ficheMedia.promesseNom = promesse;
    try {
      await promesse;
    } finally {
      if (ficheMedia.promesseNom === promesse) ficheMedia.promesseNom = null;
    }
  }
}

export async function modifierNomEnregistrement(fiche, nom) {
  try {
    const actuelle = await bd.lire('enregistrements', fiche.id);
    if (!actuelle) return;
    actuelle.nom = nom.slice(0, 120);
    await bd.ecrire('enregistrements', actuelle);
    fiche.nom = actuelle.nom;
    if (ecranActuel() === 'enregistrements') afficherEnregistrements();
  } catch (erreur) {
    notifier('Le nouveau nom n\'a pas pu être enregistré : ' + erreur.message, 'erreur');
  }
}

export async function renommerEnregistrement(fiche) {
  const nom = await demanderTexte({ titre: 'Renommer l\'enregistrement', etiquette: 'Nouveau nom', valeur: fiche.nom });
  if (!nom || nom === fiche.nom) return;
  await modifierNomEnregistrement(fiche, nom);
  notifier('Enregistrement renommé.', 'succes');
}

export async function telechargerEnregistrement(fiche, blobDejaCharge) {
  let blob = blobDejaCharge;
  if (!blob) {
    const rangement = await bd.lire('fichiers', fiche.id).catch(() => null);
    blob = rangement && rangement.blob;
  }
  if (!blob) {
    notifier('Fichier introuvable sur cet appareil.', 'erreur');
    return;
  }
  telechargerFichier(blob, `${nettoyerNomFichier(fiche.nom)}.${extensionDuFormat(fiche.mimeType)}`);
}

/* --- Partage (Android, iPhone…) --- */

export function fichierAPartager(fiche, blob) {
  const typeSimple = (blob.type || fiche.mimeType || '').split(';')[0]; // « video/webm;codecs=… » → « video/webm »
  return new File([blob], `${nettoyerNomFichier(fiche.nom)}.${extensionDuFormat(fiche.mimeType)}`, { type: typeSimple });
}

export function partagePossible(fiche, blob) {
  try {
    return Boolean(navigator.canShare && navigator.canShare({ files: [fichierAPartager(fiche, blob)] }));
  } catch {
    return false;
  }
}

export async function partagerEnregistrement() {
  if (ficheMedia.promesseNom || (ficheMedia.fiche && $('media-nom').value.trim() && $('media-nom').value.trim() !== ficheMedia.fiche.nom)) {
    await enregistrerNomDepuisFiche();
  }
  const { fiche, blob } = ficheMedia;
  if (!fiche || !blob) return;
  try {
    await navigator.share({ files: [fichierAPartager(fiche, blob)], title: fiche.nom });
  } catch (erreur) {
    if (erreur.name !== 'AbortError') notifier('Partage impossible : ' + erreur.message, 'erreur');
  }
}

export async function telechargerEnWav() {
  await enregistrerNomDepuisFiche();
  const { fiche, blob } = ficheMedia;
  if (!fiche || !blob) return;
  if (fiche.duree > 45 * 60 * 1000) {
    const accord = await demanderConfirmation({
      titre: 'Conversion d\'un long enregistrement',
      message: 'Cet enregistrement dépasse 45 minutes : sa conversion en .wav demande beaucoup de mémoire et peut échouer sur un téléphone.',
      bouton: 'Convertir quand même',
      danger: false
    });
    if (!accord) return;
  }
  const bouton = $('media-wav');
  bouton.disabled = true;
  notifier('Conversion en .wav en cours…');
  try {
    const wav = await convertirEnWav(blob);
    telechargerFichier(wav, `${nettoyerNomFichier(fiche.nom)}.wav`);
  } catch (erreur) {
    console.error(erreur);
    notifier('La conversion en .wav a échoué : ' + erreur.message, 'erreur');
  } finally {
    bouton.disabled = false;
  }
}

export async function supprimerEnregistrement(fiche) {
  const accord = await demanderConfirmation({
    titre: 'Supprimer cet enregistrement ?',
    message: `« ${fiche.nom} » sera définitivement effacé de cet appareil. Téléchargez-le d'abord si vous souhaitez le garder.`,
    bouton: 'Supprimer'
  });
  if (!accord) return false;
  try {
    await bd.supprimerEnregistrement(fiche.id);
  } catch (erreur) {
    notifier('Suppression impossible : ' + erreur.message, 'erreur');
    return false;
  }
  notifier('Enregistrement supprimé.');
  if (ecranActuel() === 'enregistrements') afficherEnregistrements();
  return true;
}

export function initialiserEnregistrements() {
  for (const onglet of document.querySelectorAll('.onglet')) {
    onglet.addEventListener('click', () => {
      filtreEnregistrements = onglet.dataset.filtre;
      afficherEnregistrements();
    });
  }

  const dialogue = $('dialogue-media');
  $('media-fermer').addEventListener('click', () => dialogue.close());
  dialogue.addEventListener('close', async () => {
    const fiche = ficheMedia.fiche;
    libererLecteurMedia();
    await enregistrerNomDepuisFiche(); // un nom modifié juste avant de fermer n'est pas perdu
    if (ficheMedia.fiche === fiche) ficheMedia.fiche = null;
  });
  $('media-nom').addEventListener('change', () => {
    enregistrerNomDepuisFiche();
  });
  $('media-telecharger').addEventListener('click', async () => {
    await enregistrerNomDepuisFiche();
    if (ficheMedia.fiche) await telechargerEnregistrement(ficheMedia.fiche, ficheMedia.blob);
  });
  $('media-partager').addEventListener('click', partagerEnregistrement);
  $('media-wav').addEventListener('click', telechargerEnWav);
  $('media-supprimer').addEventListener('click', async () => {
    if (ficheMedia.promesseNom) await ficheMedia.promesseNom;
    const fiche = ficheMedia.fiche;
    if (fiche && (await supprimerEnregistrement(fiche))) {
      ficheMedia.fiche = null;
      dialogue.close();
    }
  });
}
