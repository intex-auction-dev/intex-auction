import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { keccak256, encodeAbiParameters, getAddress } from 'viem';
import { CHAIN_ID, DEV_APP_ORIGIN, LAN_RPC_URL, LOCAL_CONFIG_ROOT, ROOT, RPC_URL } from './constants.mjs';

const quoteToken = (isoCode) =>
  getAddress(
    `0x${keccak256(
      encodeAbiParameters([{ type: 'string' }, { type: 'uint16' }], ['itx-acn.local.quote', isoCode]),
    ).slice(26)}`,
  );
const COEN = getAddress('0x0000000000000000000000000000000000000000');

const writeJson = async (path, value) => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

export const generateLocalConfig = async (deployment) => {
  await mkdir(resolve(LOCAL_CONFIG_ROOT, 'abi'), { recursive: true });
  await cp(resolve(ROOT, 'config/abi'), resolve(LOCAL_CONFIG_ROOT, 'abi'), {
    recursive: true,
    force: true,
  });
  await cp(
    resolve(ROOT, 'config/content-security-policy.json'),
    resolve(LOCAL_CONFIG_ROOT, 'content-security-policy.json'),
    { force: true },
  );

  const browserRpcUrl = RPC_URL;
  const walletRpcUrl = LAN_RPC_URL;

  await writeJson(resolve(LOCAL_CONFIG_ROOT, 'chains.json'), {
    schemaVersion: 1,
    originChainProfileId: 'local-outbe-origin',
    defaultDisconnectedVenueChainId: CHAIN_ID,
    chains: [
      {
        id: 'local-outbe-origin',
        roles: ['origin'],
        enabled: true,
        chainId: CHAIN_ID,
        name: 'Local Outbe Origin',
        nativeCurrency: { name: 'Local COEN', symbol: 'COEN', decimals: 18 },
        explorerUrl: null,
        developmentChain: true,
        rpcUrls: [browserRpcUrl],
        confirmationDepth: 1,
        logBatchSize: 2000,
        requestTimeoutMs: 5000,
        readRetryCount: 0,
      },
      {
        id: 'local-auction-venue',
        roles: ['venue'],
        enabled: true,
        chainId: CHAIN_ID,
        name: 'Localhost',
        nativeCurrency: { name: 'Local COEN', symbol: 'COEN', decimals: 18 },
        explorerUrl: null,
        developmentChain: true,
        rpcUrls: [browserRpcUrl],
        walletConnectRpcUrl: walletRpcUrl,
        confirmationDepth: 1,
        logBatchSize: 2000,
        requestTimeoutMs: 5000,
        readRetryCount: 0,
      },
    ],
  });

  await writeJson(resolve(LOCAL_CONFIG_ROOT, 'deployments.json'), {
    schemaVersion: 1,
    deployments: [
      {
        id: 'local-outbe-origin-deployment',
        roles: ['origin'],
        enabled: true,
        chainProfileId: 'local-outbe-origin',
        chainId: CHAIN_ID,
        deploymentBlock: deployment.deploymentBlock,
        addresses: {
          metadosis: deployment.controller,
          desis: deployment.controller,
          originRouter: deployment.originRouter,
          oracle: deployment.controller,
          intex: deployment.controller,
        },
        abiFiles: {
          metadosis: './abi/IMetadosis.json',
          desis: './abi/IDesis.json',
          originRouter: './abi/OriginRouter.json',
          oracle: './abi/IOracle.json',
          intex: './abi/IIntex.json',
        },
        oraclePair: { base: COEN, quote: quoteToken(840) },
      },
      {
        id: 'local-auction-venue-deployment',
        roles: ['venue'],
        enabled: true,
        chainProfileId: 'local-auction-venue',
        chainId: CHAIN_ID,
        deploymentBlock: deployment.deploymentBlock,
        addresses: {
          intexAuction: deployment.intexAuction,
          escrowAdapter: deployment.escrowAdapter,
          targetRouter: deployment.targetRouter,
          theCompact: deployment.theCompact,
          paymentToken: deployment.wcoen,
          intexNFT1155: deployment.intexNFT1155,
        },
        adapterProfile: 'multi-issuance-usd-reference',
        abiFiles: {
          intexAuction: './abi/IntexAuction.json',
          escrowAdapter: './abi/EscrowAdapter.json',
          targetRouter: './abi/TargetRouter.json',
          theCompact: './abi/TheCompact.json',
          paymentToken: './abi/ERC20.json',
          intexNFT1155: './abi/IntexNFT1155.json',
        },
      },
    ],
  });

  const committedWalletConnect = await readJson(resolve(ROOT, 'config/walletconnect.json')).catch(() => ({
    schemaVersion: 1,
    enabled: false,
    projectId: '',
  }));

  // The dev browser serves the app at DEV_APP_ORIGIN (127.0.0.1:5173). WalletConnect's runtime
  // validation requires metadata.url to equal the browser origin exactly, so the generated local
  // config uses the dev origin rather than the committed npm start origin (127.0.0.1:4173).
  await writeJson(
    resolve(LOCAL_CONFIG_ROOT, 'walletconnect.json'),
    deriveLocalWalletConnect(committedWalletConnect, DEV_APP_ORIGIN),
  );

  await writeJson(resolve(LOCAL_CONFIG_ROOT, 'timing.json'), {
    schemaVersion: 1,
    bidsFanInTimeoutSeconds: 43200,
  });
};

export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export { writeJson };

// Derives the local WalletConnect config from the committed config, rebinding metadata.url to the
// dev browser origin so the runtime validator (which requires metadata.url === location.origin)
// marks it usable. Icons are re-filtered to the dev origin. Pure and side-effect free for testing.
export const deriveLocalWalletConnect = (committed, applicationOrigin) => {
  const source = committed && typeof committed === 'object' ? committed : {};
  const enabled = source.enabled === true;
  const committedIcons = Array.isArray(source.metadata?.icons) ? source.metadata.icons : [];
  const icons = committedIcons.filter((icon) => {
    try {
      return new URL(icon).origin === new URL(applicationOrigin).origin;
    } catch {
      return false;
    }
  });
  return {
    schemaVersion: source.schemaVersion ?? 1,
    enabled,
    projectId: enabled ? (source.projectId ?? '') : '',
    metadata: {
      name: source.metadata?.name ?? 'Intex Auction',
      description: source.metadata?.description ?? 'Local bidder application',
      url: applicationOrigin,
      icons,
    },
  };
};
