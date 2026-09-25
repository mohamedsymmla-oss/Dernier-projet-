import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'src/cli/migrate.ts', 'create-user': 'src/cli/create-user.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Les paquets du monorepo sont intégrés au bundle ; les dépendances npm restent externes.
  noExternal: [/^@wa\//],
});
