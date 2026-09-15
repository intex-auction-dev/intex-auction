import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SRC = resolve(ROOT, 'src');

export const SRC_DIR = SRC;

/**
 * The layer contract for `src/`. Each key is a top-level directory under `src/`;
 * `mayImport` lists the only other top-level directories it is allowed to reach.
 *
 * Read it bottom-up: `domain` and `diagnostics` are leaves that depend on nothing,
 * everything else layers on top, and `app` sits at the surface. Any edge that is not
 * listed is a violation, so adding a new directory fails closed until it declares
 * its dependencies here.
 */
const LAYERS = {
  domain: { mayImport: [] },
  diagnostics: { mayImport: [] },
  chain: { mayImport: ['domain', 'diagnostics'] },
  persistence: { mayImport: ['domain', 'diagnostics'] },
  ui: { mayImport: ['domain', 'diagnostics', 'chain'] },
  protocol: { mayImport: ['domain', 'diagnostics', 'chain'] },
  'runtime-config': { mayImport: ['domain', 'diagnostics', 'chain', 'persistence'] },
  receipts: { mayImport: ['domain', 'diagnostics', 'chain', 'persistence', 'runtime-config'] },

  // wallet renders the receipt tooling that now lives in the `bidding` slice, and `bidding`
  // reads wallet connection state — the one remaining two-way edge, declared in
  // ALLOWED_MUTUAL_PAIRS below.
  wallet: {
    mayImport: ['domain', 'diagnostics', 'chain', 'persistence', 'runtime-config', 'receipts', 'ui', 'bidding'],
  },

  // The former flat `auction` directory, grouped into the slices its import graph already
  // formed. Read bottom-up: `oracle` and `demand` are leaves that only reach the platform
  // layers; `discovery` composes the public auction/calendar reads on top of them; `bidding`,
  // `completion` and `recovery` sit above that. Every edge below is a real import counted from
  // the graph, and there are no cycles between slices.

  // oracle: price chart, oracle conversions and the currency/FX presentation cluster
  // (currency-state, multi-currency-evidence). Consumed by discovery, bidding and completion.
  oracle: { mayImport: ['domain', 'diagnostics', 'chain', 'ui', 'protocol'] },
  // demand: the venue bid history and revealed-demand ladder. A leaf slice.
  demand: { mayImport: ['domain', 'diagnostics', 'chain', 'persistence', 'runtime-config', 'ui', 'protocol'] },
  // discovery: public auction/calendar views and their data loaders. Sits above demand + oracle.
  discovery: { mayImport: ['domain', 'diagnostics', 'chain', 'runtime-config', 'ui', 'protocol', 'oracle', 'demand'] },
  // bidding: commit/reveal/cancel, the bidder-action controller and receipt tooling. Reads the
  // public auction loaders (discovery) and the currency cluster (oracle), and drives wallet.
  bidding: {
    mayImport: [
      'domain',
      'diagnostics',
      'chain',
      'persistence',
      'runtime-config',
      'receipts',
      'ui',
      'wallet',
      'protocol',
      'discovery',
      'oracle',
    ],
  },
  // completion: settled-auction result cards. Reads the public loaders and the currency cluster.
  completion: { mayImport: ['domain', 'diagnostics', 'chain', 'ui', 'protocol', 'discovery', 'oracle'] },
  // recovery: commit-bond and escrow recovery. Sits on the platform layers only; the shared
  // gas helper it reuses now lives in `domain`, so there is no recovery -> bidding edge.
  recovery: {
    mayImport: ['domain', 'diagnostics', 'chain', 'persistence', 'runtime-config', 'ui', 'wallet', 'protocol'],
  },

  app: {
    mayImport: [
      'domain',
      'diagnostics',
      'chain',
      'persistence',
      'runtime-config',
      'receipts',
      'ui',
      'wallet',
      'protocol',
      'oracle',
      'demand',
      'discovery',
      'bidding',
      'completion',
      'recovery',
    ],
  },
};

/**
 * Directory pairs that are permitted to import each other. Every entry is a known
 * bidirectional coupling that the layer table above cannot express, and each one is a
 * standing invitation to break the tie properly.
 *
 * `wallet <-> bidding` is the last two-way edge. wallet/wallet-controls.tsx
 * renders bidding/receipt-tools.tsx (a presentation composition) while bidding reads
 * wallet connection state. Upgrade path: lift the receipt-tools composition into `app/`,
 * which already sits above both, then delete this allowance. (This is the same coupling the
 * former `wallet <-> auction` entry described; grouping only narrowed it to the owning slice.)
 */
const ALLOWED_MUTUAL_PAIRS = [['wallet', 'bidding']];

const SOURCE_PATTERN = /\.tsx?$/;

const collectSourceFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(full);
      return SOURCE_PATTERN.test(entry.name) ? [full] : [];
    }),
  );
  return found.flat();
};

// Matches `from '<spec>'` and bare `import '<spec>'` side-effect imports, plus
// `export ... from '<spec>'`. Only static specifiers can create a layer edge; the one
// dynamic import in src/ targets an external package, not an internal module.
const SPECIFIER_PATTERN = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const specifiersOf = (text) => [...text.matchAll(SPECIFIER_PATTERN)].map((match) => match[1]);

const isRelative = (specifier) => specifier.startsWith('.');

const layerOf = (absolutePath) => {
  const rel = relative(SRC, absolutePath);
  const [head, ...rest] = rel.split('/');
  return rest.length === 0 ? null : head;
};

const resolveImport = (fromFile, specifier) => {
  const base = resolve(fromFile, '..', specifier);
  return relative(SRC, base).split('/')[0];
};

const describe = (absolutePath) => relative(ROOT, absolutePath);

export const checkLayerEdges = (files, contents) => {
  const violations = [];
  const mutual = new Set(ALLOWED_MUTUAL_PAIRS.flatMap(([a, b]) => [`${a}->${b}`, `${b}->${a}`]));

  for (const file of files) {
    const from = layerOf(file);
    if (from === null) continue;

    const rules = LAYERS[from];
    if (rules === undefined) {
      violations.push(`${describe(file)}: directory "${from}" has no entry in the layer contract.`);
      continue;
    }

    for (const specifier of specifiersOf(contents.get(file))) {
      if (!isRelative(specifier)) continue;
      const to = resolveImport(file, specifier);
      if (to === from || to === undefined) continue;
      if (rules.mayImport.includes(to) || mutual.has(`${from}->${to}`)) continue;
      violations.push(`${describe(file)}: "${from}" must not import "${to}" (${specifier}).`);
    }
  }
  return violations;
};

export const buildFileGraph = (files, contents) => {
  const known = new Set(files);
  const graph = new Map();
  const candidates = (base) => [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];

  for (const file of files) {
    const edges = [];
    for (const specifier of specifiersOf(contents.get(file))) {
      if (!isRelative(specifier)) continue;
      const base = resolve(file, '..', specifier);
      const target = candidates(base).find((option) => known.has(option)) ?? (known.has(base) ? base : null);
      if (target !== null && target !== file) edges.push(target);
    }
    graph.set(file, edges);
  }
  return graph;
};

/**
 * Iterative depth-first search with an explicit stack. Recursion would be shorter but
 * would also cap the detectable module depth at the JS stack limit.
 */
export const findCycle = (graph) => {
  const UNVISITED = 0;
  const OPEN = 1;
  const DONE = 2;
  const state = new Map([...graph.keys()].map((node) => [node, UNVISITED]));

  for (const root of graph.keys()) {
    if (state.get(root) !== UNVISITED) continue;
    const path = [];
    const stack = [{ node: root, edges: [...(graph.get(root) ?? [])] }];
    state.set(root, OPEN);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.edges.shift();
      if (next === undefined) {
        state.set(frame.node, DONE);
        path.pop();
        stack.pop();
        continue;
      }
      if (state.get(next) === OPEN) return [...path.slice(path.indexOf(next)), next];
      if (state.get(next) === DONE) continue;
      state.set(next, OPEN);
      path.push(next);
      stack.push({ node: next, edges: [...(graph.get(next) ?? [])] });
    }
  }
  return null;
};

export const checkLayerBoundaries = async () => {
  const files = (await collectSourceFiles(SRC)).sort();
  const contents = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')])));

  const violations = checkLayerEdges(files, contents);
  const cycle = findCycle(buildFileGraph(files, contents));
  if (cycle !== null) {
    violations.push(`import cycle: ${cycle.map(describe).join(' -> ')}`);
  }
  return { fileCount: files.length, violations };
};

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const { fileCount, violations } = await checkLayerBoundaries();
  if (violations.length > 0) {
    console.error(`Layer boundary check failed with ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
  } else {
    console.error(`Layer boundaries hold across ${fileCount} source files; no import cycles.`);
  }
}
