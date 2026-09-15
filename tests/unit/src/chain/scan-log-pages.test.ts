import { describe, expect, it } from 'vitest';
import type { AbiEvent, Address, Hex } from 'viem';
import { type LogPageScanError, LogPageScanInterruptedError, scanLogPages } from '@/chain/scan-log-pages';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const EVENT = { type: 'event', name: 'BidRevealed', inputs: [] } as unknown as AbiEvent;

const txFor = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;

const log = (input: {
  readonly blockNumber: bigint;
  readonly transactionHash?: Hex;
  readonly transactionIndex?: number | null;
  readonly logIndex?: number;
}): unknown => ({
  blockNumber: input.blockNumber,
  transactionHash: input.transactionHash ?? txFor('a'),
  transactionIndex: input.transactionIndex ?? 0,
  logIndex: input.logIndex ?? 0,
});

describe('chain log page scanner', () => {
  it('uses explicit block pages, retries failed pages, deduplicates logs, and returns deterministic order', async () => {
    const requests: Array<{ fromBlock: bigint; toBlock: bigint; args?: Readonly<Record<string, unknown>> }> = [];
    const failures = new Map<string, number>([['6-10', 1]]);
    const duplicate = log({ blockNumber: 8n, transactionHash: txFor('b'), transactionIndex: null, logIndex: 3 });
    const client = {
      getLogs: async (request: {
        readonly address: Address;
        readonly event: AbiEvent;
        readonly args?: Readonly<Record<string, unknown>>;
        readonly fromBlock: bigint;
        readonly toBlock: bigint;
      }): Promise<readonly unknown[]> => {
        requests.push({
          fromBlock: request.fromBlock,
          toBlock: request.toBlock,
          ...(request.args === undefined ? {} : { args: request.args }),
        });
        const key = `${request.fromBlock}-${request.toBlock}`;
        const remaining = failures.get(key) ?? 0;
        if (remaining > 0) {
          failures.set(key, remaining - 1);
          throw new Error(`temporary ${key}`);
        }
        if (key !== '6-10') return [];
        return [
          duplicate,
          log({ blockNumber: 7n, transactionHash: txFor('c'), transactionIndex: null, logIndex: 1 }),
          duplicate,
        ];
      },
    };

    const result = await scanLogPages({
      client,
      address: ADDRESS,
      event: EVENT,
      args: { worldwideDay: 20260804 },
      fromBlock: 1n,
      toBlock: 12n,
      pageSize: 5,
      retryCount: 1,
      errorMessage: ({ fromBlock, toBlock }) => `scan failed ${fromBlock}-${toBlock}`,
    });

    expect(requests).toEqual([
      { fromBlock: 1n, toBlock: 5n, args: { worldwideDay: 20260804 } },
      { fromBlock: 6n, toBlock: 10n, args: { worldwideDay: 20260804 } },
      { fromBlock: 6n, toBlock: 10n, args: { worldwideDay: 20260804 } },
      { fromBlock: 11n, toBlock: 12n, args: { worldwideDay: 20260804 } },
    ]);
    expect(result.map((item) => (item as { logIndex: number }).logIndex)).toEqual([1, 3]);
  });

  it('raises a scoped error after exhausting retries', async () => {
    await expect(
      scanLogPages({
        client: {
          getLogs: async () => {
            throw new Error('offline');
          },
        },
        address: ADDRESS,
        event: EVENT,
        fromBlock: 1n,
        toBlock: 3n,
        pageSize: 2,
        retryCount: 1,
        errorMessage: ({ fromBlock, toBlock }) => `BidRevealed failed ${fromBlock}-${toBlock}`,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'LogPageScanError',
        fromBlock: 1n,
        toBlock: 2n,
        message: 'BidRevealed failed 1-2',
      } satisfies Partial<LogPageScanError>),
    );
  });

  it('honors abort signals before starting a page', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanLogPages({
        client: { getLogs: async () => [] },
        address: ADDRESS,
        event: EVENT,
        fromBlock: 1n,
        toBlock: 3n,
        pageSize: 2,
        retryCount: 0,
        signal: controller.signal,
        errorMessage: ({ fromBlock, toBlock }) => `scan failed ${fromBlock}-${toBlock}`,
      }),
    ).rejects.toBeInstanceOf(LogPageScanInterruptedError);
  });
});
