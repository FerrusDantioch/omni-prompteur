/* =========================================================================
   Omni-Prompteur — js/scripts.js
   -------------------------------------------------------------------------
   Bibliothèque de scripts : chargement, création, sélection du script actif,
   affichage sur l'accueil et dans la bibliothèque, suppression et script de
   bienvenue au premier lancement.
   ========================================================================= */

import {
  $,
  creerElement,
  creerBouton,
  nouvelIdentifiant,
  compterMots,
  formaterDureeLecture,
  normaliserPourRecherche,
  formaterDate
} from './outils.js';
import { bd } from './bd.js';
import { reglages } from './reglages.js';
import { notifier, demanderConfirmation } from './dialogues.js';
import { revenirAccueil } from './navigation.js';

const CLE_SCRIPT_ACTIF = 'prompteur-createurs.script-actif';
const CLE_PREMIER_LANCEMENT = 'prompteur-createurs.premier-lancement-fait';

/** Copie de la liste des scripts, du plus récemment modifié au plus ancien. */
let scriptsEnMemoire = [];

/** Actions fournies par app.js pour éviter les dépendances circulaires. */
let actionsBibliotheque = {};

export async function chargerScripts() {
  const scripts = await bd.lireTout('scripts');
  scriptsEnMemoire = scripts.sort((a, b) => b.modifieLe - a.modifieLe);
  return scriptsEnMemoire;
}

/* Le script « sélectionné » est mémorisé par son identifiant. */
export function lireIdScriptActif() {
  try {
    return localStorage.getItem(CLE_SCRIPT_ACTIF);
  } catch {
    return null;
  }
}

export function definirScriptActif(id) {
  try {
    if (id) localStorage.setItem(CLE_SCRIPT_ACTIF, id);
    else localStorage.removeItem(CLE_SCRIPT_ACTIF);
  } catch {
    /* stockage indisponible : la sélection ne sera simplement pas retenue */
  }
}

export async function lireScriptActif() {
  const id = lireIdScriptActif();
  if (!id) return null;
  return (await bd.lire('scripts', id)) || null;
}

/** Enregistre un nouveau script et le renvoie. */
export async function creerScript({ titre = '', texte = '' } = {}) {
  const maintenant = Date.now();
  const script = { id: nouvelIdentifiant(), titre, texte, creeLe: maintenant, modifieLe: maintenant };
  await bd.ecrire('scripts', script);
  return script;
}

/** Remplit la carte « Script sélectionné » de l'accueil. */
export async function afficherAccueil() {
  let script = null;
  try {
    script = await lireScriptActif();
  } catch (erreur) {
    console.error(erreur);
  }
  $('script-actif-titre').textContent = script ? script.titre || 'Sans titre' : 'Aucun script sélectionné';
  if (script) {
    const mots = compterMots(script.texte);
    $('script-actif-details').textContent =
      `${mots} mots · ${formaterDureeLecture(mots, reglages.vitesse)} à ${reglages.vitesse} mots/min`;
  } else {
    $('script-actif-details').textContent = 'Choisissez un script dans la bibliothèque, ou créez-en un.';
  }
  $('bouton-modifier-script-actif').hidden = !script;
}

export async function afficherBibliotheque() {
  try {
    await chargerScripts();
  } catch (erreur) {
    notifier('Impossible de lire la bibliothèque : ' + erreur.message, 'erreur');
  }
  dessinerListeScripts();
}

/** (Re)construit la liste visible, en tenant compte de la recherche. */
export function dessinerListeScripts() {
  const recherche = normaliserPourRecherche($('recherche-scripts').value.trim());
  const idActif = lireIdScriptActif();
  const scripts = recherche
    ? scriptsEnMemoire.filter((s) => normaliserPourRecherche(`${s.titre} ${s.texte}`).includes(recherche))
    : scriptsEnMemoire;

  $('liste-scripts').replaceChildren(...scripts.map((s) => creerElementScript(s, s.id === idActif)));

  const messageVide = $('bibliotheque-vide');
  messageVide.hidden = scripts.length > 0;
  messageVide.textContent = scriptsEnMemoire.length === 0
    ? 'Aucun script pour l\'instant. Créez-en un ou importez un fichier texte, Markdown ou PDF.'
    : 'Aucun script ne correspond à cette recherche.';
}

/** Fabrique la « carte » d'un script dans la liste. */
export function creerElementScript(script, estActif) {
  const mots = compterMots(script.texte);
  const extrait = script.texte.replace(/\s+/g, ' ').trim().slice(0, 180);

  return creerElement('li', { classe: 'element-liste' + (estActif ? ' est-actif' : '') }, [
    creerElement('h2', { classe: 'element-titre' }, [
      script.titre || 'Sans titre',
      estActif ? creerElement('span', { classe: 'badge', texte: 'Sélectionné' }) : null
    ]),
    extrait ? creerElement('p', { classe: 'element-extrait', texte: extrait }) : null,
    creerElement('p', {
      classe: 'element-meta',
      texte: `${mots} mots · ${formaterDureeLecture(mots, reglages.vitesse)} · modifié le ${formaterDate(script.modifieLe)}`
    }),
    creerElement('div', { classe: 'element-actions' }, [
      creerBouton({
        texte: 'Utiliser',
        icone: 'coche',
        classe: 'bouton bouton-primaire bouton-petit',
        action: () => utiliserScript(script.id)
      }),
      creerBouton({
        texte: 'Modifier',
        icone: 'crayon',
        action: () => actionsBibliotheque.surOuvrirEditeur?.(script.id)
      }),
      creerBouton({
        texte: 'Exporter .txt',
        icone: 'telecharger',
        titre: 'Exporter en .txt',
        action: () => actionsBibliotheque.surExporterScript?.(script, 'txt')
      }),
      creerBouton({
        texte: 'Exporter .md',
        icone: 'telecharger',
        titre: 'Exporter en .md',
        action: () => actionsBibliotheque.surExporterScript?.(script, 'md')
      }),
      creerBouton({
        texte: 'Supprimer',
        icone: 'corbeille',
        classe: 'bouton bouton-danger bouton-petit',
        action: async () => {
          if (await supprimerScript(script.id)) afficherBibliotheque();
        }
      })
    ])
  ]);
}

/** Sélectionne un script pour la lecture et revient à l'accueil. */
export async function utiliserScript(id) {
  const script = await bd.lire('scripts', id);
  if (!script) return;
  definirScriptActif(id);
  notifier(`« ${script.titre || 'Sans titre'} » est prêt à être lu.`, 'succes');
  revenirAccueil();
}

/** Supprime un script après confirmation. Renvoie true si c'est fait. */
export async function supprimerScript(id) {
  const script = await bd.lire('scripts', id);
  if (!script) return false;
  const accord = await demanderConfirmation({
    titre: 'Supprimer ce script ?',
    message: `« ${script.titre || 'Sans titre'} » sera définitivement effacé de cet appareil.`,
    bouton: 'Supprimer'
  });
  if (!accord) return false;
  await bd.supprimer('scripts', id);
  if (lireIdScriptActif() === id) definirScriptActif(null);
  notifier('Script supprimé.');
  return true;
}

export function initialiserBibliotheque(actions = {}) {
  actionsBibliotheque = actions;
  $('bouton-nouveau-script').addEventListener('click', () => actionsBibliotheque.surOuvrirEditeur?.(null));
  $('recherche-scripts').addEventListener('input', dessinerListeScripts);
  $('champ-import').addEventListener('change', (evenement) => actionsBibliotheque.surImporter?.(evenement));
  $('bouton-sauvegarder-scripts').addEventListener('click', () => actionsBibliotheque.surSauvegarder?.());
  $('champ-restauration').addEventListener('change', (evenement) => actionsBibliotheque.surRestaurer?.(evenement));
  $('bouton-modifier-script-actif').addEventListener('click', () => {
    const id = lireIdScriptActif();
    if (id) actionsBibliotheque.surOuvrirEditeur?.(id);
  });
  $('bouton-mode-videaste').addEventListener('click', () => actionsBibliotheque.surLancerMode?.('videaste'));
  $('bouton-mode-podcast').addEventListener('click', () => actionsBibliotheque.surLancerMode?.('podcast'));
}

/**
 * Au tout premier lancement, on crée un script d'exemple qui explique
 * l'application. S'il est supprimé ensuite, il ne revient pas.
 */
export async function creerScriptDeBienvenue() {
  try {
    if (localStorage.getItem(CLE_PREMIER_LANCEMENT)) return;
    localStorage.setItem(CLE_PREMIER_LANCEMENT, 'oui');
  } catch {
    return;
  }
  const script = await creerScript({
    titre: 'Bienvenue dans Omni-Prompteur',
    texte: [
      '# Les bases',
      'Bonjour et bienvenue ! Ce texte d\'exemple défile pour vous montrer comment fonctionne le prompteur.',
      'Touchez le texte pour mettre en pause, puis touchez-le de nouveau pour reprendre. Vous pouvez aussi le faire glisser du doigt pour avancer ou revenir en arrière.',
      '[Petite pause] Les passages entre crochets comme celui-ci sont des indications : ils s\'affichent en plus petit et ne sont pas comptés dans la durée de lecture.',
      'Les boutons + et − règlent la vitesse en direct, en mots par minute. Le petit triangle orange marque la ligne à lire : placez-le près du haut de l\'écran, proche de l\'objectif, pour que votre regard reste naturel.',
      '# Pendant le tournage',
      'Les titres comme celui ci-dessus découpent le texte en sections : une ligne qui commence par un dièse suivi d\'une espace. Le bouton des réglages rapides, en haut à droite, permet de sauter directement à l\'une d\'elles.',
      'En mode Vidéaste, le bouton en forme d\'œil masque le texte pendant que vous réglez votre cadrage. Et rassurez-vous : le texte n\'apparaît jamais dans la vidéo enregistrée.',
      '# Pour commencer',
      'Pour commencer, créez votre propre script ou importez un fichier texte, Markdown ou PDF depuis la bibliothèque. Bon tournage !'
    ].join('\n\n')
  });
  definirScriptActif(script.id);
}
