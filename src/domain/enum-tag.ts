/**
 * Resolves a contract enum tag to its domain value.
 *
 * Unknown tags throw rather than defaulting: a tag the reviewed ABI does not define
 * means the deployment disagrees with the embedded profile, which must surface as a
 * read failure instead of being flattened into a plausible neighbouring state.
 */
export const decodeEnumTag = <T>(label: string, tag: number, values: Readonly<Record<number, T>>): T => {
  const value = values[tag];
  if (value === undefined) throw new RangeError(`${label} has unsupported tag ${tag}.`);
  return value;
};
