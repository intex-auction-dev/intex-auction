import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  SRC_DIR,
  buildFileGraph,
  checkLayerBoundaries,
  checkLayerEdges,
  findCycle,
} from '../../../../scripts/build/check-layer-boundaries.mjs';

const at = (relativePath) => resolve(SRC_DIR, relativePath);

const tree = (entries) => {
  const files = Object.keys(entries).map(at);
  const contents = new Map(files.map((file, index) => [file, Object.values(entries)[index]]));
  return { files, contents };
};

describe('layer boundary contract', () => {
  it('holds across the real src tree', async () => {
    const { fileCount, violations } = await checkLayerBoundaries();
    expect(violations).toEqual([]);
    expect(fileCount).toBeGreaterThan(50);
  });

  it('rejects a lower layer importing a higher one', () => {
    const { files, contents } = tree({
      'receipts/receipt-store.ts': "import { x } from '../bidding/commit-transaction';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([
      'src/receipts/receipt-store.ts: "receipts" must not import "bidding" (../bidding/commit-transaction).',
    ]);
  });

  it('rejects a type-only import that crosses a boundary', () => {
    const { files, contents } = tree({
      'domain/theme.ts': "import type { A } from '../chain/deployment-profile';",
    });
    expect(checkLayerEdges(files, contents)).toHaveLength(1);
  });

  it('allows a higher layer importing a lower one', () => {
    const { files, contents } = tree({
      'bidding/commit-view-model.ts': "import { x } from '../domain/escrow-lock';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([]);
  });

  it('allows a slice to import the protocol layer', () => {
    const { files, contents } = tree({
      'discovery/load-public-auction.ts': "import { OutbeAuctionAdapter } from '../protocol/origin-adapter';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([]);
  });

  it('rejects the protocol layer importing a feature slice', () => {
    const { files, contents } = tree({
      'protocol/venue-adapter.ts': "import { x } from '../bidding/commit-transaction';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([
      'src/protocol/venue-adapter.ts: "protocol" must not import "bidding" (../bidding/commit-transaction).',
    ]);
  });

  it('allows a slice to import the leaf slices it depends on', () => {
    const { files, contents } = tree({
      'discovery/public-discovery-view.tsx':
        "import { x } from '../demand/venue-demand-ladder'; import { y } from '../oracle/oracle-conversions';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([]);
  });

  it('rejects a leaf slice reaching up into a composing slice', () => {
    const { files, contents } = tree({
      'oracle/oracle-conversions.ts': "import { x } from '../discovery/load-public-auction';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([
      'src/oracle/oracle-conversions.ts: "oracle" must not import "discovery" (../discovery/load-public-auction).',
    ]);
  });

  it('allows the declared wallet <-> bidding mutual pair in both directions', () => {
    const { files, contents } = tree({
      'wallet/wallet-controls.tsx': "import { ReceiptTools } from '../bidding/receipt-tools';",
      'bidding/use-bidder-action-controller.ts': "import type { WalletState } from '../wallet/wallet-state';",
    });
    expect(checkLayerEdges(files, contents)).toEqual([]);
  });

  it('fails closed for a directory with no declared contract', () => {
    const { files, contents } = tree({
      'newthing/mod.ts': "import { x } from '../domain/theme';",
    });
    expect(checkLayerEdges(files, contents)[0]).toContain('no entry in the layer contract');
  });

  it('detects a two-module import cycle', () => {
    const { files, contents } = tree({
      'auction/a.ts': "import { b } from './b';",
      'auction/b.ts': "import { a } from './a';",
    });
    const cycle = findCycle(buildFileGraph(files, contents));
    expect(cycle).not.toBeNull();
    expect(cycle).toHaveLength(3);
  });

  it('does not flag a diamond as a cycle', () => {
    const { files, contents } = tree({
      'auction/top.ts': "import { l } from './left'; import { r } from './right';",
      'auction/left.ts': "import { b } from './base';",
      'auction/right.ts': "import { b } from './base';",
      'auction/base.ts': 'export const b = 1;',
    });
    expect(findCycle(buildFileGraph(files, contents))).toBeNull();
  });

  it('detects a cycle that closes through a third module', () => {
    const { files, contents } = tree({
      'auction/a.ts': "import { b } from './b';",
      'auction/b.ts': "import { c } from './c';",
      'auction/c.ts': "import { a } from './a';",
    });
    expect(findCycle(buildFileGraph(files, contents))).toHaveLength(4);
  });
});
