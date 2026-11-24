/* =========================================================================
   Omni-Prompteur — js/media.js
   -------------------------------------------------------------------------
   Caméra, micro, sélection par deviceId, gestion des coupures de piste
   et vumètre Web Audio.
   ========================================================================= */

import { $, creerElement, borner } from './outils.js';
import { notifier } from './dialogues.js';
import { reglages, modifierReglages } from './reglages.js';
import { ecranActuel } from './navigation.js';

const CLE_CAMERA = 'prompteur-createurs.camera';

export const media = {
  flux: null,              // le MediaStream en cours d'utilisation
  jeton: null,             // identifie le dernier démarrage demandé
  mode: 'videaste',        // 'videaste' ou 'podcast'
  facingMode: 'user',      // caméra 'user' (avant) ou 'environment' (arrière)
  cameraAvant: true,
  contexteAudio: null,     // pour le vumètre
  source: null,
  analyseur: null,
  echantillons: null,
  niveauLisse: 0
};

/** Hooks fournis par app.js (évite une dépendance circulaire avec enregistrement.js). */
let actionsMedia = {};

export function definirActionsMedia(actions) {
  actionsMedia = actions || {};
}

/** Réglages demandés pour le micro. */
export function contraintesAudio(avecDeviceId = true) {
  const contraintes = {
    /* Rien n'est diffusé par le haut-parleur pendant l'enregistrement :
       l'annulation d'écho est inutile et peut abîmer la voix. */
    echoCancellation: false,
    noiseSuppression: reglages.traitementAudio,
    autoGainControl: reglages.traitementAudio
  };
  if (avecDeviceId && reglages.microId) {
    contraintes.deviceId = { exact: reglages.microId };
  }
  return contraintes;
}

/** Réglages demandés pour la caméra. */
export function contraintesVideo(avecDeviceId = true) {
  const haute = reglages.qualiteVideo === '1080';
  const contraintes = {
    width: { ideal: haute ? 1920 : 1280 },
    height: { ideal: haute ? 1080 : 720 },
    frameRate: { ideal: 30 }
  };
  if (avecDeviceId && reglages.cameraId) {
    /* On n'impose pas facingMode en même temps qu'un deviceId exact pour
       éviter un OverconstrainedError si l'utilisateur choisit la caméra arrière. */
    contraintes.deviceId = { exact: reglages.cameraId };
  } else {
    contraintes.facingMode = { ideal: media.facingMode };
  }
  return contraintes;
}

export function arreterPistes(flux) {
  if (!flux) return;
  for (const piste of flux.getTracks()) {
    piste.removeEventListener('ended', surFinDePiste);
    piste.stop();
  }
}

const estErreurAppareilIndisponible = (erreur) =>
  Boolean(erreur && (erreur.name === 'OverconstrainedError' || erreur.name === 'NotFoundError'));

/** Remplit les listes de sélection caméra et micro dans l'écran Réglages. */
export async function remplirSelecteursAppareils() {
  const selectCamera = $('reglage-camera');
  const selectMicro = $('reglage-micro');
  const aide = $('aide-appareils-media');
  if (!selectCamera || !selectMicro || !aide) return [];

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    aide.textContent = 'La sélection d\'appareil n\'est pas disponible dans ce navigateur (contexte sécurisé requis).';
    selectCamera.replaceChildren(creerElement('option', { value: '', texte: 'Automatique (caméra par défaut)' }));
    selectMicro.replaceChildren(creerElement('option', { value: '', texte: 'Automatique (micro par défaut)' }));
    selectCamera.value = '';
    selectMicro.value = '';
    return [];
  }

  let appareils = [];
  try {
    appareils = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }

  const cameras = appareils.filter((a) => a.kind === 'videoinput' && a.deviceId);
  const micros = appareils.filter((a) => a.kind === 'audioinput' && a.deviceId);

  const optionsCamera = [creerElement('option', { value: '', texte: 'Automatique (caméra par défaut)' })];
  cameras.forEach((cam, index) => {
    optionsCamera.push(creerElement('option', {
      value: cam.deviceId,
      texte: cam.label || `Caméra ${index + 1}`
    }));
  });
  if (cameras.length > 0 && reglages.cameraId && !cameras.some((c) => c.deviceId === reglages.cameraId)) {
    optionsCamera.push(creerElement('option', {
      value: reglages.cameraId,
      texte: 'Caméra mémorisée (déconnectée)'
    }));
  }
  selectCamera.replaceChildren(...optionsCamera);
  selectCamera.value = cameras.length > 0 ? reglages.cameraId : '';

  const optionsMicro = [creerElement('option', { value: '', texte: 'Automatique (micro par défaut)' })];
  micros.forEach((mic, index) => {
    optionsMicro.push(creerElement('option', {
      value: mic.deviceId,
      texte: mic.label || `Micro ${index + 1}`
    }));
  });
  if (micros.length > 0 && reglages.microId && !micros.some((m) => m.deviceId === reglages.microId)) {
    optionsMicro.push(creerElement('option', {
      value: reglages.microId,
      texte: 'Micro mémorisé (déconnecté)'
    }));
  }
  selectMicro.replaceChildren(...optionsMicro);
  selectMicro.value = micros.length > 0 ? reglages.microId : '';

  if (cameras.length === 0 && micros.length === 0) {
    aide.textContent = 'Les noms des appareils s\'affichent une fois l\'accès à la caméra ou au micro autorisé.';
  } else {
    aide.textContent =
      `${cameras.length} caméra${cameras.length > 1 ? 's' : ''}, `
      + `${micros.length} micro${micros.length > 1 ? 's' : ''} détecté${cameras.length + micros.length > 1 ? 's' : ''}.`;
  }
  return appareils;
}

/** Démarre (ou redémarre) la caméra et/ou le micro selon le mode. */
export async function demarrerFluxMedia(mode) {
  if (mode) media.mode = mode;
  const jeton = {};
  media.jeton = jeton;
  $('message-media').hidden = true;

  /* On libère d'abord l'appareil déjà ouvert : beaucoup de téléphones ne
     savent pas ouvrir deux caméras en même temps. */
  const ancien = media.flux;
  media.flux = null;
  arreterPistes(ancien);
  arreterAnalyseMicro();
  $('video-camera').srcObject = null;
  $('info-resolution').textContent = '';
  actionsMedia.onChangementFlux?.();

  const videaste = media.mode === 'videaste';

  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    afficherMessageMedia(
      'Caméra et micro indisponibles',
      'Le navigateur n\'autorise la caméra et le micro que sur une adresse sécurisée (https://…) ou sur http://localhost.\n\nLe texte défilant reste utilisable, mais pas l\'enregistrement.',
      { reessayer: false }
    );
    return;
  }

  let flux = null;
  let erreurRetenue = null;
  let repliCamera = false;
  let repliMicro = false;
  let sansAudio = false;

  if (videaste) {
    try {
      flux = await navigator.mediaDevices.getUserMedia({ video: contraintesVideo(true), audio: contraintesAudio(true) });
    } catch (erreur) {
      erreurRetenue = erreur;
      if (estErreurAppareilIndisponible(erreur)) {
        if (reglages.microId) {
          try {
            flux = await navigator.mediaDevices.getUserMedia({ video: contraintesVideo(true), audio: contraintesAudio(false) });
            repliMicro = true;
          } catch (e) {
            erreurRetenue = e;
          }
        }
        if (!flux && reglages.cameraId) {
          try {
            flux = await navigator.mediaDevices.getUserMedia({ video: contraintesVideo(false), audio: contraintesAudio(true) });
            repliCamera = true;
          } catch (e) {
            erreurRetenue = e;
          }
        }
        if (!flux && reglages.cameraId && reglages.microId) {
          try {
            flux = await navigator.mediaDevices.getUserMedia({ video: contraintesVideo(false), audio: contraintesAudio(false) });
            repliCamera = true;
            repliMicro = true;
          } catch (e) {
            erreurRetenue = e;
          }
        }
      }
      if (!flux) {
        /* Deuxième essai sans le micro (absent, occupé ou refusé) : on pourra
           au moins filmer. */
        try {
          flux = await navigator.mediaDevices.getUserMedia({ video: contraintesVideo(true) });
          sansAudio = true;
        } catch (erreurVideo) {
          if (estErreurAppareilIndisponible(erreurVideo) && reglages.cameraId) {
            try {
              flux = await navigator.mediaDevices.getUserMedia({ video: contraintesVideo(false) });
              repliCamera = true;
              sansAudio = true;
            } catch {
              flux = null;
            }
          }
        }
      }
    }
  } else {
    try {
      flux = await navigator.mediaDevices.getUserMedia({ audio: contraintesAudio(true) });
    } catch (erreur) {
      erreurRetenue = erreur;
      if (estErreurAppareilIndisponible(erreur) && reglages.microId) {
        try {
          flux = await navigator.mediaDevices.getUserMedia({ audio: contraintesAudio(false) });
          repliMicro = true;
        } catch (e) {
          erreurRetenue = e;
          flux = null;
        }
      }
    }
  }

  /* Pendant l'attente, l'utilisateur a pu quitter l'écran ou relancer la
     caméra : ce flux ne sert plus, on le referme aussitôt. */
  if (media.jeton !== jeton || ecranActuel() !== 'prompteur') {
    arreterPistes(flux);
    return;
  }

  if (!flux) {
    const { titre, texte } = expliquerErreurMedia(erreurRetenue, videaste);
    afficherMessageMedia(titre, texte);
    return;
  }

  if (repliCamera || repliMicro) {
    const corrections = {};
    if (repliCamera) corrections.cameraId = '';
    if (repliMicro) corrections.microId = '';
    modifierReglages(corrections);
  }

  media.flux = flux;
  const pisteVideo = flux.getVideoTracks()[0];
  const pisteAudio = flux.getAudioTracks()[0];
  $('ecran-prompteur').dataset.micro = pisteAudio ? 'oui' : 'non';

  if (pisteVideo) {
    const video = $('video-camera');
    video.srcObject = flux; // la balise <video> est « muted » : pas de larsen
    video.play().catch(() => { /* la lecture démarrera au prochain geste */ });
    /* Caméra avant ou arrière ? Une webcam d'ordinateur ne le précise pas :
       elle filme l'utilisateur, on la traite comme une caméra avant. */
    const reglagesPiste = typeof pisteVideo.getSettings === 'function' ? pisteVideo.getSettings() : {};
    media.cameraAvant = (reglagesPiste.facingMode || 'user') === 'user';
    if (reglagesPiste.facingMode === 'user' || reglagesPiste.facingMode === 'environment') {
      media.facingMode = reglagesPiste.facingMode;
      try {
        localStorage.setItem(CLE_CAMERA, media.facingMode);
      } catch {
        /* sans importance */
      }
    }
    appliquerMiroirCamera();
    pisteVideo.addEventListener('ended', surFinDePiste);
    compterCameras();
  }
  if (pisteAudio) {
    demarrerAnalyseMicro(flux);
    pisteAudio.addEventListener('ended', surFinDePiste);
  }

  const alertes = [];
  if (repliCamera && repliMicro) alertes.push('La caméra et le micro choisis sont indisponibles : appareils par défaut utilisés.');
  else if (repliCamera) alertes.push('La caméra choisie est indisponible : caméra par défaut utilisée.');
  else if (repliMicro) alertes.push('Le micro choisi est indisponible : micro par défaut utilisé.');
  if (sansAudio) alertes.push('Micro indisponible : la vidéo sera enregistrée sans le son.');
  if (alertes.length) notifier(alertes.join(' '), 'erreur');

  remplirSelecteursAppareils().catch(() => {});
  actionsMedia.onChangementFlux?.();
}

/** Traduit une erreur de getUserMedia en message compréhensible. */
export function expliquerErreurMedia(erreur, videaste) {
  const nom = erreur ? erreur.name : '';
  const appareil = videaste ? 'la caméra' : 'le micro';

  if (nom === 'NotAllowedError' || nom === 'SecurityError') {
    return {
      titre: videaste ? 'Accès à la caméra refusé' : 'Accès au micro refusé',
      texte: `L'application n'a pas l'autorisation d'utiliser ${appareil}.\n\n`
        + 'Pour l\'autoriser : dans le navigateur, touchez l\'icône située à gauche de l\'adresse, puis « Autorisations ». '
        + 'Application installée sur Android : appui long sur son icône → Infos sur l\'appli → Autorisations.\n\n'
        + 'En attendant, le texte défilant reste utilisable.'
    };
  }
  if (nom === 'NotFoundError' || nom === 'OverconstrainedError') {
    return {
      titre: videaste ? 'Aucune caméra détectée' : 'Aucun micro détecté',
      texte: videaste
        ? 'Aucune caméra utilisable n\'a été trouvée sur cet appareil. Vérifiez qu\'elle est bien branchée, puis touchez « Réessayer ».'
        : 'Aucun micro utilisable n\'a été trouvé sur cet appareil. Vérifiez qu\'il est bien branché, puis touchez « Réessayer ».'
    };
  }
  if (nom === 'NotReadableError' || nom === 'AbortError') {
    return {
      titre: videaste ? 'Caméra occupée' : 'Micro occupé',
      texte: `${videaste ? 'La caméra est' : 'Le micro est'} peut-être déjà utilisé${videaste ? 'e' : ''} par une autre application `
        + '(appel en cours, autre application de caméra…). Fermez-la, puis touchez « Réessayer ».'
    };
  }
  return {
    titre: videaste ? 'Impossible de démarrer la caméra' : 'Impossible de démarrer le micro',
    texte: `Erreur signalée par le navigateur : ${erreur ? erreur.message || nom : 'inconnue'}.`
  };
}

/** Message non bloquant par-dessus le prompteur (on peut le fermer et continuer). */
export function afficherMessageMedia(titre, texte, { reessayer = true } = {}) {
  $('bouton-changer-camera').hidden = true; // aucune caméra utilisable : rien à changer
  $('message-media-titre').textContent = titre;
  $('message-media-texte').textContent = texte;
  $('bouton-reessayer-media').hidden = !reessayer;
  $('message-media').hidden = false;
  actionsMedia.onChangementFlux?.();
}

/** Une piste s'arrête d'elle-même : appareil débranché, autorisation retirée… */
export function surFinDePiste(evenement) {
  if (ecranActuel() !== 'prompteur') return;
  const flux = media.flux;
  if (!flux) return;
  if (evenement?.target && !flux.getTracks().includes(evenement.target)) return;

  actionsMedia.onAnnulerDecompte?.();
  const enregistrementEtaitActif = Boolean(actionsMedia.estEnregistrementEnCours?.());

  /* Nettoyage synchrone pour éviter un second déclenchement si l'autre piste
     se coupe en même temps, et désactiver aussitôt le bouton Enregistrer. */
  media.flux = null;
  $('ecran-prompteur').dataset.micro = 'non';
  $('info-resolution').textContent = '';
  arreterAnalyseMicro();
  $('video-camera').srcObject = null;
  appliquerMiroirCamera();
  actionsMedia.onChangementFlux?.();

  if (enregistrementEtaitActif) {
    Promise.resolve(actionsMedia.onArreterEnregistrement?.()).finally(() => arreterPistes(flux));
  } else {
    arreterPistes(flux);
  }

  const typePiste = evenement?.target?.kind || (media.mode === 'videaste' ? 'video' : 'audio');
  const titre = typePiste === 'audio' ? 'Le micro s\'est arrêté' : 'La caméra s\'est arrêtée';
  const message = enregistrementEtaitActif
    ? 'L\'appareil a été déconnecté ou réquisitionné par une autre application. L\'enregistrement en cours a été arrêté et sauvegardé.\n\nTouchez « Réessayer » pour le relancer.'
    : 'L\'appareil a été déconnecté ou réquisitionné par une autre application. Touchez « Réessayer » pour le relancer.';
  afficherMessageMedia(titre, message);
}

/** Le bouton « changer de caméra » n'apparaît que s'il y a au moins deux caméras. */
export async function compterCameras() {
  let nombre = 0;
  try {
    const appareils = await navigator.mediaDevices.enumerateDevices();
    nombre = appareils.filter((appareil) => appareil.kind === 'videoinput').length;
  } catch {
    nombre = 0;
  }
  $('bouton-changer-camera').hidden = nombre < 2 || !media.flux || media.mode !== 'videaste';
}

export async function changerDeCamera() {
  if (actionsMedia.estEnregistrementInactif && !actionsMedia.estEnregistrementInactif()) {
    notifier('Impossible de changer de caméra pendant un enregistrement.');
    return;
  }
  let cameras = [];
  try {
    const appareils = await navigator.mediaDevices.enumerateDevices();
    cameras = appareils.filter((a) => a.kind === 'videoinput' && a.deviceId);
  } catch {
    cameras = [];
  }

  if (cameras.length >= 2) {
    const idActuel = media.flux?.getVideoTracks?.()[0]?.getSettings?.().deviceId || reglages.cameraId;
    const index = cameras.findIndex((c) => c.deviceId === idActuel);
    const suivante = cameras[(index + 1) % cameras.length];
    modifierReglages({ cameraId: suivante.deviceId });
  } else {
    if (reglages.cameraId) modifierReglages({ cameraId: '' });
    media.facingMode = media.facingMode === 'user' ? 'environment' : 'user';
    try {
      localStorage.setItem(CLE_CAMERA, media.facingMode);
    } catch {
      /* sans importance */
    }
  }
  await demarrerFluxMedia();
}

/** Effet miroir de l'aperçu, pour la caméra avant uniquement. */
export function appliquerMiroirCamera() {
  $('video-camera').classList.toggle('miroir', Boolean(media.flux && media.cameraAvant && reglages.miroirApercu));
}

/** Affiche la définition réelle de l'image filmée (ex. 1080×1920). */
export function afficherResolution() {
  const video = $('video-camera');
  $('info-resolution').textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '';
}

/* --- Vumètre : le niveau sonore du micro --- */

export function demarrerAnalyseMicro(flux) {
  try {
    const ContexteAudio = window.AudioContext || window.webkitAudioContext;
    if (!ContexteAudio) return;
    media.contexteAudio = new ContexteAudio();
    media.source = media.contexteAudio.createMediaStreamSource(flux);
    media.analyseur = media.contexteAudio.createAnalyser();
    media.analyseur.fftSize = 1024;
    media.echantillons = new Float32Array(media.analyseur.fftSize);
    media.source.connect(media.analyseur);
    media.contexteAudio.resume().catch(() => {});
  } catch (erreur) {
    console.warn('Vumètre indisponible :', erreur);
    arreterAnalyseMicro();
  }
}

export function arreterAnalyseMicro() {
  try {
    if (media.source) media.source.disconnect();
    if (media.contexteAudio) media.contexteAudio.close().catch(() => {});
  } catch {
    /* déjà fermé */
  }
  media.contexteAudio = null;
  media.source = null;
  media.analyseur = null;
  media.echantillons = null;
  media.niveauLisse = 0;
  $('niveau-micro-barre').style.setProperty('--niveau', '0');
}

/** Appelée à chaque image par la boucle de défilement. */
export function mettreAJourNiveauMicro() {
  if (!media.analyseur) return;
  media.analyseur.getFloatTimeDomainData(media.echantillons);

  /* Volume « efficace » (moyenne quadratique) des échantillons, entre 0 et 1. */
  let somme = 0;
  for (const echantillon of media.echantillons) somme += echantillon * echantillon;
  const efficace = Math.sqrt(somme / media.echantillons.length);

  /* Nos oreilles perçoivent le volume de façon logarithmique : on passe en
     décibels, de −60 dB (quasi-silence) à 0 dB (maximum). */
  const decibels = 20 * Math.log10(Math.max(efficace, 1e-6));
  const niveau = borner((decibels + 60) / 60, 0, 1);

  /* Lissage : la barre monte instantanément et redescend en douceur. */
  media.niveauLisse = niveau > media.niveauLisse ? niveau : media.niveauLisse * 0.9 + niveau * 0.1;
  $('niveau-micro-barre').style.setProperty('--niveau', media.niveauLisse.toFixed(3));
}

export function initialiserMedia() {
  try {
    media.facingMode = localStorage.getItem(CLE_CAMERA) === 'environment' ? 'environment' : 'user';
  } catch {
    /* on garde la caméra avant */
  }

  $('video-camera').addEventListener('loadedmetadata', afficherResolution);
  $('video-camera').addEventListener('resize', afficherResolution);

  const selectCamera = $('reglage-camera');
  if (selectCamera) {
    selectCamera.addEventListener('change', () => {
      modifierReglages({ cameraId: selectCamera.value });
    });
  }
  const selectMicro = $('reglage-micro');
  if (selectMicro) {
    selectMicro.addEventListener('change', () => {
      modifierReglages({ microId: selectMicro.value });
    });
  }

  if (typeof navigator.mediaDevices?.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      remplirSelecteursAppareils();
      if (ecranActuel() === 'prompteur' && media.mode === 'videaste') {
        compterCameras();
      }
    });
  }
}
