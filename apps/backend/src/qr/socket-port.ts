import type { AuthenticationState } from '@whiskeysockets/baileys';

/**
 * Interface minimale du socket Baileys utilisée par l'application.
 * Elle permet de tester toute la logique (session, envois, garde-fous) sans réseau.
 */
export interface QrSocket {
  user?: { id: string; name?: string } | undefined;
  ev: {
    on(event: string, listener: (arg: any) => void): void;
    removeAllListeners?(event?: string): void;
  };
  sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key?: { id?: string | null } } | undefined>;
  sendPresenceUpdate(type: 'composing' | 'recording' | 'paused' | 'available' | 'unavailable', jid?: string): Promise<void>;
  logout(msg?: string): Promise<void>;
  end(error?: Error): void;
}

export type MakeQrSocket = (opts: { auth: AuthenticationState; logger: unknown }) => QrSocket;
