import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  createPublicReadClient,
  type RpcEndpointSelectionError,
  type PublicRpcReadProfile,
} from '@/chain/create-public-read-client';

const profile = (rpcUrls: readonly string[] = ['http://first', 'http://second']): PublicRpcReadProfile => ({
  id: 'local-origin',
  chainId: 31337,
  rpcUrls,
  requestTimeoutMs: 1_000,
  readRetryCount: 0,
});

const client = (chainId: number | Error): PublicClient =>
  ({
    getChainId: async () => {
      if (chainId instanceof Error) throw chainId;
      return chainId;
    },
  }) as PublicClient;

describe('configured public read client', () => {
  it('selects the first healthy matching endpoint and keeps that client', async () => {
    const created: string[] = [];
    const selected = await createPublicReadClient(profile(), (rpcUrl) => {
      created.push(rpcUrl);
      return rpcUrl.endsWith('first') ? client(new Error('offline')) : client(31337);
    });

    expect(created).toEqual(['http://first', 'http://second']);
    expect(selected.rpcUrl).toBe('http://second');
    expect(await selected.client.getChainId()).toBe(31337);
  });

  it('skips an endpoint reporting the wrong chain', async () => {
    const selected = await createPublicReadClient(profile(), (rpcUrl) =>
      rpcUrl.endsWith('first') ? client(56) : client(31337),
    );

    expect(selected.rpcUrl).toBe('http://second');
  });

  it('returns a scoped failure when every endpoint fails', async () => {
    await expect(
      createPublicReadClient(profile(), (rpcUrl) => client(new Error(`${rpcUrl} unavailable`))),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'Error',
        profileId: 'local-origin',
        failures: expect.arrayContaining([
          expect.stringContaining('http://first'),
          expect.stringContaining('http://second'),
        ]),
      } satisfies Partial<RpcEndpointSelectionError>),
    );
  });

  it('creates separate logical clients for origin and venue on the same local chain', async () => {
    const clients: PublicClient[] = [];
    const factory = () => {
      const created = client(31337);
      clients.push(created);
      return created;
    };

    const [origin, venue] = await Promise.all([
      createPublicReadClient({ ...profile(['http://local']), id: 'origin' }, factory),
      createPublicReadClient({ ...profile(['http://local']), id: 'venue' }, factory),
    ]);

    expect(origin.client).not.toBe(venue.client);
    expect(clients).toHaveLength(2);
  });
});
