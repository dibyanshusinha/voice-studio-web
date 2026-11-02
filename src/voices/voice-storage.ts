/** Local IndexedDB repository for reusable voice embeddings; no audio or profile is uploaded. */
import type { VoiceProfile } from './types';
// Embeddings use structured cloning, preserving Float32Array without JSON inflation.
/** Opens the local profile database and creates its store only during the first schema upgrade. */
async function openVoiceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('voice-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('voices', {
      keyPath: 'id'
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/** Resolves after the IndexedDB transaction commits, so a completed request cannot falsely imply a saved voice. */
async function runVoiceStoreTransaction<T>(mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openVoiceDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('voices', mode);
    const request = action(tx.objectStore('voices'));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error || Error('Voice storage failed'));
    };
  });
}
/** Restores all saved embeddings for the library without loading models or re-encoding references. */
export const loadSavedVoiceProfiles = () => runVoiceStoreTransaction('readonly', s => s.getAll()) as Promise<VoiceProfile[]>;
/** Inserts or replaces a voice using structured cloning, which preserves its Float32 embedding. */
export const persistVoiceProfile = (voice: VoiceProfile) => runVoiceStoreTransaction('readwrite', s => s.put(voice));
/** Deletes one profile by ID while leaving model caches and other saved voices intact. */
export const deleteVoiceProfile = (id: string) => runVoiceStoreTransaction('readwrite', s => s.delete(id));
