/* =========================================================================
   Omni-Prompteur — app.js
   -------------------------------------------------------------------------
   Point d'entrée de l'application (modules ES natifs, sans compilation).
   Relie les modules entre eux, gère le cycle de vie de la page
   (beforeunload, pagehide, pageshow) et lance l'initialisation.
   ========================================================================= */

import { $ } from './js/outils.js';
import { ouvrirBase } from './js/bd.js';
import {
  definirSurApplication,
  appliquerReglages,
  sauvegarderReglages,
  synchroniserChampsReglages,
  lierChampsReglages
} from './js/reglages.js';
import { ecranActuel, definirActionsEcrans, initialiserNavigation } from './js/navigation.js';
import { notifier } from './js/dialogues.js';
import { activerEcranAllume, desactiverEcranAllume, deverrouillerOrientation, initialiserEcranSysteme } from './js/ecran-systeme.js';
import { afficherAccueil, afficherBibliotheque, initialiserBibliotheque, creerScriptDeBienvenue } from './js/scripts.js';
import { editeur, ouvrirEditeur, sauvegarderEditeur, verifierEditeurOuvert, quitterEditeur, initialiserEditeur } from './js/editeur.js';
import { importerFichiersChoisis, exporterScript, sauvegarderTousLesScripts, restaurerSauvegarde } from './js/scripts-io.js';
import { definirHooksDefilement, demanderNouvellesMesures, demarrerBoucleDefilement, arreterBoucleDefilement, mettreEnPause } from './js/defilement.js';
import {
  media,
  definirActionsMedia,
  arreterPistes,
  demarrerFluxMedia,
  remplirSelecteursAppareils,
  appliquerMiroirCamera,
  arreterAnalyseMicro,
  mettreAJourNiveauMicro,
  initialiserMedia
} from './js/media.js';
import {
  enregistrement,
  definirActionsEnregistrement,
  enregistrementEnCours,
  mettreAJourCommandesEnregistrement,
  annulerDecompte,
  arreterEnregistrement,
  libererVerrou,
  recupererEnregistrementsInterrompus
} from './js/enregistrement.js';
import { afficherEnregistrements, ouvrirFicheMedia, initialiserEnregistrements } from './js/enregistrements.js';
import {
  prompteur,
  lancerMode,
  demarrerPrompteur,
  fermerPrompteur,
  basculerPanneauRapide,
  surChangementVisibilite,
  initialiserPrompteur
} from './js/prompteur.js';
import { initialiserInstallation, initialiserServiceWorker } from './js/pwa.js';

function initialiserCycleDeViePage() {
  window.addEventListener('beforeunload', (evenement) => {
    sauvegarderReglages();
    if (editeur.script && editeur.modifie) sauvegarderEditeur();

    const enregistrementActif =
      enregistrementEnCours() || enregistrement.etat === 'finalisation' || enregistrement.etat === 'demarrage';
    const editeurEnAttente = Boolean(editeur.script && (editeur.modifie || editeur.promesseSauvegarde));
    if (enregistrementActif || editeurEnAttente) {
      evenement.preventDefault();
      evenement.returnValue = '';
    }
  });

  window.addEventListener('pagehide', (evenement) => {
    sauvegarderReglages();
    if (editeur.script && editeur.modifie) sauvegarderEditeur();

    annulerDecompte();
    mettreEnPause();
    arreterBoucleDefilement();
    desactiverEcranAllume();
    deverrouillerOrientation();

    if (enregistrementEnCours()) {
      clearInterval(enregistrement.minuteurChrono);
      enregistrement.minuteurChrono = null;
      /* On force la remise des derniers morceaux sans supprimer fiche/morceaux :
         la récupération après coupure les réassemblera proprement. */
      try {
        enregistrement.enregistreur?.stop();
      } catch {
        /* déjà arrêté */
      }
      if (evenement.persisted) {
        libererVerrou();
        Object.assign(enregistrement, {
          etat: 'inactif',
          enregistreur: null,
          fiche: null,
          promesseFinalisation: null,
          promesseArret: null,
          pauseAutomatique: false,
          ouvrirFicheALaFin: true
        });
      }
    }

    media.jeton = null;
    const flux = media.flux;
    media.flux = null;
    arreterAnalyseMicro();
    arreterPistes(flux);
    const video = $('video-camera');
    if (video) video.srcObject = null;
  });

  window.addEventListener('pageshow', (evenement) => {
    if (!evenement.persisted) return;
    recupererEnregistrementsInterrompus().catch(console.error);
    if (ecranActuel() === 'prompteur') {
      demarrerBoucleDefilement();
      activerEcranAllume();
      demarrerFluxMedia();
      mettreAJourCommandesEnregistrement();
    }
  });
}

async function demarrer() {
  definirActionsEcrans({
    accueil: { arrivee: () => afficherAccueil() },
    bibliotheque: { arrivee: () => afficherBibliotheque() },
    editeur: { arrivee: () => verifierEditeurOuvert(), depart: () => quitterEditeur() },
    reglages: {
      arrivee: () => {
        synchroniserChampsReglages();
        remplirSelecteursAppareils();
      }
    },
    enregistrements: { arrivee: () => afficherEnregistrements() },
    prompteur: { arrivee: () => demarrerPrompteur(), depart: () => fermerPrompteur() }
  });

  definirSurApplication(() => {
    appliquerMiroirCamera();
    demanderNouvellesMesures();
  });

  definirHooksDefilement({
    onImage: mettreAJourNiveauMicro,
    onFermerPanneauRapide: () => basculerPanneauRapide(false)
  });

  definirActionsMedia({
    onChangementFlux: mettreAJourCommandesEnregistrement,
    onArreterEnregistrement: arreterEnregistrement,
    onAnnulerDecompte: annulerDecompte,
    estEnregistrementInactif: () => enregistrement.etat === 'inactif',
    estEnregistrementEnCours: enregistrementEnCours
  });

  definirActionsEnregistrement({
    obtenirContextePrompteur: () => ({ mode: prompteur.mode, script: prompteur.script }),
    onFermerPanneauRapide: () => basculerPanneauRapide(false),
    onTermine: (fiche) => ouvrirFicheMedia(fiche, { nouveau: true })
  });

  initialiserMedia();
  appliquerReglages();
  synchroniserChampsReglages();
  lierChampsReglages({ onReinitialiser: () => remplirSelecteursAppareils() });
  initialiserNavigation();
  initialiserBibliotheque({
    surOuvrirEditeur: ouvrirEditeur,
    surImporter: importerFichiersChoisis,
    surSauvegarder: sauvegarderTousLesScripts,
    surRestaurer: restaurerSauvegarde,
    surLancerMode: lancerMode,
    surExporterScript: exporterScript
  });
  initialiserEditeur({ onExporter: exporterScript });
  initialiserPrompteur();
  initialiserEnregistrements();
  initialiserInstallation();
  initialiserEcranSysteme();
  initialiserCycleDeViePage();

  document.addEventListener('visibilitychange', surChangementVisibilite);

  initialiserServiceWorker();
  remplirSelecteursAppareils().catch(() => {});

  try {
    await ouvrirBase();
    await creerScriptDeBienvenue();
    await recupererEnregistrementsInterrompus();
  } catch (erreur) {
    console.error(erreur);
    notifier('Le stockage local est indisponible (navigation privée ?) : scripts et enregistrements ne pourront pas être conservés.', 'erreur');
  }
  afficherAccueil();
}

demarrer();
