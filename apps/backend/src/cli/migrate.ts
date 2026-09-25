import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

/** Applique les migrations. Seule DATABASE_URL est nécessaire. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}
const db = createPool(url, process.env.DATABASE_SSL === 'true');
runMigrations(db, (m) => console.log(m))
  .then((applied) => {
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : 'Base de données à jour');
    return db.end();
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
