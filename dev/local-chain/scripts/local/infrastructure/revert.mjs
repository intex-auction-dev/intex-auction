const causeChain = (error) => {
  const result = [];
  let current = error;
  const seen = new Set();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = current.cause;
  }
  return result;
};

export const decodedContractError = (error) => {
  for (const item of causeChain(error)) {
    const data = item.data;
    if (typeof data !== 'object' || data === null) continue;
    if (typeof data.errorName !== 'string') continue;
    return {
      name: data.errorName,
      args: Array.isArray(data.args) ? data.args : [],
    };
  }
  return null;
};

const normalized = (value) => (typeof value === 'bigint' ? value.toString() : String(value));

export const assertContractRevert = async (action, expectedName, expectedArgs = undefined) => {
  try {
    await action();
  } catch (error) {
    const decoded = decodedContractError(error);
    if (decoded?.name !== expectedName) {
      throw new Error(`Expected ${expectedName}, received ${decoded?.name ?? error.message}.`, { cause: error });
    }
    if (expectedArgs !== undefined) {
      if (
        decoded.args.length !== expectedArgs.length ||
        decoded.args.some((value, index) => normalized(value) !== normalized(expectedArgs[index]))
      ) {
        throw new Error(
          `Expected ${expectedName}(${expectedArgs.map(normalized).join(',')}), received ${expectedName}(${decoded.args.map(normalized).join(',')}).`,
          { cause: error },
        );
      }
    }
    return decoded;
  }
  throw new Error(`Expected ${expectedName}, but the contract call succeeded.`);
};
