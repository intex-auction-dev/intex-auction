export const writeScenarioAfterAssertions = async ({ clear, build, write }) => {
  await clear();
  const summary = await build();
  await write(summary);
  return summary;
};
