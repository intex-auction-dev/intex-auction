import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';

export const executableName = (name, platform = process.platform) => (platform === 'win32' ? `${name}.exe` : name);

export const findExecutable = async (name, options = {}) => {
  const platform = options.platform ?? process.platform;
  const candidate = executableName(name, platform);
  const pathEntries = (options.path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const fullPath = resolve(entry, candidate);
    try {
      await access(fullPath, fsConstants.X_OK);
      return fullPath;
    } catch {}
  }
  throw new Error(`${name} is required but was not found on PATH.`);
};

export const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.${detail}`);
  }
  return options.capture ? (result.stdout ?? '').trim() : '';
};

export const spawnDetached = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['ignore', options.stdout, options.stderr],
    windowsHide: true,
  });
  child.unref();
  return child;
};
