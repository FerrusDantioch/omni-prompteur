/* =========================================================================
   Omni-Prompteur — js/pwa.js
   -------------------------------------------------------------------------
   Installation PWA (beforeinstallprompt) et mises à jour du service worker
   (bandeau « Mettre à jour » / « Plus tard »).
   ========================================================================= */

import { $ } from './outils.js';
import { notifier } from './dialogues.js';
import { enregistrement } from './enregistrement.js';

let invitationInstallation = null;
let miseAJourDemandee = false;

export function initialiserInstallation() {
  window.addEventListener('beforeinstallprompt', (evenement) => {
    evenement.preventDefault();
    invitationInstallation = evenement;
    $('bouton-installer').hidden = false;
  });

  $('bouton-installer').addEventListener('click', async () => {
    if (!invitationInstallation) return;
    invitationInstallation.prompt();
    await invitationInstallation.userChoice.catch(() => null);
    invitationInstallation = null;
    $('bouton-installer').hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    $('bouton-installer').hidden = true;
    notifier('Application installée !', 'succes');
  });
}

export function initialiserServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /* Ce changement a aussi lieu à la toute première installation : on ne
       recharge que si c'est une mise à jour acceptée. */
    if (miseAJourDemandee) window.location.reload();
  });

  navigator.serviceWorker.register('./sw.js')
    .then((inscription) => {
      const surveiller = (travailleur) => {
        travailleur.addEventListener('statechange', () => {
          if (travailleur.state === 'installed' && navigator.serviceWorker.controller) proposerMiseAJour(inscription);
        });
      };
      if (inscription.waiting && navigator.serviceWorker.controller) proposerMiseAJour(inscription);
      if (inscription.installing) surveiller(inscription.installing);
      inscription.addEventListener('updatefound', () => {
        if (inscription.installing) surveiller(inscription.installing);
      });
      /* À chaque retour dans l'application, on vérifie s'il existe une nouvelle version. */
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) inscription.update().catch(() => {});
      });
    })
    .catch((erreur) => console.warn('Mode hors ligne indisponible :', erreur));
}

export function proposerMiseAJour(inscription) {
  $('bandeau-mise-a-jour').hidden = false;
  /* « onclick = » (et non addEventListener) : si le bandeau est proposé deux
     fois, l'action n'est pas empilée en double. */
  $('bouton-mettre-a-jour').onclick = () => {
    if (enregistrement.etat !== 'inactif') {
      notifier('Terminez d\'abord l\'enregistrement en cours.');
      return;
    }
    miseAJourDemandee = true;
    $('bandeau-mise-a-jour').hidden = true;
    if (inscription.waiting) inscription.waiting.postMessage({ type: 'ACTIVER_NOUVELLE_VERSION' });
    else window.location.reload();
  };
  const boutonPlusTard = $('btn-maj-plus-tard');
  if (boutonPlusTard) {
    boutonPlusTard.onclick = () => {
      $('bandeau-mise-a-jour').hidden = true;
    };
  }
}
