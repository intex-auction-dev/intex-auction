import type { Abi, Address } from 'viem';

/**
 * Resolved deployment profiles: the addresses and reviewed ABIs the adapters read
 * through, after `runtime-config` has validated the config documents.
 *
 * These shapes live in `chain/` rather than beside the adapters because both sides
 * need them — `runtime-config` produces them and `auction` consumes them — and a type
 * owned by the consumer would force the lower layer to depend on the higher one.
 *
 * Deliberately named for what they describe rather than for a contract profile
 * revision: the addresses and ABIs are supplied per deployment, so the same shape
 * serves every reviewed profile.
 */
export interface OutbeDeploymentProfile {
  chainId: number;
  deploymentBlock: bigint;
  addresses: {
    metadosis: Address;
    desis: Address;
    originRouter: Address;
    oracle: Address;
    intex: Address;
  };
  abis: {
    metadosis: Abi;
    desis: Abi;
    originRouter: Abi;
    oracle: Abi;
    intex: Abi;
  };
}

export interface VenueDeploymentProfile {
  chainId: number;
  addresses: {
    intexAuction: Address;
    intexAuctionImplementation?: Address;
    escrowAdapter: Address;
    theCompact?: Address;
    targetRouter: Address;
    intexNFT1155: Address;
    paymentToken: Address;
  };
  abis: {
    intexAuction: Abi;
    escrowAdapter: Abi;
    targetRouter: Abi;
    intexNFT1155: Abi;
    paymentToken: Abi;
  };
}
