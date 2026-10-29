import test from 'node:test';
import assert from 'node:assert/strict';
import { createTakPanel } from './ui.js';
import { getLocale, setLocale } from '../i18n/index.js';

// Stop after mounting markup: this checks the real template without requiring
// Cesium or constructing a live operator session. Importing ui.js above happens
// before changing language, so a module-time translation cannot pass.
test('TAK markup uses the language selected when the panel opens', () => {
  const previousLocale = getLocale();
  const previousDocument = globalThis.document;
  const mounted = new Error('markup mounted');
  let root;
  globalThis.document = {
    createElement() {
      root = {
        setAttribute(name, value) {
          this[name] = value;
        },
      };
      return root;
    },
    body: {
      appendChild() {
        throw mounted;
      },
    },
  };
  try {
    setLocale('es');
    assert.throws(
      () => createTakPanel({}),
      (error) => error === mounted,
    );
    assert.match(root.innerHTML, /OPERACIONES TAK/);
    assert.match(root.innerHTML, /PERMISOS DE DATOS PRIVADOS/);
    assert.equal(root['aria-label'], 'Cliente web TAK');
    assert.match(root.innerHTML, /data-tak-marker-broadcast/);
    assert.match(root.innerHTML, /Compartir con la red/);

    setLocale('zh-Hant');
    assert.throws(
      () => createTakPanel({}),
      (error) => error === mounted,
    );
    assert.match(root.innerHTML, /私人資料權限/);
    assert.match(root.innerHTML, /使用裝置 GPS/);
    assert.equal(root['aria-label'], 'TAK 網頁用戶端');
  } finally {
    setLocale(previousLocale);
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
