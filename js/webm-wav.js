/* =========================================================================
   Omni-Prompteur — js/webm-wav.js
   -------------------------------------------------------------------------
   Mesure de durée des fichiers média, correction de l'en-tête EBML des
   WebM (ajout de Duration dans Info) et conversion audio en WAV PCM 16 bits.
   ========================================================================= */

import { attendre, borner } from './outils.js';

/**
 * Mesure la durée d'un fichier audio ou vidéo en le chargeant dans une
 * balise média invisible. Sert pour les enregistrements récupérés, dont la
 * durée n'a pas pu être chronométrée. Renvoie des millisecondes (0 si échec).
 */
export function mesurerDureeMedia(blob, type) {
  return new Promise((resoudre) => {
    const element = document.createElement(type === 'video' ? 'video' : 'audio');
    const adresse = URL.createObjectURL(blob);
    let termine = false;
    let minuteur = null;

    const terminer = (secondes) => {
      if (termine) return;
      termine = true;
      clearTimeout(minuteur);
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(adresse);
      resoudre(Number.isFinite(secondes) && secondes > 0 ? Math.round(secondes * 1000) : 0);
    };

    minuteur = setTimeout(() => terminer(element.duration), 20000);
    element.preload = 'metadata';
    element.muted = true;
    element.addEventListener('error', () => terminer(0));
    element.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(element.duration)) {
        terminer(element.duration);
        return;
      }
      /* Durée inconnue (cas des WebM de MediaRecorder) : on demande d'aller
         très loin dans le fichier ; le navigateur le parcourt jusqu'au bout
         et découvre ainsi la durée réelle. */
      element.addEventListener('durationchange', () => {
        if (Number.isFinite(element.duration)) terminer(element.duration);
      });
      element.currentTime = 1e101;
    });
    element.src = adresse;
  });
}

/* --- Correction de la durée d'un WebM --- */

const EBML = {
  ENTETE: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEKHEAD: 0x114d9b74,
  INFO: 0x1549a966,
  ECHELLE_TEMPS: 0x2ad7b1, // TimecodeScale
  DUREE: 0x4489,           // Duration
  CLUSTER: 0x1f43b675
};

/**
 * Lit un nombre EBML de longueur variable. Le nombre de zéros en tête du
 * premier octet indique la longueur totale (1 à 8 octets).
 * - Pour un identifiant, on garde tous les bits (marqueur compris).
 * - Pour une taille, on retire le bit marqueur ; si tous les bits restants
 *   valent 1, la taille est « inconnue ».
 */
export function lireNombreEbml(octets, position, estIdentifiant) {
  const premier = octets[position];
  if (premier === undefined || premier === 0) return null;
  let longueur = 1;
  let masque = 0x80;
  while (!(premier & masque)) {
    masque >>= 1;
    longueur += 1;
  }
  if (position + longueur > octets.length || (estIdentifiant && longueur > 4)) return null;

  let valeur = estIdentifiant ? premier : premier & (masque - 1);
  let tousLesBitsAUn = valeur === masque - 1;
  for (let i = 1; i < longueur; i += 1) {
    const octet = octets[position + i];
    valeur = valeur * 256 + octet;
    if (octet !== 0xff) tousLesBitsAUn = false;
  }
  return { valeur, longueur, inconnue: !estIdentifiant && tousLesBitsAUn };
}

/** Lit l'en-tête (identifiant + taille) de l'élément situé à cette position. */
export function lireElementEbml(octets, position) {
  const id = lireNombreEbml(octets, position, true);
  if (!id) return null;
  const taille = lireNombreEbml(octets, position + id.longueur, false);
  if (!taille) return null;
  const debutContenu = position + id.longueur + taille.longueur;
  return { id: id.valeur, debut: position, debutContenu, fin: debutContenu + taille.valeur, tailleInconnue: taille.inconnue };
}

/**
 * Renvoie une copie du WebM avec la bonne durée. En cas de doute sur la
 * structure, le fichier est renvoyé tel quel : mieux vaut une durée absente
 * qu'un fichier abîmé.
 */
export async function corrigerDureeWebm(blob, dureeMs) {
  try {
    /* L'en-tête ne pèse que quelques Ko : inutile de lire tout le fichier. */
    const octets = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer());

    const entete = lireElementEbml(octets, 0);
    if (!entete || entete.id !== EBML.ENTETE || entete.tailleInconnue) return blob;

    const segment = lireElementEbml(octets, entete.fin);
    /* Taille de Segment connue = fichier déjà finalisé par un logiciel : on n'y touche pas. */
    if (!segment || segment.id !== EBML.SEGMENT || !segment.tailleInconnue) return blob;

    let position = segment.debutContenu;
    while (position < octets.length) {
      const element = lireElementEbml(octets, position);
      if (!element || element.tailleInconnue) return blob;
      /* Un SeekHead contient des positions dans le fichier, que notre ajout
         décalerait. Un Cluster atteint sans Info : structure inattendue. */
      if (element.id === EBML.SEEKHEAD || element.id === EBML.CLUSTER) return blob;
      if (element.id === EBML.INFO) {
        return element.fin <= octets.length ? ajouterDureeDansInfo(blob, octets, element, dureeMs) : blob;
      }
      position = element.fin;
    }
    return blob;
  } catch (erreur) {
    console.warn('Durée WebM non corrigée :', erreur);
    return blob;
  }
}

export function ajouterDureeDansInfo(blob, octets, info, dureeMs) {
  const enfantsConserves = [];
  let echelle = 1000000; // valeur par défaut : 1 ms, exprimée en nanosecondes

  for (let position = info.debutContenu; position < info.fin;) {
    const enfant = lireElementEbml(octets, position);
    if (!enfant || enfant.tailleInconnue || enfant.fin > info.fin) return blob;

    if (enfant.id === EBML.ECHELLE_TEMPS) {
      let valeur = 0;
      for (let i = enfant.debutContenu; i < enfant.fin; i += 1) valeur = valeur * 256 + octets[i];
      if (valeur > 0) echelle = valeur;
    }
    if (enfant.id === EBML.DUREE) {
      const longueur = enfant.fin - enfant.debutContenu;
      const vue = new DataView(octets.buffer, octets.byteOffset + enfant.debutContenu, longueur);
      const existante = longueur === 8 ? vue.getFloat64(0) : longueur === 4 ? vue.getFloat32(0) : 0;
      if (existante > 0) return blob; // une durée valable existe déjà
    } else {
      enfantsConserves.push(octets.subarray(enfant.debut, enfant.fin));
    }
    position = enfant.fin;
  }

  /* Nouvel élément Duration : identifiant 44 89, taille 88 (= 8 octets),
     puis un nombre à virgule exprimé en unités de l'échelle de temps. */
  const duree = new Uint8Array(11);
  duree.set([0x44, 0x89, 0x88]);
  new DataView(duree.buffer).setFloat64(3, (dureeMs * 1000000) / echelle);

  /* Nouvel en-tête de Info : identifiant sur 4 octets, puis taille sur
     8 octets (01 suivi de 7 octets de valeur). */
  const tailleContenu = enfantsConserves.reduce((total, enfant) => total + enfant.length, 0) + duree.length;
  const enteteInfo = new Uint8Array(12);
  enteteInfo.set([0x15, 0x49, 0xa9, 0x66, 0x01]);
  let reste = tailleContenu;
  for (let i = 11; i >= 5; i -= 1) {
    enteteInfo[i] = reste % 256;
    reste = Math.floor(reste / 256);
  }

  /* Le nouveau fichier : ce qui précède Info, le nouvel Info, puis tout le
     reste du fichier d'origine (Blob.slice ne recopie rien en mémoire). */
  return new Blob(
    [octets.subarray(0, info.debut), enteteInfo, ...enfantsConserves, duree, blob.slice(info.fin)],
    { type: blob.type }
  );
}

/**
 * Convertit un enregistrement audio en WAV (PCM 16 bits), le format le plus
 * universel, accepté par tous les logiciels de montage audio. Un WAV n'est
 * pas compressé : il pèse environ dix fois plus que le WebM d'origine.
 */
export async function convertirEnWav(blob) {
  const ContexteAudio = window.AudioContext || window.webkitAudioContext;
  const contexte = new ContexteAudio();
  let audio;
  try {
    /* decodeAudioData transforme le fichier compressé en échantillons bruts. */
    audio = await contexte.decodeAudioData(await blob.arrayBuffer());
  } finally {
    contexte.close().catch(() => {});
  }

  const canaux = Math.min(audio.numberOfChannels, 2);
  const frequence = audio.sampleRate;
  const tailleDonnees = audio.length * canaux * 2; // 2 octets par échantillon

  /* En-tête WAV standard de 44 octets. */
  const entete = new DataView(new ArrayBuffer(44));
  const ecrireTexte = (position, texte) => {
    for (let i = 0; i < texte.length; i += 1) entete.setUint8(position + i, texte.charCodeAt(i));
  };
  ecrireTexte(0, 'RIFF');
  entete.setUint32(4, 36 + tailleDonnees, true);
  ecrireTexte(8, 'WAVE');
  ecrireTexte(12, 'fmt ');
  entete.setUint32(16, 16, true);                      // taille du bloc « fmt »
  entete.setUint16(20, 1, true);                       // 1 = PCM non compressé
  entete.setUint16(22, canaux, true);
  entete.setUint32(24, frequence, true);
  entete.setUint32(28, frequence * canaux * 2, true);  // octets par seconde
  entete.setUint16(32, canaux * 2, true);              // octets par « image »
  entete.setUint16(34, 16, true);                      // bits par échantillon
  ecrireTexte(36, 'data');
  entete.setUint32(40, tailleDonnees, true);

  /* Les échantillons, par paquets d'une seconde, pour ne pas créer un seul
     tableau géant. Toutes les 30 secondes d'audio, on laisse souffler
     l'interface (attendre(0)) pour qu'elle ne paraisse pas figée. */
  const donnees = Array.from({ length: canaux }, (_, canal) => audio.getChannelData(canal));
  const parties = [entete.buffer];
  for (let debut = 0, paquet = 0; debut < audio.length; debut += frequence, paquet += 1) {
    const fin = Math.min(debut + frequence, audio.length);
    const vue = new DataView(new ArrayBuffer((fin - debut) * canaux * 2));
    let position = 0;
    for (let i = debut; i < fin; i += 1) {
      for (let canal = 0; canal < canaux; canal += 1) {
        const valeur = borner(donnees[canal][i], -1, 1);
        vue.setInt16(position, valeur < 0 ? valeur * 0x8000 : valeur * 0x7fff, true);
        position += 2;
      }
    }
    parties.push(vue.buffer);
    if (paquet % 30 === 29) await attendre(0);
  }
  return new Blob(parties, { type: 'audio/wav' });
}
