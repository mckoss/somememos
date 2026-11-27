// Opens the brain host. This first version keeps everything in memory on the
// main thread, so the UI can be built and tested; it is replaced by a host
// that runs the same engine in a worker on SQLite stored on the device.
import { engine, storage } from '@somememos/core';
import type { BrainHost, ImportFile, ImportResult, StorageInfo } from './host.ts';

export async function openBrainHost(): Promise<BrainHost> {
  const stores = storage.createMemoryStores();
  const content = storage.createMemoryContentStore();
  let config = storage.defaultBrainConfig(storage.newId());
  let current = engine.createEngine({ stores, content, config });

  const facade = new Proxy({} as engine.Engine, {
    get: (_target, key) => Reflect.get(current, key, current),
  });

  return {
    engine: facade,
    async importFiles(files: readonly ImportFile[]): Promise<ImportResult> {
      let imported = 0;
      let skipped = 0;
      for (const file of files) {
        if (!file.path.endsWith('.md')) {
          skipped += 1;
          continue;
        }
        await content.write(file.path, file.text, { mtime: file.mtime });
        imported += 1;
      }
      const index = await current.index();
      return { imported, skipped, index };
    },
    async updateConfig(next): Promise<void> {
      config = next;
      current = engine.createEngine({ stores, content, config });
      await current.index();
    },
    async storageInfo(): Promise<StorageInfo> {
      return { kind: 'memory', persisted: false };
    },
    async requestPersistence(): Promise<boolean> {
      return false;
    },
    async reset(): Promise<void> {
      for (const entry of await content.list()) await content.remove(entry.path);
      await stores.resetIndex();
    },
  };
}
