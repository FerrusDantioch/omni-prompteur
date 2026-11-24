/* =========================================================================
   Omni-Prompteur — js/bd.js
   -------------------------------------------------------------------------
   Base de données locale (IndexedDB) et stockage persistant.
   Nos quatre « magasins » (l'équivalent de tables) :
     - scripts         : { id, titre, texte, creeLe, modifieLe }
     - enregistrements : les FICHES des enregistrements (nom, durée, taille…)
     - fichiers        : { id, blob } le fichier audio/vidéo complet
     - morceaux        : les morceaux d'un enregistrement EN COURS, écrits
                         chaque seconde pour la récupération après coupure.
   ========================================================================= */

const BD_NOM = 'prompteur-createurs';
const BD_VERSION = 1;
let promesseBase = null;

/** Ouvre la base (une seule fois) et crée les magasins au tout premier lancement. */
export function ouvrirBase() {
  if (!promesseBase) {
    promesseBase = new Promise((resoudre, rejeter) => {
      if (!('indexedDB' in window)) {
        rejeter(new Error('IndexedDB indisponible dans ce navigateur.'));
        return;
      }
      const demande = indexedDB.open(BD_NOM, BD_VERSION);

      /* « upgradeneeded » ne se déclenche qu'à la création de la base ou
         quand BD_VERSION augmente : c'est le seul moment où l'on peut créer
         des magasins. */
      demande.onupgradeneeded = () => {
        const base = demande.result;
        if (!base.objectStoreNames.contains('scripts')) {
          base.createObjectStore('scripts', { keyPath: 'id' });
        }
        if (!base.objectStoreNames.contains('enregistrements')) {
          base.createObjectStore('enregistrements', { keyPath: 'id' });
        }
        if (!base.objectStoreNames.contains('fichiers')) {
          base.createObjectStore('fichiers', { keyPath: 'id' });
        }
        if (!base.objectStoreNames.contains('morceaux')) {
          /* Clé composée [identifiant, numéro] : les morceaux d'un même
             enregistrement sont automatiquement rangés dans l'ordre. */
          base.createObjectStore('morceaux', { keyPath: ['enregistrementId', 'index'] });
        }
      };
      demande.onsuccess = () => resoudre(demande.result);
      demande.onerror = () => rejeter(demande.error);
    });
  }
  return promesseBase;
}

/**
 * Exécute une opération sur un magasin et attend la FIN de la transaction
 * (« oncomplete ») : à ce moment-là seulement, les données sont réellement
 * écrites sur le disque.
 */
export async function executerDansMagasin(nomMagasin, mode, operation) {
  const base = await ouvrirBase();
  return new Promise((resoudre, rejeter) => {
    const transaction = base.transaction(nomMagasin, mode);
    const requete = operation(transaction.objectStore(nomMagasin));
    transaction.oncomplete = () => resoudre(requete ? requete.result : undefined);
    transaction.onerror = () => rejeter(transaction.error);
    transaction.onabort = () => rejeter(transaction.error || new Error('Opération annulée'));
  });
}

/** Les opérations dont l'application a besoin, avec des noms parlants. */
export const bd = {
  lire: (magasin, cle) => executerDansMagasin(magasin, 'readonly', (m) => m.get(cle)),
  lireTout: (magasin, intervalle) => executerDansMagasin(magasin, 'readonly', (m) => m.getAll(intervalle)),
  ecrire: (magasin, objet) => executerDansMagasin(magasin, 'readwrite', (m) => m.put(objet)),
  supprimer: (magasin, cleOuIntervalle) => executerDansMagasin(magasin, 'readwrite', (m) => m.delete(cleOuIntervalle)),

  /** Tous les morceaux d'un enregistrement (du numéro 0 à l'infini). */
  intervalleMorceaux: (enregistrementId) => IDBKeyRange.bound([enregistrementId, 0], [enregistrementId, Infinity]),

  /** Écrit plusieurs objets dans plusieurs magasins en une seule transaction :
      soit tout est écrit, soit rien (jamais de fiche sans son fichier). */
  async ecrireEnsemble(ecritures) {
    const base = await ouvrirBase();
    const magasins = [...new Set(ecritures.map((e) => e.magasin))];
    return new Promise((resoudre, rejeter) => {
      const transaction = base.transaction(magasins, 'readwrite');
      for (const { magasin, objet } of ecritures) transaction.objectStore(magasin).put(objet);
      transaction.oncomplete = () => resoudre();
      transaction.onerror = () => rejeter(transaction.error);
      transaction.onabort = () => rejeter(transaction.error || new Error('Opération annulée'));
    });
  },

  /** Supprime une fiche d'enregistrement, son fichier et ses morceaux éventuels. */
  async supprimerEnregistrement(id) {
    const base = await ouvrirBase();
    return new Promise((resoudre, rejeter) => {
      const transaction = base.transaction(['enregistrements', 'fichiers', 'morceaux'], 'readwrite');
      transaction.objectStore('enregistrements').delete(id);
      transaction.objectStore('fichiers').delete(id);
      transaction.objectStore('morceaux').delete(bd.intervalleMorceaux(id));
      transaction.oncomplete = () => resoudre();
      transaction.onerror = () => rejeter(transaction.error);
      transaction.onabort = () => rejeter(transaction.error || new Error('Opération annulée'));
    });
  }
};

/**
 * Demande au navigateur de protéger nos données contre le nettoyage
 * automatique lorsque l'appareil manque de place. Appelée lors d'un
 * enregistrement déclenché par l'utilisateur.
 */
export async function demanderStockagePersistant() {
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return false;
    if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) return true;
    return Boolean(await navigator.storage.persist());
  } catch {
    return false;
  }
}
