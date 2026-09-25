import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL, config.DATABASE_SSL);
runMigrations(db, (m) => console.log(m))
  .then((applied) => {
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : 'Base de données à jour');
    return db.end();
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
