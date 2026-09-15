import { connect } from 'node:net';
import { RPC_PORT, RPC_URL } from './constants.mjs';

let requestId = 0;

export const rpc = async (method, params = [], url = RPC_URL) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message}`);
  return body.result;
};

export const waitForRpc = async (attempts = 80) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const chainId = Number.parseInt(await rpc('eth_chainId'), 16);
      if (chainId === 31337) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Anvil did not become ready on ${RPC_URL}.`);
};

export const isExpectedAnvil = async () => {
  try {
    const [chainIdHex, clientVersion] = await Promise.all([rpc('eth_chainId'), rpc('web3_clientVersion')]);
    return Number.parseInt(chainIdHex, 16) === 31337 && /anvil/i.test(clientVersion);
  } catch {
    return false;
  }
};

export const isPortOpen = (port = RPC_PORT, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
