/* =========================================================================
   Omni-Prompteur — js/defilement.js
   -------------------------------------------------------------------------
   Moteur de défilement du texte : découpage en paragraphes et sections,
   mesure à l'écran, boucle requestAnimationFrame, commandes de lecture et
   gestes tactiles / souris / molette.
   ========================================================================= */

import {
  $,
  creerElement,
  changerIcone,
  creerBouton,
  borner,
  formaterDuree,
  LIGNE_SECTION,
  compterMots
} from './outils.js';
import { notifier } from './dialogues.js';
import { reglages, modifierReglages } from './reglages.js';

export const defilement = {
  enLecture: false,
  position: 0,           // nombre de pixels déjà défilés
  positionMax: 0,        // position à laquelle tout le texte a été lu
  pixelsParMot: 0,
  hauteurLigne: 60,
  nombreDeMots: 0,
  cible: null,           // position visée par un saut animé (avancer / reculer)
  dernierInstant: null,  // horodatage de l'image précédente
  idAnimation: null,
  mesuresValides: false,
  glissement: null,      // informations sur le doigt (ou la souris) qui fait glisser le texte
  sections: [],          // { titre, element, repere, bouton, position } pour chaque ligne « # … »
  dernierAffichage: { position: null, ratio: null, restant: null, section: null }
};

let hooksDefilement = {};

export function definirHooksDefilement(hooks) {
  hooksDefilement = hooks || {};
}

/**
 * Découpe le texte brut en « blocs » : des paragraphes (séparés par une ligne
 * vide) et des titres de section (lignes « # … »). Un titre coupe toujours
 * le paragraphe en cours, même sans ligne vide autour.
 * @returns {Array<{texte: string} | {section: string}>}
 */
export function decouperEnBlocs(texte) {
  const blocs = [];
  let lignes = [];
  const terminerParagraphe = () => {
    const paragraphe = lignes.join('\n').trim();
    if (paragraphe) blocs.push({ texte: paragraphe });
    lignes = [];
  };

  for (const ligne of texte.split(/\r?\n/)) {
    const section = ligne.match(LIGNE_SECTION);
    if (section) {
      terminerParagraphe();
      blocs.push({ section: section[1].trim() });
    } else if (!ligne.trim()) {
      terminerParagraphe(); // ligne vide : fin du paragraphe
    } else {
      lignes.push(ligne);
    }
  }
  terminerParagraphe();
  return blocs;
}

/** Transforme le texte brut en paragraphes et titres de section affichables. */
export function preparerTexte(texte) {
  const elements = [];
  const sections = [];
  for (const bloc of decouperEnBlocs(texte)) {
    if (bloc.section === undefined) {
      elements.push(creerParagraphePrompteur(bloc.texte));
    } else {
      const element = creerElement('p', { classe: 'section-prompteur', texte: bloc.section });
      sections.push({ titre: bloc.section, element, repere: null, bouton: null, position: 0 });
      elements.push(element);
    }
  }
  $('texte-defilant').replaceChildren(...elements);

  defilement.sections = sections;
  defilement.nombreDeMots = compterMots(texte);
  defilement.position = 0;
  defilement.positionMax = 0;
  defilement.cible = null;
  defilement.dernierAffichage = { position: null, ratio: null, restant: null, section: null };
  preparerNavigationSections();
  demanderNouvellesMesures();
}

/**
 * Prépare tout ce qui permet de passer d'une section à l'autre : un bouton
 * par section dans le panneau des réglages rapides, et un petit trait par
 * section sur la barre de progression (placé par mesurer()).
 */
export function preparerNavigationSections() {
  const sections = defilement.sections;
  $('bloc-sections').hidden = sections.length === 0;
  $('liste-sections').replaceChildren(...sections.map((section, numero) => {
    section.bouton = creerBouton({
      texte: section.titre,
      classe: 'bouton-section',
      action: () => {
        allerASection(numero);
        hooksDefilement.onFermerPanneauRapide?.(); // on referme pour voir le texte
      }
    });
    return section.bouton;
  }));

  /* Les anciens traits de la barre de progression sont retirés. */
  for (const trait of document.querySelectorAll('#progression .repere-section')) trait.remove();
  for (const section of sections) {
    section.repere = creerElement('span', { classe: 'repere-section' });
    $('progression').append(section.repere);
  }
}

/** Un paragraphe : les retours à la ligne simples deviennent des <br>, les [indications] des <span>. */
export function creerParagraphePrompteur(paragraphe) {
  const element = document.createElement('p');
  paragraphe.split('\n').forEach((ligne, numero) => {
    if (numero > 0) element.append(document.createElement('br'));
    /* Les parenthèses dans l'expression font que split() GARDE les morceaux
       entre crochets dans le résultat, au lieu de les supprimer. */
    for (const morceau of ligne.split(/(\[[^\]]*\])/)) {
      if (!morceau) continue;
      if (morceau.startsWith('[') && morceau.endsWith(']')) {
        element.append(creerElement('span', { classe: 'indication', texte: morceau }));
      } else {
        element.append(morceau);
      }
    }
  });
  return element;
}

/** Signale que les dimensions ont pu changer : on remesurera à la prochaine image. */
export function demanderNouvellesMesures() {
  defilement.mesuresValides = false;
}

/**
 * Mesure la fenêtre et le texte, puis règle les marges pour que :
 *   - au départ, la première ligne soit sur le repère de lecture ;
 *   - à la fin, la dernière ligne puisse remonter jusqu'au repère.
 * Renvoie false si l'écran n'est pas visible (rien à mesurer).
 */
export function mesurer() {
  const fenetre = $('fenetre-texte');
  const texte = $('texte-defilant');
  const hauteurFenetre = fenetre.clientHeight;
  if (!hauteurFenetre) return false;

  /* On retient où l'on en était (en proportion) pour ne pas perdre sa
     place quand on change la taille du texte ou qu'on tourne le téléphone. */
  const proportionLue = defilement.positionMax > 0 ? defilement.position / defilement.positionMax : 0;

  const hauteurRepere = Math.round(hauteurFenetre * reglages.positionLecture / 100);
  texte.style.paddingTop = hauteurRepere + 'px';
  texte.style.paddingBottom = (hauteurFenetre - hauteurRepere) + 'px';

  const hauteurDuContenu = Math.max(0, texte.offsetHeight - hauteurFenetre);
  defilement.positionMax = hauteurDuContenu;
  defilement.hauteurLigne = reglages.taillePolice * 1.4;
  defilement.pixelsParMot = defilement.nombreDeMots > 0
    ? hauteurDuContenu / defilement.nombreDeMots
    : defilement.hauteurLigne / 6;
  defilement.position = borner(proportionLue * hauteurDuContenu, 0, hauteurDuContenu);
  defilement.cible = null;

  /* Position de chaque section : celle qui amène son titre sur le repère de
     lecture. On compare au haut du texte (et non de l'écran) : le décalage
     du défilement s'annule ainsi dans la soustraction. */
  const hautDuTexte = texte.getBoundingClientRect().top;
  for (const section of defilement.sections) {
    const hautDuTitre = section.element.getBoundingClientRect().top - hautDuTexte;
    section.position = borner(hautDuTitre - hauteurRepere, 0, hauteurDuContenu);
    /* element.style est autorisé par la CSP (seul l'attribut style="…" du HTML est bloqué). */
    const pourcentage = hauteurDuContenu > 0 ? (section.position / hauteurDuContenu) * 100 : 0;
    section.repere.style.left = pourcentage + '%';
    section.repere.hidden = pourcentage <= 0; // un trait tout au début ne servirait à rien
  }

  defilement.mesuresValides = true;
  return true;
}

/** Vitesse actuelle convertie en pixels par seconde. */
export function vitesseEnPixels() {
  return (reglages.vitesse / 60) * defilement.pixelsParMot;
}

/** La boucle d'animation, appelée avant chaque nouvelle image de l'écran. */
export function boucleDefilement(instant) {
  defilement.idAnimation = requestAnimationFrame(boucleDefilement);
  hooksDefilement.onImage?.(); // le vumètre profite de la même boucle
  if (!defilement.mesuresValides && !mesurer()) return;

  /* Temps écoulé depuis l'image précédente, en secondes. On le plafonne à
     0,1 s : après une interruption (onglet en arrière-plan), le texte ne doit
     pas faire un bond. */
  const ecoule = defilement.dernierInstant === null ? 0 : Math.min((instant - defilement.dernierInstant) / 1000, 0.1);
  defilement.dernierInstant = instant;

  if (defilement.glissement) {
    /* Le doigt pilote le texte : la position est fixée par les gestes. */
  } else if (defilement.cible !== null) {
    /* Saut animé : à chaque image, on parcourt une part de la distance qui
       reste. Le mouvement ralentit en approchant, ce qui paraît naturel. */
    const part = 1 - Math.pow(0.001, ecoule);
    defilement.position += (defilement.cible - defilement.position) * part;
    if (Math.abs(defilement.cible - defilement.position) < 0.5) {
      defilement.position = defilement.cible;
      defilement.cible = null;
    }
  } else if (defilement.enLecture) {
    defilement.position += vitesseEnPixels() * ecoule;
  }

  if (defilement.position >= defilement.positionMax) {
    defilement.position = defilement.positionMax;
    if (defilement.enLecture && defilement.cible === null) {
      mettreEnPause();
      notifier('Fin du texte.');
    }
  }
  if (defilement.position < 0) defilement.position = 0;

  afficherPosition();
}

/** Applique la position au texte et met à jour la barre de progression. */
export function afficherPosition() {
  const memoire = defilement.dernierAffichage;

  /* Arrondi au pixel physique de l'écran : le texte reste net. */
  const densite = window.devicePixelRatio || 1;
  const position = Math.round(defilement.position * densite) / densite;
  if (position !== memoire.position) {
    $('texte-defilant').style.transform = `translate3d(0, ${-position}px, 0)`;
    memoire.position = position;
  }

  const ratio = defilement.positionMax > 0 ? Math.round((defilement.position / defilement.positionMax) * 1000) / 1000 : 0;
  if (ratio !== memoire.ratio) {
    $('barre-progression').style.transform = `scaleX(${ratio})`;
    memoire.ratio = ratio;
  }

  let restant = '';
  if (defilement.nombreDeMots > 0 && defilement.pixelsParMot > 0) {
    const motsRestants = (defilement.positionMax - defilement.position) / defilement.pixelsParMot;
    restant = '−' + formaterDuree((motsRestants / reglages.vitesse) * 60000);
  }
  if (restant !== memoire.restant) {
    $('temps-restant').textContent = restant;
    memoire.restant = restant;
  }

  /* Section en cours : la dernière dont le titre a atteint le repère. */
  const numero = numeroSectionEnCours(defilement.position);
  if (numero !== memoire.section) {
    const section = defilement.sections[numero];
    $('section-actuelle').textContent = section ? section.titre : '';
    defilement.sections.forEach((s, i) => s.bouton.classList.toggle('est-actuelle', i === numero));
    memoire.section = numero;
  }
}

/** Numéro de la section où se trouve cette position (-1 : avant la première). */
export function numeroSectionEnCours(position) {
  let numero = -1;
  defilement.sections.forEach((section, i) => {
    if (section.position <= position + 1) numero = i;
  });
  return numero;
}

export function demarrerBoucleDefilement() {
  if (defilement.idAnimation === null) {
    defilement.dernierInstant = null;
    defilement.idAnimation = requestAnimationFrame(boucleDefilement);
  }
}

export function arreterBoucleDefilement() {
  if (defilement.idAnimation !== null) cancelAnimationFrame(defilement.idAnimation);
  defilement.idAnimation = null;
}

/* --- Commandes de lecture --- */

export function lancerLecture() {
  if (!defilement.mesuresValides) mesurer();
  /* Arrivé à la fin, « lecture » repart du début. */
  if (defilement.positionMax > 0 && defilement.position >= defilement.positionMax - 1) defilement.position = 0;
  defilement.enLecture = true;
  mettreAJourBoutonLecture();
}

export function mettreEnPause() {
  defilement.enLecture = false;
  mettreAJourBoutonLecture();
}

export function basculerLecture() {
  if (defilement.enLecture) mettreEnPause();
  else lancerLecture();
}

export function mettreAJourBoutonLecture() {
  const bouton = $('bouton-lecture');
  changerIcone(bouton, defilement.enLecture ? 'pause' : 'lecture');
  bouton.setAttribute('aria-label', defilement.enLecture ? 'Mettre le défilement en pause' : 'Lancer le défilement');
}

/** Déplacement animé, relatif à la position (ou à la cible déjà visée). */
export function sauterDe(pixels) {
  const depart = defilement.cible !== null ? defilement.cible : defilement.position;
  defilement.cible = borner(depart + pixels, 0, defilement.positionMax);
}

export const reculer = () => sauterDe(-defilement.hauteurLigne * 3);
export const avancer = () => sauterDe(defilement.hauteurLigne * 3);

export function revenirAuDebut() {
  defilement.cible = 0;
}

/* --- Sections (lignes « # … » du script) --- */

/** Saut animé jusqu'au titre d'une section, qui vient se placer sur le repère. */
export function allerASection(numero) {
  if (!defilement.mesuresValides) mesurer();
  const section = defilement.sections[numero];
  if (section) defilement.cible = section.position;
}

/** Position de départ d'un saut : la cible déjà visée, sinon la position actuelle. */
export function positionDeReference() {
  return defilement.cible !== null ? defilement.cible : defilement.position;
}

export function signalerAbsenceDeSections() {
  notifier('Ce script n\'a pas de sections. Pour en créer, commencez une ligne par « # » suivi d\'une espace.');
}

export function allerSectionSuivante() {
  if (!defilement.sections.length) {
    signalerAbsenceDeSections();
    return;
  }
  if (!defilement.mesuresValides) mesurer();
  const depart = positionDeReference();
  const numero = defilement.sections.findIndex((section) => section.position > depart + 2);
  if (numero >= 0) allerASection(numero);
  else notifier('Vous êtes dans la dernière section.');
}

/**
 * Comme sur un lecteur de musique : si l'on est déjà avancé dans une section,
 * on revient à son début ; si l'on vient d'y arriver, on passe à la précédente.
 */
export function allerSectionPrecedente() {
  if (!defilement.sections.length) {
    signalerAbsenceDeSections();
    return;
  }
  if (!defilement.mesuresValides) mesurer();
  const limite = positionDeReference() - defilement.hauteurLigne; // une ligne de tolérance
  let numero = -1;
  defilement.sections.forEach((section, i) => {
    if (section.position < limite) numero = i;
  });
  if (numero >= 0) allerASection(numero);
  else revenirAuDebut(); // avant la première section : retour au tout début
}

export function changerVitesse(ecart) {
  modifierReglages({ vitesse: reglages.vitesse + ecart });
}

/* --- Gestes : glisser le doigt, toucher, molette --- */

export function initialiserGestesTexte() {
  const fenetre = $('fenetre-texte');

  /* Les « pointer events » réunissent souris, doigt et stylet en une seule API. */
  fenetre.addEventListener('pointerdown', (evenement) => {
    if (evenement.button !== 0) return; // uniquement le bouton principal / le doigt
    fenetre.setPointerCapture(evenement.pointerId); // on suit le doigt même s'il sort de la zone
    defilement.cible = null;
    defilement.glissement = {
      id: evenement.pointerId,
      yDepart: evenement.clientY,
      positionDepart: defilement.position,
      instantDepart: performance.now(),
      aBouge: false
    };
  });

  fenetre.addEventListener('pointermove', (evenement) => {
    const glissement = defilement.glissement;
    if (!glissement || glissement.id !== evenement.pointerId) return;
    const deplacement = evenement.clientY - glissement.yDepart;
    /* En dessous de 8 pixels, on considère que le doigt n'a pas vraiment bougé. */
    if (Math.abs(deplacement) > 8) glissement.aBouge = true;
    if (glissement.aBouge) {
      /* Doigt vers le haut = le texte monte = on avance dans le texte. */
      defilement.position = borner(glissement.positionDepart - deplacement, 0, defilement.positionMax);
      fenetre.classList.add('en-glissement');
    }
  });

  const finDuGeste = (evenement) => {
    const glissement = defilement.glissement;
    if (!glissement || glissement.id !== evenement.pointerId) return;
    defilement.glissement = null;
    fenetre.classList.remove('en-glissement');
    /* Un toucher bref, sans glisser : lecture / pause. */
    const bref = performance.now() - glissement.instantDepart < 400;
    if (evenement.type === 'pointerup' && !glissement.aBouge && bref) basculerLecture();
  };
  fenetre.addEventListener('pointerup', finDuGeste);
  fenetre.addEventListener('pointercancel', finDuGeste);

  /* Molette de la souris (ordinateur). passive: false permet d'empêcher la
     page de défiler en même temps. */
  fenetre.addEventListener('wheel', (evenement) => {
    evenement.preventDefault();
    const unite = evenement.deltaMode === 1 ? defilement.hauteurLigne : evenement.deltaMode === 2 ? fenetre.clientHeight : 1;
    defilement.cible = null;
    defilement.position = borner(defilement.position + evenement.deltaY * unite, 0, defilement.positionMax);
  }, { passive: false });

  /* Toute variation de taille (rotation, chargement d'une police, texte
     modifié) oblige à remesurer. ResizeObserver nous prévient. */
  if (typeof ResizeObserver === 'function') {
    const observateur = new ResizeObserver(demanderNouvellesMesures);
    observateur.observe(fenetre);
    observateur.observe($('texte-defilant'));
  }
  if (document.fonts) document.fonts.ready.then(demanderNouvellesMesures);
}
