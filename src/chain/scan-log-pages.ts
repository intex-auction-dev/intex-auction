import type { AbiEvent, Address } from 'viem';

export interface LogPageReadClient {
  getLogs(request: {
    readonly address: Address;
    readonly event: AbiEvent;
    readonly args?: Readonly<Record<string, unknown>>;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly unknown[]>;
}

export interface LogPageRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export class LogPageScanError extends Error {
  constructor(
    message: string,
    readonly fromBlock: bigint,
    readonly toBlock: bigint,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LogPageScanError';
  }
}

export class LogPageScanInterruptedError extends Error {
  constructor(message = 'Log page scan was interrupted.') {
    super(message);
    this.name = 'LogPageScanInterruptedError';
  }
}

export interface ScanLogPagesInput<T = unknown> {
  readonly client: LogPageReadClient;
  readonly address: Address;
  readonly event: AbiEvent;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly pageSize: number;
  readonly retryCount: number;
  readonly signal?: AbortSignal;
  readonly errorMessage: (range: LogPageRange) => string;
  readonly decodeLog?: (log: unknown) => Promise<T> | T;
  readonly resultKey?: (value: T) => string;
  readonly compare?: (left: T, right: T) => number;
}

const checkedSignal = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new LogPageScanInterruptedError();
};

const asBigint = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
};

const asSafeNumber = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const parsed = asBigint(value);
  return parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
};

const rawLogKey = (value: unknown): string => {
  const raw = value as { blockNumber?: unknown; transactionHash?: unknown; logIndex?: unknown };
  return `${String(raw.blockNumber)}:${String(raw.transactionHash).toLowerCase()}:${String(raw.logIndex)}`;
};

const compareRawLogs = (left: unknown, right: unknown): number => {
  const leftRaw = left as { blockNumber?: unknown; transactionIndex?: unknown; logIndex?: unknown };
  const rightRaw = right as { blockNumber?: unknown; transactionIndex?: unknown; logIndex?: unknown };
  const leftBlock = asBigint(leftRaw.blockNumber);
  const rightBlock = asBigint(rightRaw.blockNumber);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  const leftTransaction = asSafeNumber(leftRaw.transactionIndex) ?? Number.MAX_SAFE_INTEGER;
  const rightTransaction = asSafeNumber(rightRaw.transactionIndex) ?? Number.MAX_SAFE_INTEGER;
  if (leftTransaction !== rightTransaction) return leftTransaction - rightTransaction;
  return (
    (asSafeNumber(leftRaw.logIndex) ?? Number.MAX_SAFE_INTEGER) -
    (asSafeNumber(rightRaw.logIndex) ?? Number.MAX_SAFE_INTEGER)
  );
};

const readPage = async <T>(input: ScanLogPagesInput<T>, range: LogPageRange): Promise<readonly T[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= input.retryCount; attempt += 1) {
    checkedSignal(input.signal);
    try {
      const request =
        input.args === undefined
          ? {
              address: input.address,
              event: input.event,
              fromBlock: range.fromBlock,
              toBlock: range.toBlock,
            }
          : {
              address: input.address,
              event: input.event,
              args: input.args,
              fromBlock: range.fromBlock,
              toBlock: range.toBlock,
            };
      const logs = await input.client.getLogs(request);
      checkedSignal(input.signal);
      const uniqueLogs = new Map<string, unknown>();
      for (const log of logs) uniqueLogs.set(rawLogKey(log), log);
      const ordered = [...uniqueLogs.values()].sort(compareRawLogs);
      if (!input.decodeLog) return ordered as readonly T[];
      return await Promise.all(ordered.map(input.decodeLog));
    } catch (error) {
      if (error instanceof LogPageScanInterruptedError) throw error;
      lastError = error;
    }
  }
  throw new LogPageScanError(input.errorMessage(range), range.fromBlock, range.toBlock, { cause: lastError });
};

export const scanLogPages = async <T = unknown>(input: ScanLogPagesInput<T>): Promise<readonly T[]> => {
  if (input.fromBlock > input.toBlock) return [];
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0) {
    throw new RangeError('Log scan page size must be a positive safe integer.');
  }
  const logs = new Map<string, T>();
  const key = input.resultKey ?? rawLogKey;
  const compare = input.compare ?? compareRawLogs;
  const pageSize = BigInt(input.pageSize);
  for (let pageStart = input.fromBlock; pageStart <= input.toBlock; pageStart += pageSize) {
    checkedSignal(input.signal);
    const pageEnd = pageStart + pageSize - 1n < input.toBlock ? pageStart + pageSize - 1n : input.toBlock;
    for (const log of await readPage(input, { fromBlock: pageStart, toBlock: pageEnd })) {
      logs.set(key(log), log);
    }
  }
  return [...logs.values()].sort(compare);
};
