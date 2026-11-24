/* =========================================================================
   Omni-Prompteur — js/editeur.js
   -------------------------------------------------------------------------
   Éditeur de script avec sauvegarde automatique, statistiques en direct,
   export .txt / .md et protection contre les courses asynchrones à la sortie.
   ========================================================================= */

import { $, nouvelIdentifiant, LIGNES_SECTION, compterMots, formaterDureeLecture } from './outils.js';
import { bd } from './bd.js';
import { reglages } from './reglages.js';
import { notifier } from './dialogues.js';
import { allerVers, revenir, revenirAccueil, attendreTransition, jetonNavigation } from './navigation.js';
import { lireIdScriptActif, definirScriptActif, utiliserScript, supprimerScript } from './scripts.js';

let jetonOuverture = 0;

export const editeur = {
  script: null,       // le script en cours de modification
  estNouveau: false,  // pas encore écrit dans la base
  modifie: false,     // des changements attendent d'être enregistrés
  minuteur: null,
  promesseSauvegarde: null,
  promesseFermeture: null,
  enFermeture: false
};

/** Ouvre l'éditeur sur un script existant (id) ou sur un nouveau (null). */
export async function ouvrirEditeur(id) {
  const jeton = ++jetonOuverture;
  const navDepart = jetonNavigation();
  const estAnnule = () => jeton !== jetonOuverture || navDepart !== jetonNavigation();
  await attendreTransition();
  if (estAnnule()) return;
  if (editeur.promesseFermeture) await editeur.promesseFermeture;
  if (estAnnule()) return;
  if (editeur.script && !editeur.enFermeture) await quitterEditeur();
  if (estAnnule()) return;

  const existant = id ? await bd.lire('scripts', id) : null;
  if (estAnnule()) return;
  const maintenant = Date.now();
  editeur.script = existant || { id: nouvelIdentifiant(), titre: '', texte: '', creeLe: maintenant, modifieLe: maintenant };
  editeur.estNouveau = !existant;
  editeur.modifie = false;

  $('champ-titre').value = editeur.script.titre;
  $('champ-texte').value = editeur.script.texte;
  $('etat-sauvegarde').textContent = existant ? 'Enregistré ✓' : '';
  $('bouton-supprimer-script').hidden = !existant;
  mettreAJourStatistiquesEditeur();

  allerVers('editeur');
  if (!existant) $('champ-titre').focus();
}

export function mettreAJourStatistiquesEditeur() {
  const texte = $('champ-texte').value;
  const mots = compterMots(texte);
  const sections = (texte.match(LIGNES_SECTION) || []).length;
  $('statistiques-texte').textContent =
    `${mots} mots · ${texte.length} caractères · `
    + (sections ? `${sections} section${sections > 1 ? 's' : ''} · ` : '')
    + `lecture ${formaterDureeLecture(mots, reglages.vitesse)} à ${reglages.vitesse} mots/min`;
}

export function surModificationEditeur() {
  if (!editeur.script || editeur.enFermeture) return;
  editeur.script.titre = $('champ-titre').value;
  editeur.script.texte = $('champ-texte').value;
  editeur.modifie = true;
  $('etat-sauvegarde').textContent = 'Modification…';
  mettreAJourStatistiquesEditeur();
  clearTimeout(editeur.minuteur);
  editeur.minuteur = setTimeout(sauvegarderEditeur, 700);
}

/** Écrit le script dans la base (si nécessaire), en sérialisant les écritures. */
export function sauvegarderEditeur() {
  clearTimeout(editeur.minuteur);
  editeur.minuteur = null;
  if (!editeur.promesseSauvegarde) {
    const script = editeur.script;
    if (!script || !editeur.modifie) return Promise.resolve();
    if (!script.titre.trim() && !script.texte.trim()) return Promise.resolve(); // rien à garder
  }

  const precedent = editeur.promesseSauvegarde || Promise.resolve();
  const promesse = precedent
    .catch(() => {})
    .then(async () => {
      const script = editeur.script;
      if (!script || !editeur.modifie) return;
      if (!script.titre.trim() && !script.texte.trim()) return;

      editeur.modifie = false;
      script.modifieLe = Date.now();
      /* On écrit une COPIE : si l'utilisateur continue de taper pendant
         l'écriture, l'objet d'origine peut changer sans risque. */
      const copie = {
        id: script.id,
        titre: script.titre.trim(),
        texte: script.texte,
        creeLe: script.creeLe,
        modifieLe: script.modifieLe
      };

      try {
        await bd.ecrire('scripts', copie);
        editeur.estNouveau = false;
        if (editeur.script === script) {
          $('bouton-supprimer-script').hidden = false;
          if (!editeur.modifie) $('etat-sauvegarde').textContent = 'Enregistré ✓';
        }
      } catch (erreur) {
        if (editeur.script === script) {
          editeur.modifie = true;
          $('etat-sauvegarde').textContent = 'Non enregistré';
        }
        notifier('Le script n\'a pas pu être enregistré : ' + erreur.message, 'erreur');
      }
    })
    .finally(() => {
      if (editeur.promesseSauvegarde === promesse) editeur.promesseSauvegarde = null;
    });
  editeur.promesseSauvegarde = promesse;
  return promesse;
}

/**
 * Appelée à l'arrivée sur l'écran de l'éditeur. Normalement, ouvrirEditeur()
 * a déjà préparé un script. Mais le bouton « page suivante » du navigateur
 * peut ramener ici après coup, sans script : retour à l'accueil.
 */
export function verifierEditeurOuvert() {
  if (!editeur.script) setTimeout(revenirAccueil, 0);
}

/** Appelée automatiquement quand on quitte l'écran de l'éditeur. */
export function quitterEditeur() {
  if (editeur.promesseFermeture) return editeur.promesseFermeture;
  const script = editeur.script;
  if (!script) return Promise.resolve();

  editeur.enFermeture = true;
  clearTimeout(editeur.minuteur);
  editeur.minuteur = null;

  let promesse;
  promesse = Promise.resolve()
    .then(async () => {
      try {
        if (!script.titre.trim() && !script.texte.trim()) {
          /* Script entièrement vidé : on attend une écriture éventuelle puis on supprime. */
          if (editeur.promesseSauvegarde) await editeur.promesseSauvegarde;
          if (!editeur.estNouveau) {
            await bd.supprimer('scripts', script.id).catch(console.error);
            if (lireIdScriptActif() === script.id) definirScriptActif(null);
          }
        } else if (editeur.modifie || editeur.promesseSauvegarde) {
          await sauvegarderEditeur();
        }
      } finally {
        if (editeur.script === script) {
          editeur.script = null;
          editeur.modifie = false;
        }
        editeur.enFermeture = false;
        if (editeur.promesseFermeture === promesse) editeur.promesseFermeture = null;
      }
    });
  editeur.promesseFermeture = promesse;
  return promesse;
}

export function initialiserEditeur({ onExporter } = {}) {
  $('champ-titre').addEventListener('input', surModificationEditeur);
  $('champ-texte').addEventListener('input', surModificationEditeur);

  $('bouton-utiliser-script').addEventListener('click', async () => {
    const script = editeur.script;
    if (!script) return;
    if (!script.texte.trim()) {
      notifier('Le texte est vide : écrivez ou collez quelque chose d\'abord.');
      return;
    }
    editeur.modifie = true; // force l'écriture, même pour un script tout juste importé
    await sauvegarderEditeur();
    utiliserScript(script.id);
  });

  $('bouton-exporter-txt').addEventListener('click', () => {
    if (editeur.script) onExporter?.(editeur.script, 'txt');
  });

  $('bouton-exporter-md').addEventListener('click', () => {
    if (editeur.script) onExporter?.(editeur.script, 'md');
  });

  $('bouton-supprimer-script').addEventListener('click', async () => {
    const script = editeur.script;
    if (!script) return;
    clearTimeout(editeur.minuteur);
    editeur.minuteur = null;
    await sauvegarderEditeur(); // le script doit exister pour être supprimé proprement
    if (await supprimerScript(script.id)) {
      editeur.script = null; // plus rien à enregistrer en quittant
      editeur.modifie = false;
      revenir();
    }
  });
}
