import { createUser } from '../auth.js';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createPool } from '../db/pool.js';

/** Usage : npm run create-user -- email@exemple.com "MotDePasseLong" */
const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage : npm run create-user -- <email> <mot_de_passe (10 caractères min)>');
  process.exit(1);
}
const config = loadConfig();
const db = createPool(config.DATABASE_URL, config.DATABASE_SSL);
createUser({ db } as AppContext, email, password)
  .then((u) => {
    console.log(`Compte prêt : ${u?.email}`);
    return db.end();
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
