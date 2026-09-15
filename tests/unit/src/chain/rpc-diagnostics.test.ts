import { describe, expect, it } from 'vitest';
import type { Abi, AbiEvent, Address } from 'viem';
import { resetRpcDiagnostics, rpcDiagnosticsSnapshot, withRpcDiagnostics } from '@/chain/rpc-diagnostics';

const address = `0x${'1'.repeat(40)}` as Address;

describe('RPC diagnostics', () => {
  it('counts development RPC requests by component and method', async () => {
    resetRpcDiagnostics();
    const wrapped = withRpcDiagnostics(
      {
        async readContract(_request: { address: Address; abi: Abi; functionName: string }) {
          return 1;
        },
        async getLogs(_request: { address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint }) {
          return [];
        },
      },
      'venue-ladder',
    );

    await wrapped.readContract({
      address,
      abi: [] as Abi,
      functionName: 'getAuctionStage',
    });
    await wrapped.getLogs({
      address,
      event: { name: 'BidRevealed' } as AbiEvent,
      fromBlock: 1n,
      toBlock: 2n,
    });

    const snapshot = rpcDiagnosticsSnapshot();
    expect(snapshot.total).toBe(2);
    expect(snapshot.byComponent).toEqual([{ component: 'venue-ladder', count: 2, failures: 0 }]);
    expect(snapshot.byMethod).toEqual([
      { method: 'eth_call:getAuctionStage', count: 1, failures: 0 },
      { method: 'eth_getLogs:BidRevealed', count: 1, failures: 0 },
    ]);
    expect(snapshot.byComponentMethod).toContainEqual({
      component: 'venue-ladder',
      method: 'eth_call:getAuctionStage',
      count: 1,
      failures: 0,
    });
  });
});
