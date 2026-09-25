import { createUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { createPool } from '../db/pool.js';

/** Usage : npm run create-user -- email@exemple.com "MotDePasseLong"  (seule DATABASE_URL est nécessaire) */
const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage : npm run create-user -- <email> <mot_de_passe (10 caractères min)>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}
const db = createPool(process.env.DATABASE_URL, process.env.DATABASE_SSL === 'true');
createUser({ db } as AppContext, email, password)
  .then((u) => {
    console.log(`Compte prêt : ${u?.email}`);
    return db.end();
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
