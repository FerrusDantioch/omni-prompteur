/* =========================================================================
   Omni-Prompteur — js/prompteur.js
   -------------------------------------------------------------------------
   Écran du prompteur : lancement des modes Vidéaste et Podcast, ouverture /
   fermeture propre, raccourcis clavier et gestion du passage en arrière-plan.
   ========================================================================= */

import { $, changerIcone } from './outils.js';
import { appliquerReglages } from './reglages.js';
import { notifier, demanderConfirmation } from './dialogues.js';
import { ecranActuel, allerVers, revenir, revenirAccueil } from './navigation.js';
import {
  activerEcranAllume,
  desactiverEcranAllume,
  demanderPleinEcran,
  quitterPleinEcran,
  basculerPleinEcran
} from './ecran-systeme.js';
import {
  defilement,
  preparerTexte,
  demarrerBoucleDefilement,
  arreterBoucleDefilement,
  mettreEnPause,
  basculerLecture,
  revenirAuDebut,
  sauterDe,
  reculer,
  avancer,
  allerSectionSuivante,
  allerSectionPrecedente,
  changerVitesse,
  initialiserGestesTexte
} from './defilement.js';
import { media, arreterPistes, demarrerFluxMedia, changerDeCamera, arreterAnalyseMicro } from './media.js';
import { lireScriptActif } from './scripts.js';
import { ouvrirEditeur } from './editeur.js';
import {
  enregistrement,
  enregistrementEnCours,
  mettreAJourCommandesEnregistrement,
  demanderEnregistrement,
  annulerDecompte,
  basculerPauseEnregistrement,
  arreterEnregistrement
} from './enregistrement.js';
import { definirFiltreEnregistrements } from './enregistrements.js';

export const prompteur = {
  mode: 'videaste', // ou 'podcast'
  script: null
};

let promesseFermeture = null;

/** Boutons « Vidéaste » et « Podcast » de l'accueil. */
export async function lancerMode(mode) {
  let script = null;
  try {
    script = await lireScriptActif();
  } catch (erreur) {
    console.error(erreur);
  }
  if (!script) {
    notifier('Choisissez d\'abord un script, ou créez-en un.');
    allerVers('bibliotheque');
    return;
  }
  if (!script.texte.trim()) {
    notifier('Le script sélectionné est vide : ajoutez-y du texte.');
    ouvrirEditeur(script.id);
    return;
  }
  prompteur.mode = mode;
  prompteur.script = script;
  /* Sur téléphone, on passe en plein écran. Les navigateurs ne l'acceptent
     que juste après un geste de l'utilisateur : c'est le cas ici. */
  if (window.matchMedia('(pointer: coarse)').matches) demanderPleinEcran();
  allerVers('prompteur');
}

/** Appelée à l'arrivée sur l'écran du prompteur. */
export function demarrerPrompteur() {
  if (!prompteur.script) {
    /* Cas rare : retour sur cet écran par l'historique sans script chargé. */
    setTimeout(revenirAccueil, 0);
    return;
  }
  const ecran = $('ecran-prompteur');
  ecran.dataset.mode = prompteur.mode;
  ecran.dataset.micro = 'non';
  definirTexteMasque(false);
  basculerPanneauRapide(false);
  $('message-media').hidden = true;
  $('info-resolution').textContent = '';

  appliquerReglages();
  preparerTexte(prompteur.script.texte);
  mettreEnPause();
  mettreAJourCommandesEnregistrement();
  demarrerBoucleDefilement();
  activerEcranAllume();
  demarrerFluxMedia(prompteur.mode);
}

/** Appelée quand on quitte l'écran du prompteur, quelle qu'en soit la raison. */
export function fermerPrompteur() {
  if (promesseFermeture) return promesseFermeture;

  annulerDecompte();
  mettreEnPause();
  arreterBoucleDefilement();
  basculerPanneauRapide(false);
  desactiverEcranAllume();
  quitterPleinEcran();

  media.jeton = null;
  const flux = media.flux;
  media.flux = null;
  arreterAnalyseMicro();
  $('video-camera').srcObject = null;
  $('info-resolution').textContent = '';

  /* Un enregistrement en cours est arrêté ET sauvegardé sans rouvrir la
     fiche modale par-dessus l'écran de destination. */
  promesseFermeture = Promise.resolve()
    .then(() => arreterEnregistrement({ ouvrirFiche: false }))
    .finally(() => {
      arreterPistes(flux);
      promesseFermeture = null;
    });
  return promesseFermeture;
}

export function definirTexteMasque(masque) {
  $('ecran-prompteur').dataset.texteMasque = masque ? 'oui' : 'non';
  const bouton = $('bouton-masquer-texte');
  bouton.setAttribute('aria-pressed', String(masque));
  bouton.setAttribute('aria-label', masque ? 'Afficher le texte' : 'Masquer le texte');
  changerIcone(bouton, masque ? 'oeil-barre' : 'oeil');
}

/** Bouton « œil » : masque le texte (et met le défilement en pause) pour régler le cadrage. */
export function basculerTexteMasque() {
  const masquer = $('ecran-prompteur').dataset.texteMasque !== 'oui';
  definirTexteMasque(masquer);
  if (masquer) mettreEnPause();
}

export function basculerPanneauRapide(forcer) {
  const panneau = $('panneau-reglages-rapides');
  const ouvrir = typeof forcer === 'boolean' ? forcer : panneau.hidden;
  panneau.hidden = !ouvrir;
  $('bouton-reglages-rapides').setAttribute('aria-expanded', String(ouvrir));
}

/** Quitter le prompteur : on demande confirmation si un enregistrement tourne. */
export async function quitterPrompteurAvecConfirmation(destination) {
  if (enregistrementEnCours()) {
    const accord = await demanderConfirmation({
      titre: 'Arrêter l\'enregistrement ?',
      message: 'L\'enregistrement en cours sera arrêté et sauvegardé sur l\'appareil.',
      bouton: 'Arrêter et quitter'
    });
    if (!accord) return;
  }
  if (destination) allerVers(destination);
  else revenir();
}

/** Raccourcis clavier (ordinateur, clavier Bluetooth, télécommande de présentation). */
export function gererClavierPrompteur(evenement) {
  if (ecranActuel() !== 'prompteur' || evenement.ctrlKey || evenement.metaKey || evenement.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const cible = evenement.target;
  /* Dans un curseur ou une liste, les flèches servent au champ lui-même. */
  if (cible && cible.closest && cible.closest('input, select, textarea')) return;
  /* Espace ou Entrée sur un bouton : c'est le bouton qui réagit. */
  if ((evenement.key === ' ' || evenement.key === 'Enter') && cible && cible.closest && cible.closest('button')) return;

  switch (evenement.key) {
    case ' ':
    case 'k':
    case 'K':
      basculerLecture();
      break;
    case 'ArrowUp':
      sauterDe(-defilement.hauteurLigne);
      break;
    case 'ArrowDown':
      sauterDe(defilement.hauteurLigne);
      break;
    case 'PageUp':
    case 'ArrowLeft':
      reculer();
      break;
    case 'PageDown':
    case 'ArrowRight':
      avancer();
      break;
    case 'Home':
      revenirAuDebut();
      break;
    case 's':
    case 'S':
      allerSectionSuivante();
      break;
    case 'p':
    case 'P':
      allerSectionPrecedente();
      break;
    case '+':
    case '=':
      changerVitesse(10);
      break;
    case '-':
    case '_':
      changerVitesse(-10);
      break;
    case 'm':
    case 'M':
      if (prompteur.mode === 'videaste') basculerTexteMasque();
      break;
    case 'f':
    case 'F':
      basculerPleinEcran();
      break;
    case 'Escape':
      if (evenement.repeat) return;
      if (enregistrement.etat === 'decompte' || !$('decompte').hidden) annulerDecompte();
      else if (!$('panneau-reglages-rapides').hidden) basculerPanneauRapide(false);
      else quitterPrompteurAvecConfirmation();
      break;
    default:
      return; // touche sans rôle : on ne bloque pas son comportement normal
  }
  evenement.preventDefault();
}

/** L'application passe en arrière-plan (autre appli, écran verrouillé…) ou revient. */
export function surChangementVisibilite() {
  if (document.hidden) {
    /* Un décompte en cours est annulé : sinon l'enregistrement démarrerait
       pendant que l'application est en arrière-plan. */
    annulerDecompte();
    /* En mode Vidéaste, la caméra est coupée en arrière-plan : on met en
       pause. En mode Podcast (audio seul), l'enregistrement continue. */
    if (prompteur.mode !== 'podcast' && enregistrement.etat === 'enregistrement') {
      if (basculerPauseEnregistrement()) {
        enregistrement.pauseAutomatique = true;
      }
    }
    return;
  }
  if (ecranActuel() === 'prompteur') activerEcranAllume(); // le verrou saute en arrière-plan
  if (enregistrement.pauseAutomatique && enregistrement.etat === 'pause') {
    notifier('Enregistrement en pause : l\'application est passée en arrière-plan. Touchez « Reprendre » pour continuer.', 'info', 9000);
  }
}

export function initialiserPrompteur() {
  $('bouton-quitter-prompteur').addEventListener('click', () => quitterPrompteurAvecConfirmation());
  $('bouton-voir-enregistrements').addEventListener('click', () => {
    definirFiltreEnregistrements(prompteur.mode === 'podcast' ? 'audio' : 'video');
    quitterPrompteurAvecConfirmation('enregistrements');
  });

  $('bouton-lecture').addEventListener('click', basculerLecture);
  $('bouton-debut').addEventListener('click', revenirAuDebut);
  $('bouton-reculer').addEventListener('click', reculer);
  $('bouton-avancer').addEventListener('click', avancer);
  $('bouton-vitesse-moins').addEventListener('click', () => changerVitesse(-10));
  $('bouton-vitesse-plus').addEventListener('click', () => changerVitesse(10));

  $('bouton-masquer-texte').addEventListener('click', basculerTexteMasque);
  $('bouton-changer-camera').addEventListener('click', changerDeCamera);
  $('bouton-reglages-rapides').addEventListener('click', basculerPanneauRapide);
  $('bouton-plein-ecran').addEventListener('click', basculerPleinEcran);

  $('bouton-enregistrer').addEventListener('click', demanderEnregistrement);
  $('bouton-pause-enregistrement').addEventListener('click', basculerPauseEnregistrement);
  $('bouton-arreter-enregistrement').addEventListener('click', () => arreterEnregistrement());

  $('bouton-reessayer-media').addEventListener('click', () => demarrerFluxMedia());
  $('bouton-fermer-message-media').addEventListener('click', () => { $('message-media').hidden = true; });
  $('decompte').addEventListener('click', annulerDecompte);

  initialiserGestesTexte();
  document.addEventListener('keydown', gererClavierPrompteur);
}
