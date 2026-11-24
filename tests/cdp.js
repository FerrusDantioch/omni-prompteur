/* Omni-Prompteur — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* =========================================================================
   Pilote CDP (Chrome DevTools Protocol) compatible avec le sous-ensemble
   Playwright utilisé par tests/outils.js et tests/tester.js.
   Permet d'exécuter les tests E2E dans un vrai navigateur Chromium/Brave/Edge
   sans aucune dépendance npm lorsque Playwright n'est pas installé localement.
   ========================================================================= */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function trouverNavigateur() {
  for (const cle of ['CHROMIUM_PATH', 'CHROME_PATH', 'EDGE_PATH']) {
    const val = process.env[cle];
    if (val && fs.existsSync(val)) return val;
  }

  const candidats = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidats.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local ? path.join(local, 'Google\\Chrome\\Application\\chrome.exe') : '',
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      local ? path.join(local, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
      path.join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(pf86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      local ? path.join(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') : ''
    );
  } else if (process.platform === 'darwin') {
    candidats.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidats.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser'
    );
  }

  for (const c of candidats) {
    if (c && fs.existsSync(c)) return c;
  }

  if (process.platform !== 'win32') {
    for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      try {
        const res = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (res && fs.existsSync(res)) return res;
      } catch {
        /* absent */
      }
    }
  }
  throw new Error('Aucun navigateur Chromium/Chrome/Edge/Brave détecté sur cette machine.');
}

class ConnexionCdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.enAttente = new Map();
    this.ecouteurs = new Set();

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg.id) {
        const att = this.enAttente.get(msg.id);
        if (!att) return;
        this.enAttente.delete(msg.id);
        if (msg.error) att.reject(new Error(msg.error.message || 'Erreur CDP'));
        else att.resolve(msg.result || {});
      } else if (msg.method) {
        for (const fn of this.ecouteurs) fn(msg);
      }
    });

    const rejeterTout = (err) => {
      for (const att of this.enAttente.values()) att.reject(err);
      this.enAttente.clear();
    };
    ws.addEventListener('close', () => rejeterTout(new Error('Connexion CDP fermée')));
    ws.addEventListener('error', () => rejeterTout(new Error('Erreur WebSocket CDP')));
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.enAttente.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  onEvent(fn) {
    this.ecouteurs.add(fn);
    return () => this.ecouteurs.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* déjà fermé */
    }
  }
}

const TOUCHES = {
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
};

function mapperPermissions(perms) {
  const table = {
    camera: 'videoCapture',
    microphone: 'audioCapture',
    notifications: 'notifications',
    geolocation: 'geolocation'
  };
  return perms.map((p) => table[p] || p);
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = {
  async launch({ args = [], executablePath } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new Error('Node >= 22 (WebSocket global) est requis pour le mode CDP.');
    }
    const exe = executablePath || trouverNavigateur();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-cdp-'));
    let child;
    let ws;
    try {
      child = spawn(
        exe,
        [
          '--headless=new',
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          `--user-data-dir=${tmpDir}`,
          ...args,
          'about:blank'
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      const wsUrl = await new Promise((resolve, reject) => {
        let logs = '';
        const timer = setTimeout(() => {
          reject(new Error('Délai dépassé au lancement du navigateur CDP.\n' + logs));
        }, 15000);
        const inspecter = (chunk) => {
          logs += chunk.toString('utf8');
          const m = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        };
        child.stderr.on('data', inspecter);
        child.stdout.on('data', inspecter);
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Navigateur terminé prématurément (${code}).\n${logs}`));
        });
      });

      ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('Impossible d’ouvrir le WebSocket DevTools')), { once: true });
      });
    } catch (err) {
      try {
        if (ws) ws.close();
      } catch {
        /* déjà fermé */
      }
      if (child) {
        try {
          child.kill();
        } catch {
          /* déjà terminé */
        }
        await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(resolve, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      throw err;
    }

    const cdp = new ConnexionCdp(ws);
    const contextes = new Map();
    const cadreVersContexte = new Map();
    const telechargementsParGuid = new Map();

    cdp.onEvent((msg) => {
      if (msg.method === 'Browser.downloadWillBegin') {
        const { frameId, guid, suggestedFilename } = msg.params;
        const ctx = cadreVersContexte.get(frameId) || [...contextes.values()][0];
        if (!ctx) return;
        const info = {
          guid,
          suggestedFilename,
          path: path.join(ctx._downloadDir, guid),
          ctx
        };
        telechargementsParGuid.set(guid, info);
      } else if (msg.method === 'Browser.downloadProgress') {
        const { guid, state } = msg.params;
        const info = telechargementsParGuid.get(guid);
        if (!info) return;
        if (state === 'completed') {
          telechargementsParGuid.delete(guid);
          const item = {
            suggestedFilename: () => info.suggestedFilename,
            path: async () => info.path
          };
          const waiter = info.ctx._downloadWaiters.shift();
          if (waiter) waiter.resolve(item);
          else info.ctx._completedDownloads.push(item);
        } else if (state === 'canceled') {
          telechargementsParGuid.delete(guid);
          const waiter = info.ctx._downloadWaiters.shift();
          if (waiter) waiter.reject(new Error('Téléchargement annulé'));
        }
      }
    });

    return {
      async newContext({ viewport, deviceScaleFactor = 1, isMobile = false, hasTouch = false, acceptDownloads = true } = {}) {
        const { browserContextId } = await cdp.send('Target.createBrowserContext');
        const downloadDir = path.join(tmpDir, 'dl-' + browserContextId.slice(0, 8));
        fs.mkdirSync(downloadDir, { recursive: true });
        if (acceptDownloads) {
          await cdp.send('Browser.setDownloadBehavior', {
            behavior: 'allowAndName',
            downloadPath: downloadDir,
            browserContextId,
            eventsEnabled: true
          });
        }

        const ctx = {
          _id: browserContextId,
          _downloadDir: downloadDir,
          _downloadWaiters: [],
          _completedDownloads: [],
          _permissions: new Set(),
          _grantedOrigins: new Set(),
          _offline: false,
          _pages: new Set(),
          _requestListeners: new Set(),

          on(evt, fn) {
            if (evt === 'request') ctx._requestListeners.add(fn);
          },

          async grantPermissions(perms) {
            for (const p of mapperPermissions(perms)) ctx._permissions.add(p);
            for (const origin of ctx._grantedOrigins) {
              await cdp.send('Browser.grantPermissions', {
                permissions: [...ctx._permissions],
                origin,
                browserContextId
              });
            }
          },

          async setOffline(offline) {
            ctx._offline = Boolean(offline);
            for (const page of ctx._pages) {
              await cdp.send(
                'Network.emulateNetworkConditions',
                {
                  offline: ctx._offline,
                  latency: 0,
                  downloadThroughput: ctx._offline ? 0 : -1,
                  uploadThroughput: ctx._offline ? 0 : -1
                },
                page._sessionId
              );
            }
          },

          async newPage() {
            const { targetId } = await cdp.send('Target.createTarget', {
              url: 'about:blank',
              browserContextId
            });
            const { sessionId } = await cdp.send('Target.attachToTarget', {
              targetId,
              flatten: true
            });

            await cdp.send('Page.enable', {}, sessionId);
            await cdp.send('Runtime.enable', {}, sessionId);
            await cdp.send('DOM.enable', {}, sessionId);
            await cdp.send('Network.enable', {}, sessionId);
            await cdp.send('Log.enable', {}, sessionId);

            const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
            if (tree?.frameTree?.frame?.id) {
              cadreVersContexte.set(tree.frameTree.frame.id, ctx);
            }

            if (viewport) {
              await cdp.send(
                'Emulation.setDeviceMetricsOverride',
                {
                  width: viewport.width,
                  height: viewport.height,
                  deviceScaleFactor,
                  mobile: Boolean(isMobile)
                },
                sessionId
              );
            }
            if (hasTouch) {
              await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId);
            }
            if (ctx._offline) {
              await cdp.send(
                'Network.emulateNetworkConditions',
                { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
                sessionId
              );
            }

            const pageListeners = { pageerror: new Set(), console: new Set(), dialog: new Set() };
            const loadWaiters = [];
            let currentUrl = 'about:blank';

            const offSession = cdp.onEvent((msg) => {
              if (msg.sessionId !== sessionId) return;
              if (msg.method === 'Page.loadEventFired') {
                while (loadWaiters.length) loadWaiters.shift()();
              } else if (msg.method === 'Page.frameNavigated' && !msg.params.frame?.parentId) {
                currentUrl = msg.params.frame.url || currentUrl;
                if (msg.params.frame?.id) cadreVersContexte.set(msg.params.frame.id, ctx);
              } else if (msg.method === 'Network.requestWillBeSent') {
                const reqObj = { url: () => msg.params.request.url };
                for (const fn of ctx._requestListeners) fn(reqObj);
              } else if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                const message = d.exception?.description || d.text || 'Exception JS';
                const err = new Error(message);
                for (const fn of pageListeners.pageerror) fn(err);
              } else if (msg.method === 'Runtime.consoleAPICalled') {
                const type = msg.params.type === 'warning' ? 'warn' : msg.params.type;
                const text = (msg.params.args || [])
                  .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
                  .join(' ');
                const obj = { type: () => type, text: () => text };
                for (const fn of pageListeners.console) fn(obj);
              } else if (msg.method === 'Log.entryAdded' && msg.params.entry?.level === 'error') {
                const obj = { type: () => 'error', text: () => msg.params.entry.text || '' };
                for (const fn of pageListeners.console) fn(obj);
              } else if (msg.method === 'Page.javascriptDialogOpening') {
                const { type, message } = msg.params;
                if (pageListeners.dialog.size > 0) {
                  const dialog = {
                    type: () => type,
                    message: () => message,
                    accept: (promptText) =>
                      cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText }, sessionId),
                    dismiss: () => cdp.send('Page.handleJavaScriptDialog', { accept: false }, sessionId)
                  };
                  for (const fn of pageListeners.dialog) fn(dialog);
                } else {
                  cdp.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, sessionId).catch(() => {});
                }
              }
            });

            const attendreLoad = (timeout = 15000) =>
              new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Délai dépassé sur loadEventFired')), timeout);
                loadWaiters.push(() => {
                  clearTimeout(timer);
                  resolve();
                });
              });

            const page = {
              _sessionId: sessionId,
              _targetId: targetId,
              _off: offSession,

              on(evt, fn) {
                if (pageListeners[evt]) pageListeners[evt].add(fn);
              },

              url() {
                return currentUrl;
              },

              async evaluate(fn, arg) {
                const expr =
                  typeof fn === 'function'
                    ? arg === undefined
                      ? `(${fn})()`
                      : `(${fn})(${JSON.stringify(arg)})`
                    : String(fn);
                const res = await cdp.send(
                  'Runtime.evaluate',
                  { expression: expr, awaitPromise: true, returnByValue: true },
                  sessionId
                );
                if (res.exceptionDetails) {
                  const d = res.exceptionDetails;
                  throw new Error(d.exception?.description || d.text || 'Erreur evaluate');
                }
                return res.result ? res.result.value : undefined;
              },

              async $eval(sel, fn, arg) {
                const expr = `(() => {
                  const el = document.querySelector(${JSON.stringify(sel)});
                  if (!el) throw new Error('Élément introuvable : ' + ${JSON.stringify(sel)});
                  return (${fn})(el${arg === undefined ? '' : ', ' + JSON.stringify(arg)});
                })()`;
                return page.evaluate(expr);
              },

              async $$eval(sel, fn, arg) {
                const expr = `(() => {
                  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
                  return (${fn})(els${arg === undefined ? '' : ', ' + JSON.stringify(arg)});
                })()`;
                return page.evaluate(expr);
              },

              async waitForTimeout(ms) {
                await attendre(ms);
              },

              async waitForLoadState(state = 'load', { timeout = 15000 } = {}) {
                if (state !== 'load') return;
                await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout });
              },

              async waitForFunction(fn, arg, { timeout = 15000 } = {}) {
                const debut = Date.now();
                let derniereErreur;
                while (Date.now() - debut < timeout) {
                  try {
                    const val = await page.evaluate(fn, arg);
                    if (val) return val;
                  } catch (e) {
                    derniereErreur = e;
                    if (!/context was destroyed|Cannot find context|Inspected target navigated/i.test(e.message)) {
                      throw e;
                    }
                  }
                  await attendre(50);
                }
                throw derniereErreur || new Error('Délai dépassé dans waitForFunction');
              },

              async waitForSelector(sel, { timeout = 15000, state = 'visible' } = {}) {
                const etatsValides = new Set(['visible', 'hidden', 'attached', 'detached']);
                if (!etatsValides.has(state)) {
                  throw new Error(`État waitForSelector inconnu : ${state}`);
                }
                await page.waitForFunction(
                  ({ s, st }) => {
                    const el = document.querySelector(s);
                    if (st === 'attached') return Boolean(el);
                    if (st === 'detached') return !el;
                    const visible = Boolean(
                      el &&
                      getComputedStyle(el).display !== 'none' &&
                      getComputedStyle(el).visibility !== 'hidden' &&
                      el.getClientRects().length > 0
                    );
                    if (st === 'visible') return visible;
                    return !visible;
                  },
                  { s: sel, st: state },
                  { timeout }
                );
              },

              async goto(url, { timeout = 15000 } = {}) {
                try {
                  const u = new URL(url);
                  if ((u.protocol === 'http:' || u.protocol === 'https:') && ctx._permissions.size > 0) {
                    ctx._grantedOrigins.add(u.origin);
                    await cdp.send('Browser.grantPermissions', {
                      permissions: [...ctx._permissions],
                      origin: u.origin,
                      browserContextId
                    });
                  }
                } catch {
                  /* URL non HTTP */
                }

                const pLoad = attendreLoad(timeout);
                const nav = await cdp.send('Page.navigate', { url }, sessionId);
                currentUrl = url;
                if (nav.errorText) throw new Error(`Navigation échouée (${nav.errorText}) vers ${url}`);
                if (nav.loaderId) {
                  await pLoad;
                } else {
                  pLoad.catch(() => {});
                }
                await page.waitForLoadState('load', { timeout });
              },

              async reload({ timeout = 15000 } = {}) {
                const pLoad = attendreLoad(timeout);
                await cdp.send('Page.reload', {}, sessionId);
                await pLoad;
                await page.waitForLoadState('load', { timeout });
              },

              async click(sel, { timeout = 10000 } = {}) {
                const debut = Date.now();
                let info = null;
                while (Date.now() - debut < timeout) {
                  info = await page.evaluate((s) => {
                    const el = document.querySelector(s);
                    if (!el) return { ok: false, raison: 'absent' };
                    const style = getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || el.getClientRects().length === 0) {
                      return { ok: false, raison: 'invisible' };
                    }
                    if ('disabled' in el && el.disabled) return { ok: false, raison: 'desactive' };
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return { ok: false, raison: 'taille nulle' };
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    const dessus = document.elementFromPoint(x, y);
                    const recouverte = !dessus || (dessus !== el && !el.contains(dessus) && !dessus.contains(el));
                    if (recouverte) {
                      return { ok: false, raison: 'masque par ' + (dessus?.id || dessus?.tagName || 'autre') };
                    }
                    return { ok: true, x, y };
                  }, sel);
                  if (info.ok) break;
                  await attendre(50);
                }
                if (!info || !info.ok) {
                  throw new Error(`Impossible de cliquer sur ${sel} (${info?.raison || 'timeout'})`);
                }
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y }, sessionId);
                await cdp.send(
                  'Input.dispatchMouseEvent',
                  { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 },
                  sessionId
                );
                await cdp.send(
                  'Input.dispatchMouseEvent',
                  { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 },
                  sessionId
                );
              },

              async fill(sel, value, { timeout = 10000 } = {}) {
                await page.waitForSelector(sel, { timeout });
                await page.evaluate(
                  ({ s, v }) => {
                    const el = document.querySelector(s);
                    if (!el) throw new Error('Élément introuvable : ' + s);
                    el.focus();
                    const proto =
                      el instanceof HTMLTextAreaElement
                        ? HTMLTextAreaElement.prototype
                        : HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && desc.set) desc.set.call(el, String(v));
                    else el.value = String(v);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  },
                  { s: sel, v: value }
                );
              },

              async selectOption(sel, value, { timeout = 10000 } = {}) {
                await page.waitForSelector(sel, { timeout });
                await page.evaluate(
                  ({ s, v }) => {
                    const el = document.querySelector(s);
                    if (!el) throw new Error('Select introuvable : ' + s);
                    const str = String(v);
                    const existe = [...el.options].some((o) => o.value === str);
                    if (!existe) throw new Error(`Option "${str}" introuvable dans ${s}`);
                    el.value = str;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  },
                  { s: sel, v: value }
                );
              },

              async setInputFiles(sel, files, { timeout = 10000 } = {}) {
                await page.waitForSelector(sel, { state: 'attached', timeout });
                const liste = (Array.isArray(files) ? files : [files]).map((f) => path.resolve(f));
                const doc = await cdp.send('DOM.getDocument', { depth: 1 }, sessionId);
                const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel }, sessionId);
                if (!q.nodeId) throw new Error('Champ fichier introuvable : ' + sel);
                await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: liste }, sessionId);
              },

              keyboard: {
                async press(key) {
                  const def = TOUCHES[key] || { key, code: key, keyCode: key.charCodeAt(0) };
                  await cdp.send(
                    'Input.dispatchKeyEvent',
                    {
                      type: 'rawKeyDown',
                      key: def.key,
                      code: def.code,
                      windowsVirtualKeyCode: def.keyCode,
                      nativeVirtualKeyCode: def.keyCode
                    },
                    sessionId
                  );
                  if (def.text) {
                    await cdp.send(
                      'Input.dispatchKeyEvent',
                      { type: 'char', text: def.text, unmodifiedText: def.text },
                      sessionId
                    );
                  }
                  await cdp.send(
                    'Input.dispatchKeyEvent',
                    {
                      type: 'keyUp',
                      key: def.key,
                      code: def.code,
                      windowsVirtualKeyCode: def.keyCode,
                      nativeVirtualKeyCode: def.keyCode
                    },
                    sessionId
                  );
                }
              },

              waitForEvent(evt, { timeout = 15000 } = {}) {
                if (evt !== 'download') {
                  return Promise.reject(new Error(`Événement non pris en charge par cdp.js : ${evt}`));
                }
                if (ctx._completedDownloads.length > 0) {
                  return Promise.resolve(ctx._completedDownloads.shift());
                }
                return new Promise((resolve, reject) => {
                  const timer = setTimeout(() => {
                    const idx = ctx._downloadWaiters.indexOf(waiter);
                    if (idx >= 0) ctx._downloadWaiters.splice(idx, 1);
                    reject(new Error('Délai dépassé en attendant un téléchargement'));
                  }, timeout);
                  const waiter = {
                    resolve: (item) => {
                      clearTimeout(timer);
                      resolve(item);
                    },
                    reject: (err) => {
                      clearTimeout(timer);
                      reject(err);
                    }
                  };
                  ctx._downloadWaiters.push(waiter);
                });
              }
            };

            ctx._pages.add(page);
            return page;
          },

          async close() {
            for (const page of ctx._pages) page._off();
            ctx._pages.clear();
            contextes.delete(browserContextId);
            await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
          }
        };

        contextes.set(browserContextId, ctx);
        return ctx;
      },

      async close() {
        cdp.close();
        try {
          child.kill();
        } catch {
          /* déjà terminé */
        }
        await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(resolve, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    };
  }
};

module.exports = { chromium, trouverNavigateur };
