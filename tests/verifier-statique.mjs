/* Omni-Prompteur — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* =========================================================================
   Contrôles statiques sans dépendance externe :
   - hygiène du dépôt & licences (.nojekyll, LICENSE, OFL, .gitignore) ;
   - CSP stricte dans index.html et absence de code/style en ligne ;
   - zéro ressource externe chargée (HTML, CSS, JS) ;
   - vérification réciproque HTML / CSS / manifest.json / js/*.js <-> sw.js <-> disque ;
   - isolation du Service Worker sur ferrusdantioch.github.io (statique + sandbox node:vm) ;
   - cohérence de version SW entre sw.js, README.md et CLAUDE.md ;
   - graphe acyclique des modules ES (zéro cycle, zéro orphelin) ;
   - syntaxe JavaScript / ESM valide (node --check sur tous les .js / .mjs).

   Exécution :  node tests/verifier-statique.mjs
           ou :  node --test tests/verifier-statique.mjs
   ========================================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cheminAbsolu(rel) {
  return path.join(RACINE, ...rel.split('/'));
}

function lire(rel) {
  return fs.readFileSync(cheminAbsolu(rel), 'utf8');
}

function existeFichier(rel) {
  const p = cheminAbsolu(rel);
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

function sansCommentairesHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function sansCommentairesCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Retire les commentaires // et /* ... * / d'un code JS tout en préservant
 * les littéraux de chaînes ('...', "...", `...`) et les expressions régulières.
 */
function sansCommentairesJs(js) {
  let out = '';
  let i = 0;
  const n = js.length;
  let dernierSignificatif = '';

  const estDebutRegex = () => {
    if (!dernierSignificatif) return true;
    return '([{=,:;!&|?+-*%~^<>'.includes(dernierSignificatif) || /\b(?:return|throw|case|in|of|typeof|void|delete|await|yield|else|do)$/.test(out.slice(-12));
  };

  while (i < n) {
    const ch = js[i];
    const next = js[i + 1];

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = js[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) out += js[i++];
          continue;
        }
        i++;
        if (c === quote) break;
      }
      dernierSignificatif = quote;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && js[i] !== '\n' && js[i] !== '\r') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(js[i] === '*' && js[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === '/' && estDebutRegex()) {
      out += ch;
      i++;
      let enClasse = false;
      while (i < n) {
        const c = js[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) out += js[i++];
          continue;
        }
        if (c === '[') enClasse = true;
        else if (c === ']' && enClasse) enClasse = false;
        else if (c === '/' && !enClasse) {
          i++;
          break;
        }
        if (c === '\n' || c === '\r') {
          i++;
          break;
        }
        i++;
      }
      dernierSignificatif = '/';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) dernierSignificatif = ch;
    i++;
  }
  return out;
}

function normaliserChemin(ref, baseDir = '.') {
  const propre = ref.split('?')[0].split('#')[0].trim();
  const base = baseDir === '.' ? '' : baseDir.replace(/^\.\//, '').replace(/\/$/, '') + '/';
  let norm = path.posix.normalize(base + propre);
  if (norm === '.' || norm === './' || norm === '') return 'index.html';
  return norm.replace(/^\.\//, '');
}

function listerFichiersJsMjs(dir = RACINE) {
  const resultats = [];
  for (const entree of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entree.name === '.git' || entree.name === 'node_modules') continue;
    const plein = path.join(dir, entree.name);
    if (entree.isDirectory()) {
      resultats.push(...listerFichiersJsMjs(plein));
    } else if (entree.isFile() && /\.(js|mjs)$/i.test(entree.name)) {
      resultats.push(plein);
    }
  }
  return resultats.sort();
}

function listerModulesJs() {
  const dirJs = cheminAbsolu('js');
  return fs
    .readdirSync(dirJs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => `js/${e.name}`)
    .sort();
}

function extraireConfigSw() {
  const code = lire('sw.js');
  const contexte = {
    self: {
      registration: { scope: 'https://ferrusdantioch.github.io/omni-prompteur/' },
      addEventListener: () => {},
      skipWaiting: () => {},
      clients: { claim: async () => {} }
    },
    URL,
    Request: class Request {
      constructor(url, init) {
        this.url = url;
        this.init = init;
      }
    },
    caches: {},
    fetch: async () => ({})
  };
  vm.runInNewContext(
    `${code}\n;globalThis.__SW_CFG__ = { VERSION, PREFIXE_CACHE, ANCIEN_PREFIXE_CACHE, FICHIERS, CACHE_PDF, FICHIERS_PDF };`,
    contexte
  );
  return contexte.__SW_CFG__;
}

function parserCsp(html) {
  const match = html.match(/<meta\s+http-equiv=(["'])Content-Security-Policy\1[^>]*content=(["'])([\s\S]*?)\2/i);
  assert.ok(match, 'Balise <meta http-equiv="Content-Security-Policy"> absente de index.html');
  const directives = new Map();
  for (const morceau of match[3].split(';')) {
    const propre = morceau.trim();
    if (!propre) continue;
    const tokens = propre.split(/\s+/);
    const nom = tokens[0].toLowerCase();
    assert.ok(!directives.has(nom), `Directive CSP dupliquée : ${nom}`);
    directives.set(nom, tokens.slice(1));
  }
  return directives;
}

function extraireImportsStatiques(rel) {
  const code = sansCommentairesJs(lire(rel));
  const baseDir = path.posix.dirname(rel);
  const imports = [];
  const regexImport = /(?:^|[\n;])\s*import\s+(?:['"]([^'"]+)['"]|[^'";()]*?\s+from\s+['"]([^'"]+)['"])/g;
  for (const m of code.matchAll(regexImport)) {
    imports.push(normaliserChemin(m[1] || m[2], baseDir));
  }
  const regexExport = /(?:^|[\n;])\s*export\s+(?:\*(?:\s+as\s+[$\w]+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(regexExport)) {
    imports.push(normaliserChemin(m[1], baseDir));
  }
  return imports;
}

function extraireImportsDynamiquesLocaux(rel) {
  const code = sansCommentairesJs(lire(rel));
  const baseDir = path.posix.dirname(rel);
  const cibles = [];
  for (const m of code.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    cibles.push(normaliserChemin(m[1], baseDir));
  }
  for (const m of code.matchAll(/new\s+URL\s*\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    cibles.push(normaliserChemin(m[1], baseDir));
  }
  return cibles;
}

function lireEntetePng(rel) {
  const buf = fs.readFileSync(cheminAbsolu(rel));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.length > 33 && buf.subarray(0, 8).equals(sig), `${rel} n'est pas un PNG valide`);
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  assert.equal(ihdrType, 'IHDR', `${rel} : bloc IHDR manquant`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf.readUInt8(25);
  let hasTrns = false;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'tRNS') hasTrns = true;
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  return { width, height, colorType, hasTrns };
}

/* =========================================================================
   1. Hygiène du dépôt & licences
   ========================================================================= */
test('1. Hygiène du dépôt & licences (.nojekyll, LICENSE, OFL, .gitignore)', () => {
  assert.ok(existeFichier('.nojekyll'), '.nojekyll manquant à la racine');
  assert.ok(existeFichier('LICENSE'), 'LICENSE manquant à la racine');
  assert.ok(existeFichier('libs/pdfjs/LICENSE'), 'libs/pdfjs/LICENSE manquant');

  const licencesPolices = [
    'fonts/licences/OFL-atkinson-hyperlegible-next.txt',
    'fonts/licences/OFL-lexend.txt',
    'fonts/licences/OFL-literata.txt',
    'fonts/licences/OFL-opendyslexic.txt',
    'fonts/licences/OFL-roboto-mono.txt'
  ];
  for (const f of licencesPolices) {
    assert.ok(existeFichier(f), `Licence de police manquante : ${f}`);
  }

  const gitignore = lire('.gitignore')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const regle of ['node_modules/', 'package.json', 'package-lock.json']) {
    assert.ok(gitignore.includes(regle), `.gitignore doit exclure ${regle}`);
  }
});

/* =========================================================================
   2. CSP stricte dans index.html & zéro code/style en ligne
   ========================================================================= */
test('2. CSP stricte dans index.html & zéro code/style en ligne', () => {
  const html = lire('index.html');
  const directives = parserCsp(html);

  const attendues = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"]
  };

  for (const [nom, valeurs] of Object.entries(attendues)) {
    assert.deepEqual(directives.get(nom), valeurs, `Directive CSP incorrecte pour ${nom}`);
  }
  assert.equal(directives.size, Object.keys(attendues).length, 'Directives CSP inattendues détectées');

  const interdits = ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", '*', 'http:', 'https:', 'data:'];
  for (const [nom, valeurs] of directives.entries()) {
    for (const val of valeurs) {
      assert.ok(!interdits.includes(val.toLowerCase()), `Valeur CSP interdite (${val}) dans ${nom}`);
    }
  }

  const htmlPropre = sansCommentairesHtml(html);
  assert.ok(!/<style[\s>]/i.test(htmlPropre), 'Balise <style> en ligne interdite dans index.html');
  assert.ok(!/\sstyle\s*=/i.test(htmlPropre), 'Attribut style= en ligne interdit dans index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(htmlPropre), 'Gestionnaire d\'événement HTML on*= interdit dans index.html');

  for (const m of htmlPropre.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const corps = m[2].trim();
    assert.ok(/\bsrc\s*=\s*["'][^"']+["']/i.test(attrs), '<script> sans attribut src= interdit dans index.html');
    assert.equal(corps, '', '<script> avec corps non vide interdit dans index.html');
  }

  const fichiersJs = ['app.js', ...listerModulesJs()];
  for (const rel of fichiersJs) {
    const code = sansCommentairesJs(lire(rel));
    assert.ok(!/\.innerHTML\s*=/.test(code), `innerHTML= interdit dans ${rel}`);
    assert.ok(!/\.outerHTML\s*=/.test(code), `outerHTML= interdit dans ${rel}`);
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(code), `insertAdjacentHTML() interdit dans ${rel}`);
    assert.ok(!/\bdocument\.write\s*\(/.test(code), `document.write() interdit dans ${rel}`);
    assert.ok(!/\beval\s*\(/.test(code), `eval() interdit dans ${rel}`);
    assert.ok(!/\bnew\s+Function\s*\(/.test(code), `new Function() interdit dans ${rel}`);
    assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(code), `Fragment HTML avec style= interdit dans ${rel}`);
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(code), `Fragment HTML avec on*= interdit dans ${rel}`);
  }
});

/* =========================================================================
   3. Zéro ressource externe chargée (HTML, CSS, JS)
   ========================================================================= */
test('3. Zéro ressource externe chargée (HTML, CSS, JS)', () => {
  const htmlPropre = sansCommentairesHtml(lire('index.html'));
  for (const m of htmlPropre.matchAll(/<(?:link|script|img|iframe|source|video|audio|object|embed)\b([^>]*)>/gi)) {
    const attrs = m[1];
    for (const a of attrs.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      assert.ok(!/^(https?:)?\/\//i.test(a[1]), `Ressource externe détectée dans index.html : ${a[1]}`);
    }
  }

  const cssPropre = sansCommentairesCss(lire('styles.css'));
  assert.ok(!/@import\b/i.test(cssPropre), '@import interdit dans styles.css');
  assert.ok(!/url\s*\(\s*["']?(?:https?:)?\/\//i.test(cssPropre), 'URL externe interdite dans styles.css');

  for (const rel of ['app.js', ...listerModulesJs()]) {
    const code = sansCommentairesJs(lire(rel));
    assert.ok(!/\bfetch\s*\(\s*["'`](?:https?:)?\/\//i.test(code), `fetch externe interdit dans ${rel}`);
    assert.ok(!/\bimport\s*\(\s*["'`](?:https?:)?\/\//i.test(code), `import() externe interdit dans ${rel}`);
    assert.ok(
      !/\bnew\s+(?:Worker|SharedWorker|EventSource|WebSocket)\s*\(\s*["'`](?:(?:https?|wss?):)?\/\//i.test(code),
      `Connexion/Worker externe interdit dans ${rel}`
    );
  }
});

/* =========================================================================
   4. Vérification réciproque HTML / CSS / manifest.json / js/*.js <-> sw.js <-> disque
   ========================================================================= */
test('4. Vérification réciproque HTML / CSS / manifest.json / js/*.js <-> sw.js <-> disque', () => {
  const cfg = extraireConfigSw();
  assert.ok(Array.isArray(cfg.FICHIERS) && cfg.FICHIERS.length > 0, 'FICHIERS doit être un tableau non vide');
  assert.ok(Array.isArray(cfg.FICHIERS_PDF) && cfg.FICHIERS_PDF.length > 0, 'FICHIERS_PDF doit être un tableau non vide');

  assert.ok(cfg.FICHIERS.includes('./'), 'sw.js FICHIERS doit inclure ./');
  const swCoreBrut = new Set(cfg.FICHIERS);
  const swCore = new Set(cfg.FICHIERS.map((f) => normaliserChemin(f)));
  const swPdf = new Set(cfg.FICHIERS_PDF.map((f) => normaliserChemin(f)));
  assert.equal(swCoreBrut.size, cfg.FICHIERS.length, 'Doublon détecté dans sw.js FICHIERS');
  assert.equal(swPdf.size, cfg.FICHIERS_PDF.length, 'Doublon détecté dans sw.js FICHIERS_PDF');
  for (const f of swPdf) {
    assert.ok(!swCore.has(f), `${f} ne doit pas figurer à la fois dans FICHIERS et FICHIERS_PDF`);
  }

  for (const f of [...swCore, ...swPdf]) {
    assert.ok(existeFichier(f), `Fichier listé dans sw.js introuvable sur disque : ${f}`);
  }

  const refsCore = new Set(['index.html']);

  const htmlPropre = sansCommentairesHtml(lire('index.html'));
  for (const m of htmlPropre.matchAll(/<(?:link|script|img|source|video|audio)\b([^>]*)>/gi)) {
    const attrs = m[1];
    for (const a of attrs.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const val = a[1].trim();
      if (/^(#|mailto:|data:|blob:)/i.test(val)) continue;
      refsCore.add(normaliserChemin(val));
    }
  }

  const cssPropre = sansCommentairesCss(lire('styles.css'));
  const policesCss = new Set();
  for (const m of cssPropre.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const val = m[1].trim();
    if (/^data:/i.test(val)) continue;
    const norm = normaliserChemin(val);
    refsCore.add(norm);
    if (norm.startsWith('fonts/') && norm.endsWith('.woff2')) policesCss.add(norm);
  }

  const manifest = JSON.parse(lire('manifest.json'));
  assert.equal(manifest.id, '/omni-prompteur/', 'manifest.json id doit être /omni-prompteur/');
  if (manifest.start_url) refsCore.add(normaliserChemin(manifest.start_url));
  for (const icon of manifest.icons || []) {
    if (icon.src) refsCore.add(normaliserChemin(icon.src));
  }
  for (const shortcut of manifest.shortcuts || []) {
    if (shortcut.url) refsCore.add(normaliserChemin(shortcut.url));
  }

  const modulesSurDisque = listerModulesJs();
  for (const mod of modulesSurDisque) refsCore.add(mod);
  for (const mod of ['app.js', ...modulesSurDisque]) {
    for (const imp of extraireImportsStatiques(mod)) refsCore.add(imp);
  }

  for (const ref of refsCore) {
    assert.ok(existeFichier(ref), `Ressource référencée absente du disque : ${ref}`);
    assert.ok(swCore.has(ref), `Ressource locale absente de sw.js FICHIERS : ${ref}`);
  }

  const refsPdf = new Set(extraireImportsDynamiquesLocaux('js/pdf.js'));
  const mjsPdfSurDisque = fs
    .readdirSync(cheminAbsolu('libs/pdfjs'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => `libs/pdfjs/${e.name}`);
  for (const f of mjsPdfSurDisque) refsPdf.add(f);
  assert.ok(refsPdf.has('libs/pdfjs/pdf.min.mjs'), 'js/pdf.js doit référencer libs/pdfjs/pdf.min.mjs');
  assert.ok(refsPdf.has('libs/pdfjs/pdf.worker.min.mjs'), 'js/pdf.js doit référencer libs/pdfjs/pdf.worker.min.mjs');
  for (const ref of refsPdf) {
    assert.ok(existeFichier(ref), `Ressource PDF absente du disque : ${ref}`);
    assert.ok(swPdf.has(ref), `Ressource PDF absente de sw.js FICHIERS_PDF : ${ref}`);
  }

  const policesDisque = fs
    .readdirSync(cheminAbsolu('fonts'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.woff2'))
    .map((e) => `fonts/${e.name}`)
    .sort();
  assert.deepEqual([...policesCss].sort(), policesDisque, 'Parité fonts/*.woff2 <-> styles.css @font-face rompue');
  for (const f of policesDisque) {
    assert.ok(swCore.has(f), `Police absente de sw.js FICHIERS : ${f}`);
  }

  const appleIcon = lireEntetePng('icons/apple-touch-icon.png');
  assert.equal(appleIcon.width, 180, 'apple-touch-icon.png largeur != 180');
  assert.equal(appleIcon.height, 180, 'apple-touch-icon.png hauteur != 180');
  assert.equal(appleIcon.colorType, 2, 'apple-touch-icon.png doit être RGB opaque (colorType=2)');
  assert.equal(appleIcon.hasTrns, false, 'apple-touch-icon.png ne doit pas contenir de chunk tRNS');
});

/* =========================================================================
   5. Isolation du Service Worker (PREFIXE_CACHE & CACHE_PDF) sur ferrusdantioch.github.io
   ========================================================================= */
test('5. Isolation du Service Worker sur ferrusdantioch.github.io (statique + sandbox node:vm)', async () => {
  const swCode = lire('sw.js');
  const cfg = extraireConfigSw();

  assert.equal(cfg.PREFIXE_CACHE, 'omni-prompteur-');
  assert.equal(cfg.ANCIEN_PREFIXE_CACHE, 'prompteur-createurs-');
  assert.match(cfg.VERSION, /^omni-prompteur-v\d+$/);
  assert.match(cfg.CACHE_PDF, /^omni-prompteur-pdf-v\d+$/);
  assert.ok(swCode.includes('requete.url.startsWith(self.registration.scope)'), 'Garde de portée fetch manquante dans sw.js');

  const ecouteurs = new Map();
  const cachesStock = new Map([
    ['omni-prompteur-v10', new Map([['./libs/pdfjs/pdf.min.mjs', { clone: () => ({ ok: true }) }]])],
    ['prompteur-createurs-v5', new Map()],
    [cfg.VERSION, new Map()],
    ['omni-agenda-v1', new Map()],
    ['omni-video-v9', new Map()],
    ['omni-photo-v6', new Map()],
    ['omni-photo-ia-v1', new Map()],
    ['omni-time-v6', new Map()],
    ['omni-pdf-v1', new Map()]
  ]);
  const supprimes = [];

  const mockCaches = {
    keys: async () => [...cachesStock.keys()],
    open: async (nom) => {
      if (!cachesStock.has(nom)) cachesStock.set(nom, new Map());
      const map = cachesStock.get(nom);
      return {
        match: async (req) => map.get(typeof req === 'string' ? req : req.url) || undefined,
        put: async (req, res) => { map.set(typeof req === 'string' ? req : req.url, res); },
        addAll: async () => {}
      };
    },
    delete: async (nom) => {
      supprimes.push(nom);
      return cachesStock.delete(nom);
    }
  };

  const sandbox = {
    self: {
      registration: { scope: 'https://ferrusdantioch.github.io/omni-prompteur/' },
      addEventListener: (type, fn) => ecouteurs.set(type, fn),
      skipWaiting: () => {},
      clients: { claim: async () => {} }
    },
    caches: mockCaches,
    URL,
    Request: class Request {
      constructor(url, init) {
        this.url = url;
        this.init = init;
      }
    },
    fetch: async () => {
      throw new Error('fetch ne doit pas être appelé pour une requête hors périmètre');
    }
  };

  vm.runInNewContext(swCode, sandbox);

  const promessesActivate = [];
  ecouteurs.get('activate')({ waitUntil: (p) => promessesActivate.push(p) });
  await Promise.all(promessesActivate);

  assert.deepEqual(supprimes.sort(), ['omni-prompteur-v10', 'prompteur-createurs-v5']);
  for (const autre of ['omni-agenda-v1', 'omni-video-v9', 'omni-photo-v6', 'omni-photo-ia-v1', 'omni-time-v6', 'omni-pdf-v1', cfg.VERSION, cfg.CACHE_PDF]) {
    assert.ok(cachesStock.has(autre), `Cache préservé attendu manquant après activate : ${autre}`);
  }

  let respondWithAppele = false;
  ecouteurs.get('fetch')({
    request: { method: 'GET', url: 'https://ferrusdantioch.github.io/omni-video/app.js', mode: 'cors' },
    respondWith: () => { respondWithAppele = true; }
  });
  assert.equal(respondWithAppele, false, 'sw.js ne doit jamais intercepter les requêtes d\'une application sœur');
});

/* =========================================================================
   6. Cohérence des versions SW (sw.js <-> README.md & CLAUDE.md)
   ========================================================================= */
test('6. Cohérence des versions SW entre sw.js, README.md et CLAUDE.md', () => {
  const { VERSION, CACHE_PDF } = extraireConfigSw();
  for (const doc of ['README.md', 'CLAUDE.md']) {
    const contenu = lire(doc);
    assert.ok(
      contenu.includes(`const VERSION = '${VERSION}'`),
      `${doc} doit mentionner const VERSION = '${VERSION}'`
    );
    assert.ok(
      contenu.includes(`'${CACHE_PDF}'`),
      `${doc} doit mentionner '${CACHE_PDF}'`
    );
  }
});

/* =========================================================================
   7. Graphe de modules ES (app.js / js/*.js) : zéro cycle et zéro orphelin
   ========================================================================= */
test('7. Graphe de modules ES (app.js / js/*.js) : zéro cycle et zéro module orphelin', () => {
  const modules = listerModulesJs();
  const noeuds = ['app.js', ...modules];
  const adj = new Map();

  for (const n of noeuds) {
    const statiques = extraireImportsStatiques(n);
    for (const cible of statiques) {
      assert.ok(existeFichier(cible), `Import introuvable depuis ${n} : ${cible}`);
    }
    adj.set(n, statiques);
  }

  const etat = new Map(noeuds.map((n) => [n, 0])); // 0=non visité, 1=en cours, 2=terminé
  const pile = [];
  function dfs(u) {
    etat.set(u, 1);
    pile.push(u);
    for (const v of adj.get(u) || []) {
      if (etat.get(v) === 1) {
        const idx = pile.indexOf(v);
        assert.fail(`Import circulaire détecté : ${pile.slice(idx).concat(v).join(' -> ')}`);
      }
      if (etat.get(v) === 0) dfs(v);
    }
    pile.pop();
    etat.set(u, 2);
  }
  for (const n of noeuds) {
    if (etat.get(n) === 0) dfs(n);
  }

  const atteignables = new Set(['app.js']);
  const file = ['app.js'];
  while (file.length) {
    const cur = file.shift();
    const voisins = [...(adj.get(cur) || []), ...extraireImportsDynamiquesLocaux(cur)];
    for (const v of voisins) {
      if (noeuds.includes(v) && !atteignables.has(v)) {
        atteignables.add(v);
        file.push(v);
      }
    }
  }
  const orphelins = modules.filter((m) => !atteignables.has(m));
  assert.deepEqual(orphelins, [], `Modules ES orphelins détectés : ${orphelins.join(', ')}`);
});

/* =========================================================================
   8. Syntaxe JavaScript / ESM valide (node --check)
   ========================================================================= */
test('8. Syntaxe JavaScript / ESM valide (node --check sur tous les .js et .mjs)', () => {
  const fichiers = listerFichiersJsMjs();
  assert.ok(fichiers.length > 0, 'Aucun fichier JS/MJS trouvé');
  for (const abs of fichiers) {
    const rel = path.relative(RACINE, abs).split(path.sep).join('/');
    if (rel === 'app.js' || rel.startsWith('js/')) {
      try {
        execFileSync(process.execPath, ['--input-type=module', '--check'], {
          input: lire(rel),
          stdio: 'pipe'
        });
      } catch (err) {
        const detail = err.stderr ? err.stderr.toString('utf8').trim() : err.message;
        assert.fail(`Erreur de syntaxe ESM dans ${rel} :\n${detail}`);
      }
    } else {
      execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    }
  }
});
