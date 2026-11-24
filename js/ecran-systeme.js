/* =========================================================================
   Omni-Prompteur — js/ecran-systeme.js
   -------------------------------------------------------------------------
   Maintien de l'écran allumé (Wake Lock), plein écran et verrouillage
   d'orientation pendant l'enregistrement.
   ========================================================================= */

import { $, changerIcone } from './outils.js';
import { ecranActuel } from './navigation.js';

let verrouEcran = null;

export async function activerEcranAllume() {
  if (!('wakeLock' in navigator) || document.hidden || ecranActuel() !== 'prompteur') return;
  if (verrouEcran && !verrouEcran.released) return;
  try {
    verrouEcran = await navigator.wakeLock.request('screen');
    /* Le prompteur a pu être quitté pendant la demande. */
    if (ecranActuel() !== 'prompteur') desactiverEcranAllume();
  } catch (erreur) {
    console.info('Maintien de l\'écran allumé refusé :', erreur.message);
  }
}

export function desactiverEcranAllume() {
  if (verrouEcran) verrouEcran.release().catch(() => {});
  verrouEcran = null;
}

/* Plein écran. Les préfixes « webkit » servent aux anciens Safari. */

export function elementEnPleinEcran() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

export function demanderPleinEcran() {
  const racine = document.documentElement;
  const demande = racine.requestFullscreen || racine.webkitRequestFullscreen;
  if (!demande || elementEnPleinEcran()) return;
  try {
    const resultat = demande.call(racine, { navigationUI: 'hide' });
    if (resultat && resultat.catch) resultat.catch(() => { /* refus : on reste en fenêtre */ });
  } catch {
    /* navigateur sans plein écran */
  }
}

export function quitterPleinEcran() {
  if (!elementEnPleinEcran()) return;
  const sortie = document.exitFullscreen || document.webkitExitFullscreen;
  try {
    const resultat = sortie.call(document);
    if (resultat && resultat.catch) resultat.catch(() => {});
  } catch {
    /* rien à faire */
  }
}

export function basculerPleinEcran() {
  if (elementEnPleinEcran()) quitterPleinEcran();
  else demanderPleinEcran();
}

export function mettreAJourBoutonPleinEcran() {
  const bouton = $('bouton-plein-ecran');
  const actif = Boolean(elementEnPleinEcran());
  changerIcone(bouton, actif ? 'quitter-plein-ecran' : 'plein-ecran');
  bouton.setAttribute('aria-label', actif ? 'Quitter le plein écran' : 'Plein écran');
  bouton.hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
}

/* Orientation : pendant un enregistrement, on fige l'orientation actuelle.
   Tourner le téléphone en pleine prise changerait le format de la vidéo en
   cours de route. (Refusé par certains navigateurs hors plein écran : sans
   conséquence.) */

export function verrouillerOrientation() {
  const orientation = screen.orientation;
  if (!orientation || typeof orientation.lock !== 'function') return;
  orientation.lock(orientation.type).catch(() => {});
}

export function deverrouillerOrientation() {
  try {
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  } catch {
    /* pas de verrou en place */
  }
}

export function initialiserEcranSysteme() {
  mettreAJourBoutonPleinEcran();
  document.addEventListener('fullscreenchange', mettreAJourBoutonPleinEcran);
  document.addEventListener('webkitfullscreenchange', mettreAJourBoutonPleinEcran);
}
