import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_HOST, APP_PORT, assertPortAvailable, listen } from './serve.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const runBuild = () =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmCommand, ['run', 'build'], {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Production build failed${signal ? ` (${signal})` : ` with exit code ${code}`}.`));
    });
  });

export const startApplication = async ({ build = true } = {}) => {
  await assertPortAvailable();
  if (build) {
    await runBuild();
  }
  return listen();
};

const isDirectExecution = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectExecution) {
  try {
    const server = await startApplication();
    console.log(`Intex Auction is available at http://${APP_HOST}:${APP_PORT}`);
    const close = () => server.close(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
