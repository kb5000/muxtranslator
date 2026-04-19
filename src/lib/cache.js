var CacheModule = CacheModule || {};
(function (ns) {
  'use strict';

  var DB_NAME = 'muxtranslator-cache';
  var DB_VERSION = 1;
  var STORE = 'translations';

  var _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not available'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
    return _dbPromise.catch(function (err) {
      _dbPromise = null;
      throw err;
    });
  }

  function makeKey(text, targetLang, model) {
    var normalized = UtilsModule.normalizeText(text);
    var hash = UtilsModule.hashText(normalized);
    return hash + '|' + (targetLang || '') + '|' + (model || '');
  }

  ns.init = async function () {
    try {
      await openDB();
      return true;
    } catch (e) {
      console.error('[MuxTranslator] Cache init failed:', e);
      return false;
    }
  };

  ns.get = async function (sourceText, targetLang, model) {
    try {
      var db = await openDB();
      var id = makeKey(sourceText, targetLang, model);
      return await new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readonly');
        var store = tx.objectStore(STORE);
        var req = store.get(id);
        req.onsuccess = function () {
          resolve(req.result ? req.result.translated : null);
        };
        req.onerror = function () {
          resolve(null);
        };
      });
    } catch (e) {
      return null;
    }
  };

  ns.set = async function (sourceText, targetLang, model, translatedText) {
    try {
      var db = await openDB();
      var id = makeKey(sourceText, targetLang, model);
      var normalized = UtilsModule.normalizeText(sourceText);
      var record = {
        id: id,
        sourceHash: UtilsModule.hashText(normalized),
        targetLang: targetLang,
        model: model,
        sourceText: normalized.slice(0, 500),
        translated: translatedText,
        createdAt: Date.now()
      };
      await new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var req = store.put(record);
        req.onsuccess = function () {
          resolve();
        };
        req.onerror = function () {
          resolve();
        };
      });
    } catch (e) {
      // ignore — cache is best-effort
    }
  };

  ns.clear = async function () {
    try {
      var db = await openDB();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var req = store.clear();
        req.onsuccess = function () {
          resolve();
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  ns.getStats = async function () {
    try {
      var db = await openDB();
      return await new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readonly');
        var store = tx.objectStore(STORE);
        var req = store.count();
        req.onsuccess = function () {
          resolve({ count: req.result });
        };
        req.onerror = function () {
          resolve({ count: 0 });
        };
      });
    } catch (e) {
      return { count: 0 };
    }
  };
})(CacheModule);
