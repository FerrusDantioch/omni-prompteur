/* Omni-Prompteur — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* ============================================================
   Tests automatiques E2E d'Omni-Prompteur (11 sections R5.5).
   Ils ouvrent l'application dans un vrai navigateur (Playwright ou
   repli CDP sur Chromium/Brave/Edge local) avec une FAUSSE caméra et
   un FAUX micro, puis vérifient tout le parcours utilisateur et le
   durcissement du serveur local. Rien n'est envoyé sur internet.

   Lancer :  node tests/tester.js
   ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { lancer, section, verifier, nouvellePage, controlesCommuns, RACINE } = require('./outils.js');

const texte = (p, sel) => p.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
async function aller(p, sel) { await p.click(sel); await p.waitForTimeout(400); }
const camera = async (ctx) => { await ctx.grantPermissions(['camera', 'microphone']); };

const SCRIPT = '# Introduction\nBonjour à tous, aujourd’hui on parle de peut-être trois choses.\n[sourire]\n# Conclusion\nMerci et à bientôt #tuto';

/* ---------- Helpers purs Node (PDF minimal, EBML WebM, WAV) ---------- */

function creerPdfMinimal(lignes) {
  const echapper = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const cmds = ['BT', '/F1 14 Tf', '72 720 Td'];
  lignes.forEach((ligne, i) => {
    if (i > 0) cmds.push('0 -22 Td');
    cmds.push(`(${echapper(ligne)}) Tj`);
  });
  cmds.push('ET');
  const stream = cmds.join('\n');
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += o;
  }
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function lireVintId(buf, pos) {
  if (pos >= buf.length) return null;
  const b0 = buf[pos];
  if (b0 === 0) return null;
  let mask = 0x80;
  let len = 1;
  while (len <= 4 && (b0 & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

function lireVintTaille(buf, pos) {
  if (pos >= buf.length) return null;
  const b0 = buf[pos];
  if (b0 === 0) return null;
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && (b0 & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || pos + len > buf.length) return null;
  let val = b0 & (mask - 1);
  let tousUn = val === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = buf[pos + i];
    if (b !== 0xff) tousUn = false;
    val = val * 256 + b;
  }
  return { size: tousUn ? null : val, len };
}

function lireDureeEbmlWebm(buf) {
  const limite = Math.min(buf.length, 1024 * 1024);
  let pos = 0;
  let hasInfo = false;
  let hasDuration = false;
  let timecodeScale = 1000000;
  let durationRaw = 0;

  while (pos < limite) {
    const el = lireVintId(buf, pos);
    if (!el) break;
    const sz = lireVintTaille(buf, pos + el.len);
    if (!sz) break;
    const dataStart = pos + el.len + sz.len;
    const dataEnd = sz.size === null ? limite : Math.min(limite, dataStart + sz.size);

    if (el.id === 0x18538067) {
      let p = dataStart;
      while (p < dataEnd) {
        const sub = lireVintId(buf, p);
        if (!sub) break;
        const subSz = lireVintTaille(buf, p + sub.len);
        if (!subSz) break;
        const subStart = p + sub.len + subSz.len;
        const subEnd = subSz.size === null ? dataEnd : Math.min(dataEnd, subStart + subSz.size);

        if (sub.id === 0x1549a966) {
          hasInfo = true;
          let q = subStart;
          while (q < subEnd) {
            const champ = lireVintId(buf, q);
            if (!champ) break;
            const champSz = lireVintTaille(buf, q + champ.len);
            if (!champSz || champSz.size === null) break;
            const cStart = q + champ.len + champSz.len;
            const cEnd = Math.min(subEnd, cStart + champSz.size);
            if (champ.id === 0x2ad7b1 && champSz.size >= 1 && champSz.size <= 8) {
              let v = 0;
              for (let i = cStart; i < cEnd; i++) v = v * 256 + buf[i];
              if (v > 0) timecodeScale = v;
            } else if (champ.id === 0x4489 && cEnd - cStart === 8) {
              durationRaw = buf.readDoubleBE(cStart);
              hasDuration = Number.isFinite(durationRaw) && durationRaw > 0;
            } else if (champ.id === 0x4489 && cEnd - cStart === 4) {
              durationRaw = buf.readFloatBE(cStart);
              hasDuration = Number.isFinite(durationRaw) && durationRaw > 0;
            }
            q = cEnd;
          }
          break;
        }
        if (sub.id === 0x1f43b675) break; // Cluster atteint
        p = subEnd;
      }
      break;
    }
    pos = dataEnd;
  }

  return {
    hasInfo,
    hasDuration,
    durationMs: hasDuration ? (durationRaw * timecodeScale) / 1e6 : 0
  };
}

function verifierEnteteWav(buf) {
  if (buf.length <= 44) return { ok: false, raison: 'taille <= 44' };
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, raison: 'signature RIFF/WAVE absente' };
  }
  let pos = 12;
  let fmt = null;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    if (id === 'fmt ' && dataStart + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(dataStart),
        channels: buf.readUInt16LE(dataStart + 2),
        sampleRate: buf.readUInt32LE(dataStart + 4),
        bitsPerSample: buf.readUInt16LE(dataStart + 14)
      };
    } else if (id === 'data') {
      dataSize = size;
    }
    pos = dataStart + size + (size % 2);
  }
  const ok = Boolean(fmt && fmt.audioFormat === 1 && fmt.channels >= 1 && fmt.sampleRate >= 8000 && dataSize > 0);
  return { ok, fmt, dataSize };
}

function requeteHttp(port, methode, cheminBrut) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: cheminBrut }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(morceaux) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---------- Suite complète E2E (11 sections) ---------- */

lancer('Omni-Prompteur', async () => {
  await controlesCommuns({ serviceWorker: 'sw.js' });

  const { ctx, p } = await nouvellePage({ avant: camera });
  await p.waitForTimeout(800);

  await section('2. Écrire un texte', async () => {
    await aller(p, '[data-aller="bibliotheque"]');
    await aller(p, '#bouton-nouveau-script');
    await p.fill('#champ-titre', 'Ma vidéo test');
    await p.fill('#champ-texte', SCRIPT);
    await p.waitForTimeout(800);
    const stats = await texte(p, '#statistiques-texte');
    verifier(stats.startsWith('15 mots'), '15 mots : titres « # … » et [indications] non comptés', stats);
    verifier(stats.includes('2 sections'), '2 sections repérées', stats);
    await aller(p, '#bouton-utiliser-script');
    const titreActif = await texte(p, '#script-actif-titre');
    verifier(titreActif.includes('Ma vidéo test'), 'il devient le texte actif de l’accueil', titreActif);
  });

  await section('3. Le texte est enregistré', async () => {
    await p.waitForTimeout(1500);
    await p.reload();
    await p.waitForTimeout(800);
    await aller(p, '[data-aller="bibliotheque"]');
    verifier((await texte(p, '#liste-scripts')).includes('Ma vidéo test'), 'le texte est dans la bibliothèque après fermeture');
  });

  await section('4. Sauvegarde puis restauration sans rien écraser', async () => {
    const [telechargement] = await Promise.all([p.waitForEvent('download'), p.click('#bouton-sauvegarder-scripts')]);
    const chemin = await telechargement.path();
    const contenu = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    verifier(contenu.format === 'prompteur-createurs/scripts' && contenu.version === 1, 'fichier de sauvegarde au bon format', [contenu.format, contenu.version]);
    const avant = await p.$$eval('#liste-scripts > *', (l) => l.length);
    await p.setInputFiles('#champ-restauration', chemin);
    await p.waitForTimeout(1200);
    const apres = await p.$$eval('#liste-scripts > *', (l) => l.length);
    verifier(apres >= avant, 'la restauration n’efface aucun texte existant', [avant, apres]);
  });

  await section('5. Import .txt, .md et .pdf (pdf.js + cache paresseux)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-import-'));
    try {
      const fTxt = path.join(tmpDir, 'import_texte.txt');
      const fMd = path.join(tmpDir, 'import_markdown.md');
      const fPdf = path.join(tmpDir, 'import_document.pdf');
      fs.writeFileSync(fTxt, 'Bonjour depuis un fichier texte.\nDeuxième phrase.');
      fs.writeFileSync(fMd, '# Titre Markdown\nContenu Markdown importé.');
      fs.writeFileSync(fPdf, creerPdfMinimal(['Bonjour depuis un PDF valide.', 'Deuxieme ligne du script.']));

      await p.setInputFiles('#champ-import', fTxt);
      await p.waitForSelector('#ecran-editeur:not([hidden])');
      const titreTxt = await p.$eval('#champ-titre', (el) => el.value);
      const corpsTxt = await p.$eval('#champ-texte', (el) => el.value);
      verifier(titreTxt === 'import texte' && corpsTxt.includes('Bonjour depuis un fichier texte.'), 'import .txt ouvre l’éditeur avec titre et texte', [titreTxt, corpsTxt]);
      await aller(p, '#ecran-editeur [data-action="retour"]');
      await p.waitForSelector('#ecran-bibliotheque:not([hidden])');

      await p.setInputFiles('#champ-import', fMd);
      await p.waitForSelector('#ecran-editeur:not([hidden])');
      const titreMd = await p.$eval('#champ-titre', (el) => el.value);
      const corpsMd = await p.$eval('#champ-texte', (el) => el.value);
      verifier(titreMd === 'import markdown' && corpsMd.includes('# Titre Markdown'), 'import .md ouvre l’éditeur avec titre et texte', [titreMd, corpsMd]);
      await aller(p, '#ecran-editeur [data-action="retour"]');
      await p.waitForSelector('#ecran-bibliotheque:not([hidden])');

      await p.setInputFiles('#champ-import', fPdf);
      await p.waitForSelector('#ecran-editeur:not([hidden])', { timeout: 20000 });
      const titrePdf = await p.$eval('#champ-titre', (el) => el.value);
      const corpsPdf = await p.$eval('#champ-texte', (el) => el.value);
      verifier(
        titrePdf === 'import document' && corpsPdf.includes('Bonjour depuis un PDF valide.') && corpsPdf.includes('Deuxieme ligne du script.'),
        'import .pdf via pdf.js extrait le texte dans l’éditeur',
        [titrePdf, corpsPdf]
      );

      await p.waitForTimeout(500);
      const cachePdf = await p.evaluate(async () => {
        const cache = await caches.open('omni-prompteur-pdf-v1');
        const reqs = await cache.keys();
        return reqs.map((r) => r.url);
      });
      verifier(
        cachePdf.some((u) => u.includes('pdf.min.mjs')) && cachePdf.some((u) => u.includes('pdf.worker.min.mjs')),
        'cache paresseux omni-prompteur-pdf-v1 rempli au premier import PDF',
        cachePdf
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await section('6. Export individuel .txt et .md (éditeur et bibliothèque)', async () => {
    const [dlEdTxt] = await Promise.all([p.waitForEvent('download'), p.click('#bouton-exporter-txt')]);
    const nomEdTxt = dlEdTxt.suggestedFilename();
    const contenuEdTxt = fs.readFileSync(await dlEdTxt.path(), 'utf8');
    verifier(nomEdTxt.endsWith('.txt') && contenuEdTxt.includes('Bonjour depuis un PDF valide.'), 'export .txt depuis l’éditeur valide', nomEdTxt);

    const [dlEdMd] = await Promise.all([p.waitForEvent('download'), p.click('#bouton-exporter-md')]);
    const nomEdMd = dlEdMd.suggestedFilename();
    const contenuEdMd = fs.readFileSync(await dlEdMd.path(), 'utf8');
    verifier(nomEdMd.endsWith('.md') && contenuEdMd.includes('Bonjour depuis un PDF valide.'), 'export .md depuis l’éditeur valide', nomEdMd);

    await aller(p, '#ecran-editeur [data-action="retour"]');
    await p.waitForSelector('#ecran-bibliotheque:not([hidden])');

    const [dlBibTxt] = await Promise.all([
      p.waitForEvent('download'),
      p.click('#liste-scripts .element-liste button[title="Exporter en .txt"]')
    ]);
    verifier(dlBibTxt.suggestedFilename().endsWith('.txt'), 'export .txt depuis la carte bibliothèque valide', dlBibTxt.suggestedFilename());

    const [dlBibMd] = await Promise.all([
      p.waitForEvent('download'),
      p.click('#liste-scripts .element-liste button[title="Exporter en .md"]')
    ]);
    verifier(dlBibMd.suggestedFilename().endsWith('.md'), 'export .md depuis la carte bibliothèque valide', dlBibMd.suggestedFilename());
  });

  await section('7. Sélecteurs caméra/micro (deviceId) et annulation décompte par Échap', async () => {
    await aller(p, '#ecran-bibliotheque [data-action="retour"]');
    await p.waitForSelector('#ecran-accueil:not([hidden])');
    await aller(p, '[data-aller="reglages"]');
    await p.waitForSelector('#ecran-reglages:not([hidden])');

    await p.waitForFunction(() => {
      const c = document.getElementById('reglage-camera');
      const m = document.getElementById('reglage-micro');
      return Boolean(c && m && c.options.length > 1 && m.options.length > 1);
    });

    const choix = await p.evaluate(() => {
      const cams = [...document.getElementById('reglage-camera').options].filter((o) => o.value);
      const mics = [...document.getElementById('reglage-micro').options].filter((o) => o.value);
      return { camId: cams[0]?.value || '', micId: mics[0]?.value || '' };
    });
    verifier(Boolean(choix.camId && choix.micId), 'sélecteurs caméra et micro peuplés avec des deviceId non vides', choix);

    await p.selectOption('#reglage-camera', choix.camId);
    await p.selectOption('#reglage-micro', choix.micId);
    await p.selectOption('#reglage-decompte', '3');
    await p.waitForTimeout(500);

    await p.reload();
    await p.waitForTimeout(700);
    await aller(p, '[data-aller="reglages"]');
    await p.waitForFunction(
      ({ camId, micId }) => {
        const c = document.getElementById('reglage-camera');
        const m = document.getElementById('reglage-micro');
        return Boolean(c && m && c.value === camId && m.value === micId);
      },
      choix
    );
    const decomptePersiste = await p.$eval('#reglage-decompte', (el) => el.value);
    verifier(decomptePersiste === '3', 'cameraId, microId et décompte persistent après rechargement', decomptePersiste);

    await aller(p, '#ecran-reglages [data-action="retour"]');
    await p.waitForSelector('#ecran-accueil:not([hidden])');
    await aller(p, '#bouton-mode-podcast');
    await p.waitForSelector('#ecran-prompteur:not([hidden])');
    await p.waitForSelector('#bouton-enregistrer:not([disabled])', { timeout: 10000 });
    await p.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : undefined));

    await p.click('#bouton-enregistrer');
    await p.waitForSelector('#decompte:not([hidden])', { timeout: 5000 });
    await p.keyboard.press('Escape');
    await p.waitForSelector('#decompte[hidden]', { timeout: 5000 });

    const etatApresEchap = await p.evaluate(() => ({
      decompteCache: document.getElementById('decompte').hidden,
      indicCache: document.getElementById('indicateur-enregistrement').hidden,
      prompteurVisible: !document.getElementById('ecran-prompteur').hidden
    }));
    verifier(
      etatApresEchap.decompteCache && etatApresEchap.indicCache && etatApresEchap.prompteurVisible,
      'Échap annule le décompte sans lancer l’enregistrement ni quitter le prompteur',
      etatApresEchap
    );

    await aller(p, '#bouton-quitter-prompteur');
    await p.waitForSelector('#ecran-accueil:not([hidden])');
    await aller(p, '[data-aller="reglages"]');
    await p.selectOption('#reglage-decompte', '0');
    await p.waitForTimeout(450);
    await aller(p, '#ecran-reglages [data-action="retour"]');
    await p.waitForSelector('#ecran-accueil:not([hidden])');
  });

  await section('8. Prompteur, enregistrement vidéo (fausse caméra) et durée WebM', async () => {
    await aller(p, '#bouton-mode-videaste');
    await p.waitForSelector('#ecran-prompteur:not([hidden])');
    await p.waitForFunction(() => document.getElementById('video-camera').readyState >= 2, null, { timeout: 10000 });
    verifier(true, 'l’image de la caméra s’affiche');
    verifier((await texte(p, '#texte-defilant')).includes('Bonjour à tous'), 'le texte est affiché sur le prompteur');

    await p.click('#bouton-enregistrer');
    await p.waitForSelector('#indicateur-enregistrement:not([hidden])', { timeout: 15000 });
    await p.waitForTimeout(2200);
    await p.click('#bouton-arreter-enregistrement');
    await p.waitForSelector('#dialogue-media[open]', { timeout: 15000 });

    const infosMedia = await texte(p, '#media-infos');
    verifier(!infosMedia.includes('· 0:00 ·'), 'la fiche média affiche une durée non nulle', infosMedia);

    const [dlWebm] = await Promise.all([p.waitForEvent('download'), p.click('#media-telecharger')]);
    const webmBuf = fs.readFileSync(await dlWebm.path());
    const ebml = lireDureeEbmlWebm(webmBuf);
    verifier(ebml.hasDuration && ebml.durationMs > 0, 'le fichier .webm téléchargé contient une durée EBML valide (> 0 ms)', ebml);

    await p.click('#media-fermer');
    await p.waitForSelector('#dialogue-media:not([open])');
    await aller(p, '#bouton-quitter-prompteur');
    await p.waitForSelector('#ecran-accueil:not([hidden])');

    await aller(p, '[data-aller="enregistrements"]');
    await p.waitForSelector('#ecran-enregistrements:not([hidden])');
    const nbVideos = await p.$$eval('#liste-enregistrements > *', (l) => l.length);
    verifier(nbVideos === 1, 'un enregistrement vidéo est rangé dans « Mes enregistrements »', nbVideos);
    await aller(p, '#ecran-enregistrements [data-action="retour"]');
    await p.waitForSelector('#ecran-accueil:not([hidden])');
  });

  await section('9. Mode Podcast et export .wav', async () => {
    await aller(p, '#bouton-mode-podcast');
    await p.waitForSelector('#ecran-prompteur:not([hidden])');
    await p.waitForSelector('#bouton-enregistrer:not([disabled])', { timeout: 10000 });

    await p.click('#bouton-enregistrer');
    await p.waitForSelector('#indicateur-enregistrement:not([hidden])', { timeout: 15000 });
    await p.waitForTimeout(2000);
    await p.click('#bouton-arreter-enregistrement');
    await p.waitForSelector('#dialogue-media[open]', { timeout: 15000 });

    const etatFicheAudio = await p.evaluate(() => ({
      aLecteurAudio: Boolean(document.querySelector('#media-lecteur audio')),
      boutonWavVisible: !document.getElementById('media-wav').hidden
    }));
    verifier(etatFicheAudio.aLecteurAudio && etatFicheAudio.boutonWavVisible, 'fiche Podcast affiche <audio> et le bouton .wav', etatFicheAudio);

    const [dlWav] = await Promise.all([p.waitForEvent('download'), p.click('#media-wav')]);
    const nomWav = dlWav.suggestedFilename();
    const wavBuf = fs.readFileSync(await dlWav.path());
    const wavInfo = verifierEnteteWav(wavBuf);
    verifier(nomWav.endsWith('.wav') && wavInfo.ok, 'export .wav valide (RIFF/WAVE PCM, taille > 44 octets)', { nomWav, wavInfo, taille: wavBuf.length });

    await p.click('#media-fermer');
    await p.waitForSelector('#dialogue-media:not([open])');
    await aller(p, '#bouton-quitter-prompteur');
    await p.waitForSelector('#ecran-accueil:not([hidden])');

    await aller(p, '[data-aller="enregistrements"]');
    await p.click('.onglet[data-filtre="audio"]');
    await p.waitForTimeout(300);
    const nbAudios = await p.$$eval('#liste-enregistrements > *', (l) => l.length);
    verifier(nbAudios === 1, 'l’onglet Audio liste l’enregistrement Podcast', nbAudios);
  });

  await section('10. Récupération post-crash (IndexedDB en-cours + morceaux) et durée WebM', async () => {
    const seme = await p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('prompteur-createurs', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const lireTout = (magasin) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(magasin, 'readonly');
          const req = tx.objectStore(magasin).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const fiches = await lireTout('enregistrements');
      const audio = fiches.find((f) => f.type === 'audio' && f.statut === 'termine');
      if (!audio) return { ok: false, raison: 'aucun audio de référence' };

      const fichier = await new Promise((resolve, reject) => {
        const tx = db.transaction('fichiers', 'readonly');
        const req = tx.objectStore('fichiers').get(audio.id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!fichier || !fichier.blob) return { ok: false, raison: 'blob introuvable' };

      const mid = Math.floor(fichier.blob.size / 2);
      const part0 = fichier.blob.slice(0, mid, fichier.blob.type);
      const part1 = fichier.blob.slice(mid, fichier.blob.size, fichier.blob.type);

      await new Promise((resolve, reject) => {
        const tx = db.transaction(['enregistrements', 'morceaux'], 'readwrite');
        tx.objectStore('enregistrements').put({
          id: 'crash-test-1',
          type: 'audio',
          nom: 'Test crash podcast',
          mimeType: fichier.blob.type || 'audio/webm;codecs=opus',
          creeLe: Date.now() - 5000,
          duree: 0,
          taille: fichier.blob.size,
          scriptTitre: 'Ma vidéo test',
          statut: 'en-cours'
        });
        tx.objectStore('morceaux').put({ enregistrementId: 'crash-test-1', index: 0, blob: part0 });
        tx.objectStore('morceaux').put({ enregistrementId: 'crash-test-1', index: 1, blob: part1 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return { ok: true };
    });
    verifier(seme.ok, 'enregistrement en-cours et 2 morceaux injectés dans IndexedDB', seme);

    await p.reload();
    await p.waitForSelector('#zone-notifications .notification-succes', { timeout: 10000 });
    const toast = await texte(p, '#zone-notifications');
    verifier(toast.includes('récupéré'), 'notification de récupération post-crash affichée', toast);

    const resultatCrash = await p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('prompteur-createurs', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const fiche = await new Promise((resolve, reject) => {
        const tx = db.transaction('enregistrements', 'readonly');
        const req = tx.objectStore('enregistrements').get('crash-test-1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const morceauxRestants = await new Promise((resolve, reject) => {
        const tx = db.transaction('morceaux', 'readonly');
        const req = tx.objectStore('morceaux').getAllKeys(IDBKeyRange.bound(['crash-test-1', 0], ['crash-test-1', Infinity]));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const fichier = await new Promise((resolve, reject) => {
        const tx = db.transaction('fichiers', 'readonly');
        const req = tx.objectStore('fichiers').get('crash-test-1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const octets = fichier?.blob ? Array.from(new Uint8Array(await fichier.blob.arrayBuffer())) : [];
      db.close();
      return { fiche, nbMorceaux: morceauxRestants.length, octets };
    });

    verifier(
      resultatCrash.fiche
        && resultatCrash.fiche.statut === 'termine'
        && resultatCrash.fiche.nom === 'Test crash podcast (récupéré)'
        && resultatCrash.fiche.duree > 0
        && resultatCrash.nbMorceaux === 0,
      'fiche crash-test-1 finalisée (statut termine, (récupéré), duree > 0, morceaux purgés)',
      { fiche: resultatCrash.fiche, nbMorceaux: resultatCrash.nbMorceaux }
    );

    const ebmlCrash = lireDureeEbmlWebm(Buffer.from(resultatCrash.octets));
    verifier(ebmlCrash.hasDuration && ebmlCrash.durationMs > 0, 'blob WebM récupéré possède une durée EBML valide (> 0 ms)', ebmlCrash);

    await aller(p, '[data-aller="enregistrements"]');
    await p.click('.onglet[data-filtre="audio"]');
    await p.waitForTimeout(300);
    const listeAudio = await texte(p, '#liste-enregistrements');
    verifier(listeAudio.includes('Test crash podcast (récupéré)'), 'l’enregistrement récupéré apparaît dans l’onglet Audio');
  });

  await ctx.close();

  await section('11. Durcissement de serveur-local.js', async () => {
    const enfant = spawn(process.execPath, [path.join(RACINE, 'serveur-local.js')], {
      env: { ...process.env, PORT: '0', HOTE: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let sortie = '';
        const timer = setTimeout(() => reject(new Error('Délai dépassé au démarrage de serveur-local.js\n' + sortie)), 8000);
        enfant.stdout.on('data', (chunk) => {
          sortie += chunk.toString('utf8');
          const m = sortie.match(/http:\/\/localhost:(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        enfant.stderr.on('data', (chunk) => { sortie += chunk.toString('utf8'); });
        enfant.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`serveur-local.js arrêté (${code})\n${sortie}`));
        });
      });

      for (const cible of ['/.git/config', '/.claude/settings.json', '/.gitignore', '/.nojekyll', '/%2egit/HEAD']) {
        const res = await requeteHttp(port, 'GET', cible);
        verifier(res.status === 403, `GET ${cible} -> 403`, res.status);
      }

      const postRes = await requeteHttp(port, 'POST', '/index.html');
      verifier(postRes.status === 405 && postRes.headers.allow === 'GET, HEAD', 'POST /index.html -> 405 + Allow: GET, HEAD', {
        status: postRes.status,
        allow: postRes.headers.allow
      });

      const jsonRes = await requeteHttp(port, 'GET', '/manifest.json');
      verifier(
        jsonRes.status === 200 && String(jsonRes.headers['content-type']).includes('application/json'),
        'GET /manifest.json -> 200 application/json',
        { status: jsonRes.status, type: jsonRes.headers['content-type'] }
      );

      const mdRes = await requeteHttp(port, 'GET', '/README.md');
      verifier(
        mdRes.status === 200 && String(mdRes.headers['content-type']).includes('text/markdown'),
        'GET /README.md -> 200 text/markdown',
        { status: mdRes.status, type: mdRes.headers['content-type'] }
      );

      const headRes = await requeteHttp(port, 'HEAD', '/index.html');
      verifier(
        headRes.status === 200 && Number(headRes.headers['content-length']) > 0 && headRes.body.length === 0,
        'HEAD /index.html -> 200, Content-Length > 0, corps vide',
        { status: headRes.status, len: headRes.headers['content-length'], bodyLen: headRes.body.length }
      );
    } finally {
      enfant.kill();
    }
  });
}, { argsNavigateur: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
