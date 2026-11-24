/* =========================================================================
   Omni-Prompteur — js/reglages.js
   -------------------------------------------------------------------------
   Réglages d'affichage et de capture (localStorage), validation, liaison
   automatique aux champs [data-reglage] et traduction en variables CSS.
   ========================================================================= */

import { $, borner, couleurAvecOpacite, luminosite } from './outils.js';
import { notifier, demanderConfirmation } from './dialogues.js';

const CLE_REGLAGES = 'prompteur-createurs.reglages';

/** Valeurs de départ. Object.freeze empêche de les modifier par erreur. */
export const REGLAGES_PAR_DEFAUT = Object.freeze({
  vitesse: 140,              // mots par minute
  taillePolice: 44,          // pixels
  police: 'atkinson',
  gras: false,
  alignement: 'gauche',      // 'gauche' ou 'centre'
  largeurTexte: 92,          // % de la largeur de l'écran
  couleurTexte: '#ffffff',
  couleurFond: '#000000',
  opaciteFond: 55,           // %
  repereLecture: true,
  positionLecture: 30,       // % de la hauteur, depuis le haut
  miroirTexte: false,
  lancerAvecEnregistrement: true,
  decompte: 3,               // secondes
  qualiteVideo: '1080',      // '720' ou '1080'
  miroirApercu: true,
  apercuRemplir: false,
  traitementAudio: true,
  cameraId: '',
  microId: ''
});

/** Bornes des réglages numériques (protège contre des valeurs farfelues). */
export const LIMITES_REGLAGES = {
  vitesse: [40, 300],
  taillePolice: [16, 140],
  largeurTexte: [40, 100],
  opaciteFond: [0, 100],
  positionLecture: [10, 70]
};

/** Chaque police proposée, avec ses polices de secours. */
export const POLICES = {
  atkinson: '"Atkinson Hyperlegible Next", system-ui, sans-serif',
  lexend: '"Lexend", system-ui, sans-serif',
  literata: '"Literata", Georgia, "Times New Roman", serif',
  robotomono: '"Roboto Mono", ui-monospace, Consolas, monospace',
  opendyslexic: '"OpenDyslexic", system-ui, sans-serif',
  systeme: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
};

/** Combinaisons de couleurs toutes prêtes (boutons de l'écran Réglages). */
export const COMBINAISONS_COULEURS = {
  'blanc-noir': { couleurTexte: '#ffffff', couleurFond: '#000000', opaciteFond: 100 },
  'jaune-noir': { couleurTexte: '#ffe066', couleurFond: '#000000', opaciteFond: 100 },
  'noir-blanc': { couleurTexte: '#111111', couleurFond: '#ffffff', opaciteFond: 100 },
  transparent: { couleurTexte: '#ffffff', couleurFond: '#000000', opaciteFond: 0 }
};

/**
 * Objet unique des réglages, muté en place via Object.assign pour que tous
 * les modules ES qui l'importent voient toujours la valeur à jour.
 */
export const reglages = chargerReglages();
let minuteurSauvegardeReglages = null;
let surApplication = null;

/** Enregistre la fonction appelée après application des variables CSS. */
export function definirSurApplication(fn) {
  surApplication = typeof fn === 'function' ? fn : null;
}

/** Lit les réglages enregistrés, en complétant par les valeurs de départ. */
export function chargerReglages() {
  let enregistres = {};
  try {
    enregistres = JSON.parse(localStorage.getItem(CLE_REGLAGES)) || {};
  } catch {
    enregistres = {}; // données illisibles : on repart des valeurs de départ
  }
  return validerReglages({ ...REGLAGES_PAR_DEFAUT, ...enregistres });
}

/**
 * Vérifie et corrige chaque réglage : bon type (nombre, vrai/faux, texte),
 * valeur dans les bornes, choix existant. Les champs de formulaire renvoient
 * toujours du texte (« 140 ») : on le convertit ici selon le type attendu.
 */
export function validerReglages(brut) {
  const propre = {};
  for (const [cle, parDefaut] of Object.entries(REGLAGES_PAR_DEFAUT)) {
    let valeur = brut[cle];
    if (typeof parDefaut === 'number') {
      valeur = Number(valeur);
      if (!Number.isFinite(valeur)) valeur = parDefaut;
      if (LIMITES_REGLAGES[cle]) valeur = borner(valeur, ...LIMITES_REGLAGES[cle]);
    } else if (typeof parDefaut === 'boolean') {
      valeur = typeof valeur === 'boolean' ? valeur : parDefaut;
    } else {
      valeur = typeof valeur === 'string' && valeur.length <= 256 ? valeur : parDefaut;
    }
    propre[cle] = valeur;
  }
  if (!POLICES[propre.police]) propre.police = REGLAGES_PAR_DEFAUT.police;
  if (!['gauche', 'centre'].includes(propre.alignement)) propre.alignement = 'gauche';
  if (![0, 3, 5, 10].includes(propre.decompte)) propre.decompte = REGLAGES_PAR_DEFAUT.decompte;
  if (!['720', '1080'].includes(propre.qualiteVideo)) propre.qualiteVideo = REGLAGES_PAR_DEFAUT.qualiteVideo;
  for (const cle of ['couleurTexte', 'couleurFond']) {
    if (!/^#[0-9a-f]{6}$/i.test(propre[cle])) propre[cle] = REGLAGES_PAR_DEFAUT[cle];
  }
  return propre;
}

/** Modifie un ou plusieurs réglages, met l'affichage à jour et sauvegarde. */
export function modifierReglages(modifications) {
  Object.assign(reglages, validerReglages({ ...reglages, ...modifications }));
  appliquerReglages();
  synchroniserChampsReglages();
  /* On attend 300 ms sans nouveau changement avant d'écrire : pendant qu'on
     fait glisser un curseur, inutile d'écrire 60 fois par seconde. */
  clearTimeout(minuteurSauvegardeReglages);
  minuteurSauvegardeReglages = setTimeout(sauvegarderReglages, 300);
}

export function sauvegarderReglages() {
  clearTimeout(minuteurSauvegardeReglages);
  minuteurSauvegardeReglages = null;
  try {
    localStorage.setItem(CLE_REGLAGES, JSON.stringify(reglages));
  } catch (erreur) {
    console.warn('Réglages non sauvegardés :', erreur);
  }
}

/**
 * Traduit les réglages en variables CSS (voir la section 2 de styles.css).
 * Changer une variable sur <html> met à jour instantanément tous les
 * éléments qui l'utilisent : l'aperçu ET le prompteur.
 */
export function appliquerReglages() {
  const style = document.documentElement.style;
  style.setProperty('--prompteur-police', POLICES[reglages.police]);
  style.setProperty('--prompteur-taille', reglages.taillePolice + 'px');
  style.setProperty('--prompteur-graisse', reglages.gras ? '700' : '400');
  style.setProperty('--prompteur-couleur', reglages.couleurTexte);
  style.setProperty('--prompteur-fond', couleurAvecOpacite(reglages.couleurFond, reglages.opaciteFond / 100));
  style.setProperty('--prompteur-alignement', reglages.alignement === 'centre' ? 'center' : 'left');
  style.setProperty('--prompteur-largeur', reglages.largeurTexte + '%');
  style.setProperty('--position-lecture', reglages.positionLecture + '%');

  /* Ombre autour des lettres : utile si le fond est très transparent et le
     texte clair (il faut qu'il se détache de l'image de la caméra). */
  const ombre = reglages.opaciteFond < 60 && luminosite(reglages.couleurTexte) > 0.5;

  for (const zone of document.querySelectorAll('.zone-prompteur')) {
    zone.dataset.miroirTexte = reglages.miroirTexte ? 'oui' : 'non';
    zone.dataset.repere = reglages.repereLecture ? 'oui' : 'non';
    zone.dataset.ombreTexte = ombre ? 'oui' : 'non';
    zone.dataset.apercuRemplir = reglages.apercuRemplir ? 'oui' : 'non';
  }

  if (surApplication) surApplication();
}

/** Texte affiché à côté d'un curseur, ex. « 140 mots/min ». */
export function formaterValeurReglage(cle, versionCourte) {
  const valeur = reglages[cle];
  switch (cle) {
    case 'vitesse': return versionCourte ? String(valeur) : `${valeur} mots/min`;
    case 'taillePolice': return `${valeur} px`;
    default: return `${valeur} %`;
  }
}

/** Recopie les réglages actuels dans tous les champs et affichages de valeur. */
export function synchroniserChampsReglages() {
  for (const champ of document.querySelectorAll('[data-reglage]')) {
    const valeur = reglages[champ.dataset.reglage];
    if (champ.type === 'checkbox') champ.checked = Boolean(valeur);
    else if (champ.type === 'radio') champ.checked = champ.value === String(valeur);
    else champ.value = String(valeur);
  }
  for (const sortie of document.querySelectorAll('[data-valeur-reglage]')) {
    sortie.textContent = formaterValeurReglage(sortie.dataset.valeurReglage, sortie.classList.contains('valeur-vitesse'));
  }
}

/** Relie une fois pour toutes chaque champ data-reglage à son réglage. */
export function lierChampsReglages({ onReinitialiser } = {}) {
  for (const champ of document.querySelectorAll('[data-reglage]')) {
    /* Curseurs et couleurs : « input » réagit PENDANT le glissement.
       Cases, listes, boutons radio : « change » suffit. */
    const typeEvenement = champ.type === 'range' || champ.type === 'color' ? 'input' : 'change';
    champ.addEventListener(typeEvenement, () => {
      if (champ.type === 'radio' && !champ.checked) return;
      const valeur = champ.type === 'checkbox' ? champ.checked : champ.value;
      modifierReglages({ [champ.dataset.reglage]: valeur });
    });
  }

  for (const bouton of document.querySelectorAll('[data-preset]')) {
    bouton.addEventListener('click', () => modifierReglages(COMBINAISONS_COULEURS[bouton.dataset.preset]));
  }

  $('bouton-reinitialiser-reglages').addEventListener('click', async () => {
    const accord = await demanderConfirmation({
      titre: 'Rétablir les réglages ?',
      message: 'Tous les réglages d\'affichage reprendront leur valeur de départ. Vos scripts et enregistrements ne sont pas concernés.',
      bouton: 'Rétablir',
      danger: false
    });
    if (accord) {
      modifierReglages({ ...REGLAGES_PAR_DEFAUT });
      if (onReinitialiser) onReinitialiser();
      notifier('Réglages rétablis.', 'succes');
    }
  });
}
