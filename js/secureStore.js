// Encrypted-at-rest storage for secrets (LLM API key, session token).
//
// Values are encrypted with AES-GCM via WebCrypto before hitting
// localStorage. The AES key is generated as a NON-EXTRACTABLE CryptoKey and
// kept in IndexedDB — so the ciphertext in localStorage is useless on its
// own (backups, casual DevTools snooping, storage-stealing extensions that
// only read localStorage). This does not defend against code running inside
// the page itself — for a pure client-side PWA nothing can.
//
// Legacy plaintext values are migrated transparently on first read.

const DB_NAME = 'st-secure';
const STORE = 'keys';
const KEY_ID = 'master';
const PREFIX = 'enc.v1.';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let _keyPromise = null;

function masterKey() {
  if (!_keyPromise) {
    _keyPromise = (async () => {
      const db = await openDb();
      let key = await idbGet(db, KEY_ID);
      if (!key) {
        key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false, // non-extractable: the raw key bytes can never be exported
          ['encrypt', 'decrypt']
        );
        await idbPut(db, KEY_ID, key);
      }
      return key;
    })();
    // A failed init (private browsing quirks etc.) must not poison retries
    _keyPromise.catch(() => { _keyPromise = null; });
  }
  return _keyPromise;
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** Encrypt and persist a secret under a localStorage key. */
export async function secureSet(name, value) {
  if (!value) {
    localStorage.removeItem(name);
    return;
  }
  try {
    const key = await masterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))
    );
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv);
    packed.set(ct, iv.length);
    localStorage.setItem(name, PREFIX + toB64(packed));
  } catch (e) {
    // WebCrypto needs a secure context (HTTPS / localhost). Degrade to
    // plaintext rather than locking the user out of login.
    console.warn('secureStore: encryption unavailable, storing plaintext', e);
    localStorage.setItem(name, value);
  }
}

/** Read and decrypt a secret; migrates legacy plaintext values in place. */
export async function secureGet(name) {
  const raw = localStorage.getItem(name);
  if (!raw) return '';
  if (!raw.startsWith(PREFIX)) {
    // Legacy plaintext from older versions — re-store encrypted
    await secureSet(name, raw);
    return raw;
  }
  try {
    const packed = fromB64(raw.slice(PREFIX.length));
    const key = await masterKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, 12) },
      key,
      packed.slice(12)
    );
    return new TextDecoder().decode(pt);
  } catch (e) {
    // Lost master key (cleared IndexedDB) — ciphertext is unrecoverable
    console.warn('secureStore: decrypt failed, clearing', name, e);
    localStorage.removeItem(name);
    return '';
  }
}
