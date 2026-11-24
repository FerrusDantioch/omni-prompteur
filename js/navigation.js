/* =========================================================================
   Omni-Prompteur — js/navigation.js
   -------------------------------------------------------------------------
   Navigation entre les écrans de l'application et gestion de l'historique
   pour que le bouton « retour » d'Android (ou du navigateur) fonctionne.
   ========================================================================= */

const ECRANS = ['accueil', 'bibliotheque', 'editeur', 'reglages', 'enregistrements', 'prompteur'];
let actuel = 'accueil';
/* Nombre d'écrans empilés au-dessus de l'accueil dans l'historique. */
let profondeurHistorique = 0;

/** Actions à exécuter à l'arrivée ou au départ d'un écran (enregistrées par app.js). */
let actionsEcrans = {};
let chaineTransition = Promise.resolve();
let idTransition = 0;

/** Renvoie le nom de l'écran actuellement affiché. */
export const ecranActuel = () => actuel;

/** Identifiant monotone incrémenté à chaque changement d'écran réel. */
export const jetonNavigation = () => idTransition;

/** Renvoie une promesse résolue une fois la transition d'écran en cours terminée. */
export const attendreTransition = () => chaineTransition.catch(() => {});

/** Enregistre les fonctions arrivee / depart associées à chaque écran. */
export function definirActionsEcrans(actions) {
  actionsEcrans = actions || {};
}

/**
 * Affiche un écran et masque tous les autres (sans toucher à l'historique).
 * Sérialise les transitions asynchrones depart() -> arrivee() pour éviter les
 * courses (ex. : quitter l'éditeur ou le prompteur avant la fin de l'écriture).
 */
export function afficherEcran(nom) {
  if (!ECRANS.includes(nom)) nom = 'accueil';
  const precedent = actuel;
  if (precedent === nom) return chaineTransition;

  for (const ecran of document.querySelectorAll('[data-ecran]')) {
    ecran.hidden = ecran.dataset.ecran !== nom;
  }
  actuel = nom;
  document.body.classList.toggle('prompteur-actif', nom === 'prompteur');
  window.scrollTo(0, 0);

  const jeton = ++idTransition;
  chaineTransition = chaineTransition
    .catch(() => {})
    .then(async () => {
      try {
        await actionsEcrans[precedent]?.depart?.();
      } catch (erreur) {
        console.error(erreur);
      }
      if (jeton !== idTransition || actuel !== nom) return;
      try {
        await actionsEcrans[nom]?.arrivee?.();
      } catch (erreur) {
        console.error(erreur);
      }
    });
  return chaineTransition;
}

/** Va vers un écran en l'ajoutant à l'historique (ou en remplaçant l'actuel). */
export function allerVers(nom, { remplacer = false } = {}) {
  if (nom === actuel) return;
  if (!remplacer) profondeurHistorique += 1;
  const etat = { ecran: nom, profondeur: profondeurHistorique };
  if (remplacer) history.replaceState(etat, '', '#' + nom);
  else history.pushState(etat, '', '#' + nom);
  afficherEcran(nom);
}

/** Écran précédent (comme le bouton retour du téléphone). */
export function revenir() {
  if (profondeurHistorique > 0) history.back();
  else allerVers('accueil', { remplacer: true });
}

/** Retour direct à l'accueil, en « dépilant » tout l'historique de l'appli. */
export function revenirAccueil() {
  if (profondeurHistorique > 0) history.go(-profondeurHistorique);
  else afficherEcran('accueil');
}

export function initialiserNavigation() {
  /* Au démarrage, on part toujours de l'accueil (même après un rechargement
     de page sur un autre écran). */
  history.replaceState({ ecran: 'accueil', profondeur: 0 }, '', '#accueil');

  window.addEventListener('popstate', (evenement) => {
    const etat = evenement.state || { ecran: 'accueil', profondeur: 0 };
    profondeurHistorique = etat.profondeur || 0;
    afficherEcran(etat.ecran);
  });

  /* Un seul écouteur pour tous les boutons data-aller et data-action :
     c'est la « délégation d'événements ». */
  document.addEventListener('click', (evenement) => {
    const lien = evenement.target.closest('[data-aller]');
    if (lien) allerVers(lien.dataset.aller);
    if (evenement.target.closest('[data-action="retour"]')) revenir();
    const annulation = evenement.target.closest('[data-action="annuler-dialogue"]');
    if (annulation) annulation.closest('dialog').close('annuler');
  });
}
