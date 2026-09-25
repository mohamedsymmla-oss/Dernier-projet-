import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Une seule base de test partagée : les fichiers s'exécutent l'un après l'autre.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
