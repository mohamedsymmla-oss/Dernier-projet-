import makeWASocket, { Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import type { AppContext } from '../context.js';
import { qrRuntime } from './connector.js';
import { QrSessionManager } from './session.js';
import type { MakeQrSocket, QrSocket } from './socket-port.js';
import { getSession, updateSession } from './store.js';

/** Socket Baileys réel. Réglages choisis pour un usage discret et proche d'un humain. */
export const makeBaileysSocket: MakeQrSocket = ({ auth, logger }) => {
  const l = logger as Parameters<typeof makeCacheableSignalKeyStore>[1];
  return makeWASocket({
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, l) },
    logger: l,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false, // le téléphone continue de recevoir ses notifications
    syncFullHistory: false, // pas de synchronisation massive de l'historique
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 30_000,
  }) as unknown as QrSocket;
};

/** Démarre la session QR du worker et renvoie les commandes de pilotage. */
export function startQrRuntime(ctx: AppContext, makeSocket: MakeQrSocket = makeBaileysSocket) {
  const manager = new QrSessionManager(ctx, makeSocket);
  qrRuntime.manager = manager;
  const log = ctx.log.child({ component: 'qr-runtime' });

  const ensureRunning = async () => {
    const s = await getSession(ctx.db);
    if (s?.desired_state === 'RUNNING' && !manager.isRunning()) await manager.start();
  };
  void ensureRunning().catch((e) => log.error({ err: e }, 'qr_start_failed'));

  return {
    manager,
    ensureRunning,
    async handle(action: 'start' | 'logout' | 'stop') {
      if (action === 'start') return manager.start();
      if (action === 'logout') return manager.logout();
      const s = await getSession(ctx.db);
      if (s) await updateSession(ctx.db, s.id, { desired_state: 'STOPPED' } as never);
      return manager.stop();
    },
    async close() {
      await manager.stop();
      if (qrRuntime.manager === manager) qrRuntime.manager = null;
    },
  };
}
