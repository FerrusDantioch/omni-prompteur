/* =========================================================================
   Omni-Prompteur — js/enregistrement.js
   -------------------------------------------------------------------------
   Enregistrement via MediaRecorder, sauvegarde au fil de l'eau dans
   IndexedDB (morceaux), verrou Web Locks et récupération post-coupure.
   ========================================================================= */

import { $, changerIcone, nouvelIdentifiant, formaterDuree, formaterDate } from './outils.js';
import { bd, executerDansMagasin, demanderStockagePersistant } from './bd.js';
import { reglages } from './reglages.js';
import { notifier } from './dialogues.js';
import { ecranActuel } from './navigation.js';
import { verrouillerOrientation, deverrouillerOrientation } from './ecran-systeme.js';
import { lancerLecture, mettreEnPause } from './defilement.js';
import { media } from './media.js';
import { mesurerDureeMedia, corrigerDureeWebm } from './webm-wav.js';

export const enregistrement = {
  etat: 'inactif',              // 'inactif' | 'decompte' | 'demarrage' | 'enregistrement' | 'pause' | 'finalisation'
  enregistreur: null,           // l'objet MediaRecorder
  fiche: null,                  // la fiche de l'enregistrement dans la base
  indexMorceau: 0,
  ecritures: Promise.resolve(), // file d'attente des écritures de morceaux
  erreurEcriture: null,
  promesseArret: null,          // résolue quand MediaRecorder a vraiment fini
  promesseFinalisation: null,
  ouvrirFicheALaFin: true,
  debutSegment: 0,              // instant du dernier démarrage ou de la dernière reprise
  dureeCumulee: 0,              // durée enregistrée avant la dernière reprise (ms)
  pauseAutomatique: false,
  minuteurChrono: null,
  minuteurDecompte: null,
  finDecompte: null,
  libererVerrou: null
};

let actionsEnregistrement = {};

export function definirActionsEnregistrement(actions) {
  actionsEnregistrement = actions || {};
}

/* Formats essayés dans l'ordre de préférence. */
export const FORMATS_VIDEO = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4'
];
export const FORMATS_VIDEO_SANS_AUDIO = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4'
];
export const FORMATS_AUDIO = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus'
];

export function choisirFormat(type, { avecAudio = true } = {}) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  const candidats = type === 'video'
    ? (avecAudio ? FORMATS_VIDEO : FORMATS_VIDEO_SANS_AUDIO)
    : FORMATS_AUDIO;
  return candidats.find((format) => MediaRecorder.isTypeSupported(format)) || '';
}

export function enregistrementEnCours() {
  return enregistrement.etat === 'enregistrement' || enregistrement.etat === 'pause';
}

/** Durée réellement enregistrée, pauses exclues (ms). */
export function dureeEnregistree() {
  const segmentEnCours = enregistrement.etat === 'enregistrement' ? performance.now() - enregistrement.debutSegment : 0;
  return enregistrement.dureeCumulee + segmentEnCours;
}

/** Met les boutons d'enregistrement en accord avec l'état actuel. */
export function mettreAJourCommandesEnregistrement() {
  const etat = enregistrement.etat;
  const actif = enregistrementEnCours();
  const possible = Boolean(media.flux) && 'MediaRecorder' in window;

  const boutonEnregistrer = $('bouton-enregistrer');
  boutonEnregistrer.hidden = actif || etat === 'finalisation';
  boutonEnregistrer.disabled = !possible || etat === 'decompte' || etat === 'demarrage';
  boutonEnregistrer.title = possible ? 'Démarrer l\'enregistrement' : 'Caméra ou micro indisponible';

  const boutonPause = $('bouton-pause-enregistrement');
  boutonPause.hidden = !actif;
  changerIcone(boutonPause, etat === 'pause' ? 'rec' : 'pause');
  boutonPause.querySelector('span').textContent = etat === 'pause' ? 'Reprendre' : 'Pause';

  const boutonArreter = $('bouton-arreter-enregistrement');
  boutonArreter.hidden = !(actif || etat === 'finalisation');
  boutonArreter.disabled = etat === 'finalisation';
  boutonArreter.querySelector('span').textContent = etat === 'finalisation' ? 'Sauvegarde…' : 'Arrêter';

  const indicateur = $('indicateur-enregistrement');
  indicateur.hidden = !(actif || etat === 'finalisation');
  indicateur.classList.toggle('en-pause', etat !== 'enregistrement');

  $('bouton-changer-camera').disabled = etat !== 'inactif';
}

export function mettreAJourChrono() {
  $('chrono').textContent = formaterDuree(dureeEnregistree());
}

/** Bouton « Enregistrer » : décompte éventuel, puis démarrage. */
export async function demanderEnregistrement() {
  if (enregistrement.etat !== 'inactif') return;
  if (!('MediaRecorder' in window)) {
    notifier('Ce navigateur ne sait pas enregistrer (fonction MediaRecorder absente).', 'erreur');
    return;
  }
  const contexte = actionsEnregistrement.obtenirContextePrompteur?.() || { mode: media.mode, script: null };
  if (!media.flux) {
    notifier(contexte.mode === 'videaste' ? 'La caméra n\'est pas disponible.' : 'Le micro n\'est pas disponible.', 'erreur');
    return;
  }
  actionsEnregistrement.onFermerPanneauRapide?.();

  if (reglages.decompte > 0) {
    enregistrement.etat = 'decompte';
    mettreAJourCommandesEnregistrement();
    const aboutiAuBout = await lancerDecompte(reglages.decompte);
    enregistrement.etat = 'inactif';
    if (!aboutiAuBout) {
      mettreAJourCommandesEnregistrement();
      return;
    }
  }
  await demarrerEnregistrement();
}

/** Affiche 3… 2… 1… Renvoie true si le décompte va au bout, false s'il est annulé. */
export function lancerDecompte(secondes) {
  return new Promise((resoudre) => {
    const zone = $('decompte');
    const chiffre = $('decompte-chiffre');
    let reste = secondes;

    const afficher = () => {
      chiffre.textContent = String(reste);
      chiffre.classList.remove('anime');
      void chiffre.offsetWidth;
      chiffre.classList.add('anime');
    };

    enregistrement.finDecompte = (aboutiAuBout) => {
      clearInterval(enregistrement.minuteurDecompte);
      enregistrement.minuteurDecompte = null;
      enregistrement.finDecompte = null;
      if (!aboutiAuBout && enregistrement.etat === 'decompte') {
        enregistrement.etat = 'inactif';
      }
      zone.hidden = true;
      resoudre(aboutiAuBout);
    };

    zone.hidden = false;
    afficher();
    enregistrement.minuteurDecompte = setInterval(() => {
      reste -= 1;
      if (reste <= 0) enregistrement.finDecompte(true);
      else afficher();
    }, 1000);
  });
}

export function annulerDecompte() {
  if (enregistrement.finDecompte) enregistrement.finDecompte(false);
}

export async function demarrerEnregistrement() {
  const flux = media.flux;
  if (!flux || ecranActuel() !== 'prompteur') {
    mettreAJourCommandesEnregistrement();
    return;
  }
  /* État « démarrage » : il couvre la courte attente de l'écriture de la
     fiche (plus bas). Sans lui, un double appui rapide sur « Enregistrer »
     lancerait DEUX enregistreurs. */
  enregistrement.etat = 'demarrage';
  mettreAJourCommandesEnregistrement();
  try {
    await preparerEtLancerEnregistreur(flux);
  } finally {
    if (enregistrement.etat === 'demarrage') {
      enregistrement.etat = 'inactif';
      if (ecranActuel() === 'prompteur') mettreAJourCommandesEnregistrement();
    }
  }
}

/** Crée le MediaRecorder, sa fiche dans la base, et démarre l'enregistrement. */
export async function preparerEtLancerEnregistreur(flux) {
  const contexte = actionsEnregistrement.obtenirContextePrompteur?.() || { mode: media.mode, script: null };
  const type = contexte.mode === 'videaste' ? 'video' : 'audio';
  const avecAudio = flux.getAudioTracks().length > 0;
  const format = choisirFormat(type, { avecAudio });

  const options = {};
  if (format) options.mimeType = format;
  if (avecAudio) options.audioBitsPerSecond = 128_000;
  if (type === 'video') options.videoBitsPerSecond = reglages.qualiteVideo === '1080' ? 6_000_000 : 3_000_000;

  let enregistreur;
  try {
    enregistreur = new MediaRecorder(flux, options);
  } catch {
    /* Repli 1 : on retire mimeType mais on conserve les débits configurés. */
    const optionsDebit = {};
    if (avecAudio) optionsDebit.audioBitsPerSecond = 128_000;
    if (type === 'video') optionsDebit.videoBitsPerSecond = options.videoBitsPerSecond;
    try {
      enregistreur = Object.keys(optionsDebit).length
        ? new MediaRecorder(flux, optionsDebit)
        : new MediaRecorder(flux);
    } catch {
      /* Repli 2 : réglages par défaut du navigateur. */
      try {
        enregistreur = new MediaRecorder(flux);
      } catch (erreur) {
        notifier('L\'enregistrement n\'a pas pu démarrer : ' + erreur.message, 'erreur');
        return;
      }
    }
  }

  const maintenant = Date.now();
  const titreScript = contexte.script?.titre || '';
  const fiche = {
    id: nouvelIdentifiant(),
    type,
    nom: `${titreScript || 'Enregistrement'} – ${formaterDate(maintenant)}`,
    mimeType: enregistreur.mimeType || format || `${type}/webm`,
    creeLe: maintenant,
    duree: 0,
    taille: 0,
    scriptTitre: titreScript,
    statut: 'en-cours' // devient 'termine' une fois le fichier assemblé
  };

  try {
    await bd.ecrire('enregistrements', fiche);
  } catch (erreur) {
    notifier('Stockage indisponible, enregistrement impossible : ' + erreur.message, 'erreur');
    return;
  }

  /* Pendant cette courte attente, l'utilisateur a pu quitter le prompteur
     ou relancer la caméra : on abandonne. */
  if (media.flux !== flux || ecranActuel() !== 'prompteur') {
    bd.supprimerEnregistrement(fiche.id).catch(console.error);
    return;
  }

  Object.assign(enregistrement, {
    enregistreur,
    fiche,
    indexMorceau: 0,
    ecritures: Promise.resolve(),
    erreurEcriture: null,
    dureeCumulee: 0,
    pauseAutomatique: false,
    ouvrirFicheALaFin: true,
    promesseArret: new Promise((resoudre) => enregistreur.addEventListener('stop', resoudre, { once: true }))
  });
  prendreVerrou(fiche.id);

  /* Chaque seconde, MediaRecorder fournit un morceau : on l'ajoute à la file
     d'écriture. Les écritures s'enchaînent dans l'ordre, sans se chevaucher. */
  enregistreur.addEventListener('dataavailable', (evenement) => {
    if (!evenement.data || evenement.data.size === 0) return;
    const morceau = { enregistrementId: fiche.id, index: enregistrement.indexMorceau, blob: evenement.data };
    enregistrement.indexMorceau += 1;
    enregistrement.ecritures = enregistrement.ecritures
      .then(() => bd.ecrire('morceaux', morceau))
      .catch((erreur) => {
        if (!enregistrement.erreurEcriture) {
          enregistrement.erreurEcriture = erreur;
          surErreurEcriture(erreur);
        }
      });
  });

  enregistreur.addEventListener('error', (evenement) => {
    console.error('MediaRecorder :', evenement.error);
    notifier('Problème pendant l\'enregistrement. Ce qui a déjà été enregistré est conservé.', 'erreur');
    arreterEnregistrement();
  });

  try {
    enregistreur.start(1000); // un morceau par seconde
  } catch (erreur) {
    libererVerrou();
    bd.supprimerEnregistrement(fiche.id).catch(console.error);
    notifier('L\'enregistrement n\'a pas pu démarrer : ' + erreur.message, 'erreur');
    return;
  }

  enregistrement.etat = 'enregistrement';
  enregistrement.debutSegment = performance.now();
  enregistrement.minuteurChrono = setInterval(mettreAJourChrono, 250);
  mettreAJourChrono();
  mettreAJourCommandesEnregistrement();
  verrouillerOrientation();
  demanderStockagePersistant();
  if (reglages.lancerAvecEnregistrement) lancerLecture();
}

/** Pause ou reprise de l'enregistrement (le texte suit le même rythme). */
export function basculerPauseEnregistrement() {
  const enregistreur = enregistrement.enregistreur;
  if (!enregistreur) return false;

  if (enregistrement.etat === 'enregistrement') {
    if (enregistreur.state !== 'recording' || typeof enregistreur.pause !== 'function') {
      if (enregistreur.state === 'inactive') arreterEnregistrement();
      return false;
    }
    try {
      enregistreur.pause();
    } catch (erreur) {
      console.warn('Pause impossible :', erreur);
      notifier('Impossible de mettre l\'enregistrement en pause sur ce navigateur.', 'erreur');
      return false;
    }
    enregistrement.dureeCumulee += performance.now() - enregistrement.debutSegment;
    enregistrement.etat = 'pause';
    mettreEnPause();
  } else if (enregistrement.etat === 'pause') {
    if (enregistreur.state !== 'paused' || typeof enregistreur.resume !== 'function') {
      if (enregistreur.state === 'inactive') arreterEnregistrement();
      return false;
    }
    try {
      enregistreur.resume();
    } catch (erreur) {
      console.warn('Reprise impossible :', erreur);
      notifier('Impossible de reprendre l\'enregistrement sur ce navigateur.', 'erreur');
      return false;
    }
    enregistrement.debutSegment = performance.now();
    enregistrement.etat = 'enregistrement';
    enregistrement.pauseAutomatique = false;
    if (reglages.lancerAvecEnregistrement) lancerLecture();
  } else {
    return false;
  }
  mettreAJourChrono();
  mettreAJourCommandesEnregistrement();
  return true;
}

/**
 * Arrête l'enregistrement, assemble le fichier et le sauvegarde.
 * Renvoie une promesse résolue quand tout est terminé (ou tout de suite s'il
 * n'y avait rien à arrêter).
 */
export function arreterEnregistrement({ ouvrirFiche = true } = {}) {
  if (!enregistrementEnCours()) {
    if (enregistrement.promesseFinalisation) {
      if (!ouvrirFiche) enregistrement.ouvrirFicheALaFin = false;
      return enregistrement.promesseFinalisation;
    }
    return Promise.resolve();
  }

  const { enregistreur, fiche } = enregistrement;
  if (enregistrement.etat === 'enregistrement') {
    enregistrement.dureeCumulee += performance.now() - enregistrement.debutSegment;
  }
  enregistrement.etat = 'finalisation';
  enregistrement.ouvrirFicheALaFin = ouvrirFiche;
  clearInterval(enregistrement.minuteurChrono);
  enregistrement.minuteurChrono = null;
  mettreEnPause();
  deverrouillerOrientation();
  mettreAJourCommandesEnregistrement();

  /* stop() est appelé tout de suite (avant tout « await ») : même si
     l'utilisateur quitte l'écran à l'instant, les dernières images sont
     bien remises à MediaRecorder. */
  let etaitDejaInactif = enregistreur.state === 'inactive';
  if (!etaitDejaInactif) {
    try {
      enregistreur.stop();
    } catch {
      /* enregistreur déjà arrêté */
      etaitDejaInactif = enregistreur.state === 'inactive';
    }
  }

  enregistrement.promesseFinalisation = (async () => {
    try {
      if (enregistrement.promesseArret) {
        if (etaitDejaInactif) {
          /* L'enregistreur était déjà inactif : si le navigateur n'a pas émis
             « stop », on borne l'attente pour ne pas bloquer indéfiniment. */
          let minuteur;
          await Promise.race([
            enregistrement.promesseArret,
            new Promise((resoudre) => { minuteur = setTimeout(resoudre, 150); })
          ]);
          clearTimeout(minuteur);
        } else {
          await enregistrement.promesseArret; // dernier morceau fourni
        }
      }
      await enregistrement.ecritures;     // tous les morceaux écrits
      const ficheFinale = await finaliserEnregistrement(fiche.id, enregistrement.dureeCumulee);
      if (ficheFinale) {
        if (enregistrement.ouvrirFicheALaFin && ecranActuel() === 'prompteur') {
          actionsEnregistrement.onTermine?.(ficheFinale);
        } else if (ecranActuel() !== 'enregistrements') {
          notifier('Enregistrement sauvegardé.', 'succes');
        }
      } else {
        notifier('L\'enregistrement était vide : rien n\'a été sauvegardé.');
      }
    } catch (erreur) {
      console.error(erreur);
      notifier('La sauvegarde a échoué (' + erreur.message + '). Une récupération sera tentée au prochain démarrage.', 'erreur');
    } finally {
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
      if (ecranActuel() === 'prompteur') mettreAJourCommandesEnregistrement();
    }
  })();
  return enregistrement.promesseFinalisation;
}

/** Écriture impossible (souvent : stockage plein) → on arrête proprement. */
export function surErreurEcriture(erreur) {
  const plein = erreur && (erreur.name === 'QuotaExceededError' || /quota/i.test(erreur.message || ''));
  notifier(
    plein
      ? 'Espace de stockage plein : l\'enregistrement a été arrêté. Supprimez d\'anciens enregistrements pour libérer de la place.'
      : 'Écriture impossible, l\'enregistrement a été arrêté : ' + erreur.message,
    'erreur'
  );
  arreterEnregistrement();
}

/**
 * Réassemble les morceaux d'un enregistrement en un seul fichier, corrige sa
 * durée si c'est un WebM, puis range le fichier et sa fiche dans la base.
 */
export async function finaliserEnregistrement(id, dureeConnue, { recupere = false } = {}) {
  const fiche = await bd.lire('enregistrements', id);
  if (!fiche) return null;
  const morceaux = await bd.lireTout('morceaux', bd.intervalleMorceaux(id));
  if (!morceaux.length) {
    await bd.supprimerEnregistrement(id);
    return null;
  }

  /* new Blob([...]) met les morceaux bout à bout, sans les recopier en mémoire. */
  const typeMime = morceaux[0].blob.type || fiche.mimeType;
  let fichier = new Blob(morceaux.map((morceau) => morceau.blob), { type: typeMime });

  const duree = dureeConnue > 0 ? Math.round(dureeConnue) : await mesurerDureeMedia(fichier, fiche.type);
  if (/webm/i.test(typeMime) && duree > 0) fichier = await corrigerDureeWebm(fichier, duree);

  const ficheFinale = {
    ...fiche,
    nom: recupere ? `${fiche.nom} (récupéré)` : fiche.nom,
    mimeType: typeMime,
    duree,
    taille: fichier.size,
    statut: 'termine'
  };
  /* Fichier et fiche écrits ensemble : jamais l'un sans l'autre. */
  await bd.ecrireEnsemble([
    { magasin: 'fichiers', objet: { id, blob: fichier } },
    { magasin: 'enregistrements', objet: ficheFinale }
  ]);
  await bd.supprimer('morceaux', bd.intervalleMorceaux(id)); // les morceaux ne servent plus
  return ficheFinale;
}

/* --- Verrou : « cet enregistrement est vivant » --- */

const PREFIXE_VERROU = 'prompteur-createurs-enregistrement-';

export function prendreVerrou(id) {
  if (!navigator.locks) return;
  let liberer;
  const tantQueEnregistrement = new Promise((resoudre) => { liberer = resoudre; });
  enregistrement.libererVerrou = liberer;
  navigator.locks.request(PREFIXE_VERROU + id, () => tantQueEnregistrement).catch(() => {});
}

export function libererVerrou() {
  if (enregistrement.libererVerrou) enregistrement.libererVerrou();
  enregistrement.libererVerrou = null;
}

export async function verrouEstTenu(id) {
  if (!navigator.locks || !navigator.locks.query) return false;
  try {
    const etat = await navigator.locks.query();
    return etat.held.some((verrou) => verrou.name === PREFIXE_VERROU + id);
  } catch {
    return false;
  }
}

/** Au démarrage : réassemble les enregistrements interrompus et fait le ménage. */
export async function recupererEnregistrementsInterrompus() {
  let fiches;
  let clesMorceaux;
  try {
    fiches = await bd.lireTout('enregistrements');
    clesMorceaux = await executerDansMagasin('morceaux', 'readonly', (magasin) => magasin.getAllKeys());
  } catch (erreur) {
    console.error(erreur);
    return;
  }

  let recuperes = 0;
  for (const fiche of fiches.filter((f) => f.statut === 'en-cours')) {
    if (await verrouEstTenu(fiche.id)) continue; // un autre onglet enregistre en ce moment
    try {
      if (await finaliserEnregistrement(fiche.id, 0, { recupere: true })) recuperes += 1;
    } catch (erreur) {
      console.error('Récupération impossible :', erreur);
    }
  }

  /* Morceaux orphelins (sans fiche en cours) : place perdue, on les supprime. */
  const enCours = new Set(fiches.filter((f) => f.statut === 'en-cours').map((f) => f.id));
  const orphelins = new Set(clesMorceaux.map((cle) => cle[0]).filter((id) => !enCours.has(id)));
  for (const id of orphelins) bd.supprimer('morceaux', bd.intervalleMorceaux(id)).catch(console.error);

  if (recuperes > 0) {
    notifier(
      recuperes > 1
        ? `${recuperes} enregistrements interrompus ont été récupérés : retrouvez-les dans « Mes enregistrements ».`
        : 'Un enregistrement interrompu a été récupéré : retrouvez-les dans « Mes enregistrements ».',
      'succes',
      9000
    );
  }
}
