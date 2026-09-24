// one object store per database, opened fresh on every call (both
// callers always did that, nothing ever closes it either)
export function idbStore(dbName, storeName, keyPath) {
  const open = () => new Promise((res, rej) => {
    const rq = indexedDB.open(dbName, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(storeName, { keyPath });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const read = async (fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const rq = fn(db.transaction(storeName).objectStore(storeName));
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  };
  const write = async (fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      fn(tx.objectStore(storeName));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  };
  return {
    get: async (key) => (await read(store => store.get(key))) || null,
    all: async () => (await read(store => store.getAll())) || [],
    put: (rec) => write(store => store.put(rec)),
    delete: (key) => write(store => store.delete(key)),
  };
}
