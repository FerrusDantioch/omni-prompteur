/* =========================================================================
   Omni-Prompteur — js/outils.js
   -------------------------------------------------------------------------
   Petits outils généraux réutilisés dans toute l'application : accès au DOM,
   création d'éléments sécurisée, formatage, comptage de mots, nettoyage de
   texte et téléchargement de fichiers.
   ========================================================================= */

/** Raccourci : renvoie l'élément de la page qui porte cet identifiant. */
export const $ = (identifiant) => document.getElementById(identifiant);

/**
 * Crée un élément HTML.
 * Sécurité : le texte est toujours inséré avec textContent, jamais avec
 * innerHTML. Ainsi, même si un script importé contient du code HTML ou
 * JavaScript, il s'affiche comme du simple texte et ne s'exécute jamais.
 *
 * @param {string} balise    - ex. 'li', 'button'
 * @param {object} options   - { classe, texte, ...autres propriétés }
 * @param {Array}  enfants   - éléments ou textes à placer à l'intérieur
 */
export function creerElement(balise, options = {}, enfants = []) {
  const element = document.createElement(balise);
  for (const [cle, valeur] of Object.entries(options)) {
    if (cle === 'classe') element.className = valeur;
    else if (cle === 'texte') element.textContent = valeur;
    else if (cle.startsWith('data-') || cle.startsWith('aria-')) element.setAttribute(cle, valeur);
    else element[cle] = valeur;
  }
  for (const enfant of [].concat(enfants)) {
    if (enfant !== null && enfant !== undefined && enfant !== false) element.append(enfant);
  }
  return element;
}

/** Crée une icône qui pointe vers la bibliothèque d'icônes de index.html. */
export function creerIcone(nom) {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icone');
  svg.setAttribute('aria-hidden', 'true');
  const utilisation = document.createElementNS(SVG, 'use');
  utilisation.setAttribute('href', '#i-' + nom);
  svg.append(utilisation);
  return svg;
}

/** Remplace l'icône d'un bouton existant (ex. : lecture ↔ pause). */
export function changerIcone(bouton, nom) {
  const utilisation = bouton.querySelector('use');
  if (utilisation) utilisation.setAttribute('href', '#i-' + nom);
}

/** Crée un bouton avec une icône et/ou un texte, et son action au clic. */
export function creerBouton({ texte, icone, classe = 'bouton bouton-secondaire bouton-petit', titre, action }) {
  const bouton = creerElement('button', { type: 'button', classe });
  if (icone) bouton.append(creerIcone(icone));
  if (texte) bouton.append(creerElement('span', { texte }));
  if (titre) {
    bouton.title = titre;
    bouton.setAttribute('aria-label', titre);
  }
  if (action) bouton.addEventListener('click', action);
  return bouton;
}

/** Fabrique un identifiant unique (pour un script ou un enregistrement). */
export function nouvelIdentifiant() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  /* Solution de repli pour les navigateurs plus anciens. */
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Petite pause utilisable avec await : await attendre(1000) = 1 seconde. */
export const attendre = (millisecondes) => new Promise((resoudre) => setTimeout(resoudre, millisecondes));

/** Limite un nombre entre un minimum et un maximum. */
export const borner = (valeur, minimum, maximum) => Math.min(maximum, Math.max(minimum, valeur));

/** 83 500 ms → « 1:23 » ; 3 723 000 ms → « 1:02:03 ». */
export function formaterDuree(millisecondes) {
  const totalSecondes = Math.max(0, Math.round((millisecondes || 0) / 1000));
  const heures = Math.floor(totalSecondes / 3600);
  const minutes = Math.floor((totalSecondes % 3600) / 60);
  const secondes = String(totalSecondes % 60).padStart(2, '0');
  return heures > 0
    ? `${heures}:${String(minutes).padStart(2, '0')}:${secondes}`
    : `${minutes}:${secondes}`;
}

/** 1 536 000 octets → « 1,5 Mo ». */
export function formaterTaille(octets) {
  const unites = ['octets', 'Ko', 'Mo', 'Go'];
  let valeur = octets || 0;
  let rang = 0;
  while (valeur >= 1024 && rang < unites.length - 1) {
    valeur /= 1024;
    rang += 1;
  }
  const chiffres = rang === 0 ? 0 : 1;
  return `${valeur.toLocaleString('fr-FR', { maximumFractionDigits: chiffres })} ${unites[rang]}`;
}

/** Horodatage → « 10 sept. 2026 à 14:32 ». */
export function formaterDate(horodatage) {
  const date = new Date(horodatage);
  const jour = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const heure = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${jour} à ${heure}`;
}

/**
 * Une ligne de section : « # » (ou plusieurs), au moins une espace, puis le
 * titre. « #tuto » (sans espace) reste du texte ordinaire : c'est un hashtag.
 * Le drapeau m fait correspondre ^ et $ au début et à la fin de CHAQUE ligne.
 */
export const LIGNE_SECTION = /^[ \t]*#+[ \t]+(\S.*)$/;
export const LIGNES_SECTION = /^[ \t]*#+[ \t]+\S.*$/gm;

/**
 * Compte les mots réellement prononcés : les [indications] entre crochets et
 * les titres de section (# …) sont ignorés. « aujourd'hui » ou « peut-être »
 * comptent pour un seul mot.
 * \p{L} signifie « n'importe quelle lettre » (accents compris), \p{N} « chiffre ».
 */
export function compterMots(texte) {
  const sansIndications = (texte || '').replace(LIGNES_SECTION, ' ').replace(/\[[^\]]*\]/g, ' ');
  const mots = sansIndications.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return mots ? mots.length : 0;
}

/** Durée de lecture estimée, ex. « ≈ 2 min 30 s ». */
export function formaterDureeLecture(nombreDeMots, motsParMinute) {
  const secondes = Math.round((nombreDeMots / motsParMinute) * 60);
  if (secondes < 60) return `≈ ${secondes} s`;
  const minutes = Math.floor(secondes / 60);
  const reste = secondes % 60;
  return reste ? `≈ ${minutes} min ${reste} s` : `≈ ${minutes} min`;
}

/** Pour la recherche : « Été » et « ete » doivent se correspondre. */
export function normaliserPourRecherche(texte) {
  return (texte || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Transforme un nom libre en nom de fichier accepté par tous les systèmes. */
export function nettoyerNomFichier(nom, repli = 'enregistrement') {
  const propre = (nom || '')
    .replace(/[\\/:*?"<>|]/g, ' ') // caractères interdits sous Windows
    .replace(/\p{Cc}/gu, ' ') // caractères de contrôle invisibles
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '') // retire espaces et points en début et en fin
    .slice(0, 80)
    .replace(/^[\s.]+|[\s.]+$/g, ''); // idem si la troncature révèle un espace ou un point en fin
  return propre || repli;
}

/** Transforme un code couleur « #rrggbb » + une opacité en « rgba(r, g, b, a) ». */
export function couleurAvecOpacite(hexadecimal, opacite) {
  const r = parseInt(hexadecimal.slice(1, 3), 16);
  const g = parseInt(hexadecimal.slice(3, 5), 16);
  const b = parseInt(hexadecimal.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacite})`;
}

/** Luminosité perçue d'une couleur, de 0 (noir) à 1 (blanc). */
export function luminosite(hexadecimal) {
  const r = parseInt(hexadecimal.slice(1, 3), 16);
  const g = parseInt(hexadecimal.slice(3, 5), 16);
  const b = parseInt(hexadecimal.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Fins de ligne uniformes et caractères de contrôle invisibles retirés. */
export function retirerCaracteresParasites(texte) {
  return texte
    .replace(/\r\n?/g, '\n')                                        // fins de ligne Windows et anciens Mac
    .replace(/\p{Cc}/gu, (car) => (car === '\n' || car === '\t' ? car : '')); // caractères de contrôle parasites
}

/** Uniformise un texte importé : fins de ligne, caractères invisibles, lignes vides. */
export function nettoyerTexteImporte(texte) {
  return retirerCaracteresParasites(texte)
    .replace(/[ \t]+$/gm, '')                                       // espaces en fin de ligne
    .replace(/\n{3,}/g, '\n\n')                                     // au plus une ligne vide d'affilée
    .trim();
}

/** Date du jour au format « 2026-10-11 », pratique dans un nom de fichier (tri par date). */
export function dateDuJour() {
  const date = new Date();
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  const jour = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mois}-${jour}`;
}

/** « 1 script » / « 3 scripts ». */
export const nombreDeScripts = (nombre) => `${nombre} script${nombre > 1 ? 's' : ''}`;

/** Déclenche le téléchargement d'un fichier présent en mémoire. */
export function telechargerFichier(blob, nomFichier) {
  const adresse = URL.createObjectURL(blob);
  const lien = creerElement('a', { href: adresse, download: nomFichier });
  document.body.append(lien);
  lien.click();
  lien.remove();
  /* On laisse une minute au navigateur pour commencer la copie avant de libérer l'adresse. */
  setTimeout(() => URL.revokeObjectURL(adresse), 60000);
}
