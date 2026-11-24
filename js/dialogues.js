/* =========================================================================
   Omni-Prompteur — js/dialogues.js
   -------------------------------------------------------------------------
   Notifications temporaires et boîtes de dialogue <dialog>.
   ========================================================================= */

import { $, creerElement } from './outils.js';

/**
 * Affiche un petit message temporaire en bas de l'écran.
 * @param {string} message
 * @param {'info'|'succes'|'erreur'} type
 */
export function notifier(message, type = 'info', duree = 4000) {
  const zone = $('zone-notifications');
  const element = creerElement('div', { classe: `notification notification-${type}`, texte: message });
  zone.append(element);
  /* Jamais plus de trois messages empilés. */
  while (zone.children.length > 3) zone.firstElementChild.remove();
  setTimeout(() => {
    element.classList.add('disparait');
    setTimeout(() => element.remove(), 300);
  }, type === 'erreur' ? Math.max(duree, 7000) : duree);
}

/**
 * Ouvre une boîte <dialog> et renvoie une promesse résolue à sa fermeture,
 * avec la valeur du bouton utilisé (« ok », « annuler »…).
 * Le mot-clé await permet ensuite d'écrire : const choix = await ouvrirDialogue(…)
 */
export function ouvrirDialogue(dialogue) {
  return new Promise((resoudre) => {
    dialogue.returnValue = '';
    dialogue.addEventListener('close', () => resoudre(dialogue.returnValue), { once: true });
    dialogue.showModal();
  });
}

/** Demande une confirmation (« Supprimer ce script ? »). Renvoie true ou false. */
export async function demanderConfirmation({ titre, message, bouton = 'Confirmer', danger = true }) {
  $('confirmation-titre').textContent = titre;
  $('confirmation-message').textContent = message;
  const boutonOk = $('confirmation-ok');
  boutonOk.textContent = bouton;
  boutonOk.className = danger ? 'bouton bouton-danger' : 'bouton bouton-primaire';
  return (await ouvrirDialogue($('dialogue-confirmation'))) === 'ok';
}

/** Demande un texte (ex. : nouveau nom). Renvoie le texte, ou null si annulé. */
export async function demanderTexte({ titre, etiquette, valeur = '' }) {
  $('saisie-titre').textContent = titre;
  $('saisie-etiquette').textContent = etiquette;
  const champ = $('saisie-champ');
  champ.value = valeur;
  const promesse = ouvrirDialogue($('dialogue-saisie'));
  champ.select();
  return (await promesse) === 'ok' ? champ.value.trim() : null;
}
