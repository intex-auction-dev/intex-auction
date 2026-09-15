import { isEip1193Provider, type Eip1193Provider } from './eip1193';

export type WalletProviderType = 'injected' | 'walletconnect';

export interface WalletProviderDescriptor {
  id: string;
  sessionId: string;
  type: WalletProviderType;
  name: string;
  provider: Eip1193Provider;
}

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  rdns: string;
}

interface Eip6963Announcement {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

export interface InjectedDiscoveryOptions {
  target: EventTarget;
  legacyProvider?: unknown;
  onProviders: (providers: readonly WalletProviderDescriptor[]) => void;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RDNS_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const readAnnouncement = (value: unknown): Eip6963Announcement | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { info?: unknown; provider?: unknown };
  if (typeof candidate.info !== 'object' || candidate.info === null || !isEip1193Provider(candidate.provider)) {
    return null;
  }
  const info = candidate.info as { uuid?: unknown; name?: unknown; rdns?: unknown };
  if (typeof info.uuid !== 'string' || !UUID_PATTERN.test(info.uuid)) return null;
  if (typeof info.name !== 'string') return null;
  if (typeof info.rdns !== 'string') return null;
  const name = info.name.trim();
  const rdns = info.rdns.trim().toLowerCase();
  if (!name || name.length > 80) return null;
  if (!rdns || rdns.length > 253 || !RDNS_PATTERN.test(rdns)) return null;
  return { info: { uuid: info.uuid.toLowerCase(), name, rdns }, provider: candidate.provider };
};

export const startInjectedProviderDiscovery = ({
  target,
  legacyProvider,
  onProviders,
}: InjectedDiscoveryOptions): (() => void) => {
  const providers = new Map<string, WalletProviderDescriptor>();
  const providerIds = new WeakMap<object, string>();

  const publish = () => onProviders([...providers.values()].sort((left, right) => left.name.localeCompare(right.name)));
  const add = (descriptor: WalletProviderDescriptor) => {
    const objectProvider = descriptor.provider as object;
    const existingId = providerIds.get(objectProvider);
    if (existingId && existingId !== descriptor.id) providers.delete(existingId);
    const existing = providers.get(descriptor.id);
    if (existing && existing.provider !== descriptor.provider) return;
    providerIds.set(objectProvider, descriptor.id);
    providers.set(descriptor.id, descriptor);
    publish();
  };

  if (isEip1193Provider(legacyProvider)) {
    add({
      id: 'legacy-injected',
      sessionId: 'legacy-injected',
      type: 'injected',
      name: 'Injected wallet',
      provider: legacyProvider,
    });
  } else {
    publish();
  }

  const onAnnouncement = (event: Event) => {
    const announcement = readAnnouncement((event as CustomEvent<unknown>).detail);
    if (!announcement) return;
    add({
      id: `eip6963:${announcement.info.uuid}`,
      sessionId: `eip6963-rdns:${announcement.info.rdns}`,
      type: 'injected',
      name: announcement.info.name,
      provider: announcement.provider,
    });
  };

  target.addEventListener('eip6963:announceProvider', onAnnouncement);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', onAnnouncement);
};
