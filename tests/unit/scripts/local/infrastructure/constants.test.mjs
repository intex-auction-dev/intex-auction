import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const constantsUrl = pathToFileURL(resolve('dev/local-chain/scripts/local/infrastructure/constants.mjs')).href;
const probe = `import { RPC_PORT, RPC_URL, TESTER_WALLET_ADDRESS, TESTER_NATIVE_BALANCE } from ${JSON.stringify(constantsUrl)}; console.log(JSON.stringify({ RPC_PORT, RPC_URL, TESTER_WALLET_ADDRESS, TESTER_NATIVE_BALANCE: TESTER_NATIVE_BALANCE.toString() }));`;

describe('local RPC configuration', () => {
  it('accepts an isolated CI port', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
      env: { ...process.env, ITX_LOCAL_RPC_PORT: '18545', ITX_TESTER_WALLET_ADDRESS: '' },
    });

    expect(JSON.parse(output)).toEqual({
      RPC_PORT: 18545,
      RPC_URL: 'http://127.0.0.1:18545',
      // Neutral default: Anvil mnemonic account index 3, used when ITX_TESTER_WALLET_ADDRESS is unset.
      TESTER_WALLET_ADDRESS: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      TESTER_NATIVE_BALANCE: '100000000000000000000000',
    });
  });

  it('accepts a checksummed tester-wallet override', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
      env: { ...process.env, ITX_TESTER_WALLET_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
    });
    expect(JSON.parse(output).TESTER_WALLET_ADDRESS).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('rejects an invalid port', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
      env: { ...process.env, ITX_LOCAL_RPC_PORT: 'invalid' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ITX_LOCAL_RPC_PORT must be an integer between 1024 and 65535.');
  });
});
