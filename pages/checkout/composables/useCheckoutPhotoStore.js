
const DB_NAME = 'poff-checkout'
const STORE = 'gift-photos'

function openDb () {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function runWrite (mutate) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    mutate(tx.objectStore(STORE))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
    tx.onabort = () => { db.close(); reject(tx.error) }
  }))
}

function runRead (read) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = read(tx.objectStore(STORE))
    req.onsuccess = () => { db.close(); resolve(req.result) }
    req.onerror = () => { db.close(); reject(req.error) }
  }))
}

export async function savePhoto (key, value) {
  if (!key) return
  try { await runWrite(store => store.put(value, key)) } catch { /* best effort */ }
}

export async function getPhoto (key) {
  if (!key) return null
  try { return (await runRead(store => store.get(key))) ?? null } catch { return null }
}

export async function deletePhoto (key) {
  if (!key) return
  try { await runWrite(store => store.delete(key)) } catch { /* best effort */ }
}

export async function clearAllPhotos () {
  try { await runWrite(store => store.clear()) } catch { /* best effort */ }
}

export async function prunePhotosExcept (keepKeys = []) {
  try {
    const keep = new Set(keepKeys)
    const keys = (await runRead(store => store.getAllKeys())) || []
    await Promise.all(keys.filter(k => !keep.has(k)).map(deletePhoto))
  } catch { /* best effort */ }
}
