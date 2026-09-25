import type { ConnectionCredentials, HttpObserver, ProviderCapabilities, ProviderConnector, ProviderId } from './types.js';
import { SendZenConnector } from './sendzen/connector.js';

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  /** Seuls les fournisseurs réellement développés sont listés. */
  implemented: true;
  capabilities: ProviderCapabilities;
}

export const PROVIDERS: ProviderDescriptor[] = [
  { id: 'sendzen', name: 'SendZen', implemented: true, capabilities: SendZenConnector.capabilities() },
];

export function createConnector(
  provider: ProviderId,
  creds: ConnectionCredentials,
  opts: { observer?: HttpObserver; timeoutMs?: number } = {},
): ProviderConnector {
  switch (provider) {
    case 'sendzen':
      return new SendZenConnector(creds, opts);
    default:
      throw new Error(`Fournisseur non pris en charge : ${provider as string}`);
  }
}
