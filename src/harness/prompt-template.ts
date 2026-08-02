const PLACEHOLDER = /\{\{(?<name>[a-zA-Z][a-zA-Z0-9]*)\}\}/gu;

export const renderPromptTemplate = (
  template: string,
  values: Readonly<Record<string, string>>,
): string => {
  const used = new Set<string>();
  const rendered = template.replaceAll(PLACEHOLDER, (...args: unknown[]) => {
    const groups = args.at(-1) as { readonly name?: string } | undefined;
    const name = groups?.name;
    if (name === undefined || values[name] === undefined) {
      throw new Error(`Missing prompt template value for ${name ?? 'unknown placeholder'}`);
    }
    used.add(name);
    return values[name];
  });

  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`Unused prompt template values: ${unused.sort().join(', ')}`);
  }

  return rendered.trim();
};
