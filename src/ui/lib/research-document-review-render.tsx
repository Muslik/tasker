const SAFE_BLOCK_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

const PASSTHROUGH_TAGS = new Set([
  'ac:layout',
  'ac:layout-cell',
  'ac:layout-section',
  'ac:link-body',
  'ac:plain-text-body',
  'ac:plain-text-link-body',
  'ac:rich-text-body',
]);

const DROP_CONTENT_TAGS = new Set(['embed', 'iframe', 'math', 'object', 'script', 'style', 'svg']);
const VOID_TAGS = new Set(['br', 'hr']);

export const renderResearchDocumentHtml = (storageHtml: string): string => {
  const normalized = normalizeStorageMarkup(storageHtml);
  if (typeof DOMParser === 'undefined') return sanitizeFallbackHtml(normalized);

  const document = new DOMParser().parseFromString(`<body>${normalized}</body>`, 'text/html');
  return Array.from(document.body.childNodes)
    .map((node) => renderNode(node))
    .join('');
};

const normalizeStorageMarkup = (input: string): string => {
  let output = input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, '$1');
  output = output.replace(/<ac:structured-macro\b([^>]*)\/>/giu, (_, attributes: string) =>
    macroPlaceholder(attributes, ''),
  );
  for (let index = 0; index < 50 && /<ac:structured-macro\b/iu.test(output); index += 1) {
    const next = output.replace(
      /<ac:structured-macro\b([^>]*)>([\s\S]*?)<\/ac:structured-macro>/giu,
      (_, attributes: string, body: string) => macroPlaceholder(attributes, body),
    );
    if (next === output) break;
    output = next;
  }
  output = output.replace(
    /<ac:structured-macro\b([^>]*)>([\s\S]*)$/iu,
    (_, attributes: string, body: string) => macroPlaceholder(attributes, body),
  );
  output = output.replace(/<ac:image\b[\s\S]*?<\/ac:image>/giu, '<p><em>[Image]</em></p>');
  output = output.replace(/<ri:attachment\b[^>]*\/>/giu, '');
  return output;
};

const macroPlaceholder = (attributes: string, body: string): string => {
  const name = readAttribute(attributes, 'ac:name') ?? 'macro';
  const richBody = body.match(/<ac:rich-text-body\b[^>]*>([\s\S]*?)<\/ac:rich-text-body>/iu)?.[1];
  const plainBody = body.match(
    /<ac:plain-text-body\b[^>]*>([\s\S]*?)<\/ac:plain-text-body>/iu,
  )?.[1];
  const content = richBody ?? plainBody ?? body.replace(/<\/?ac:[^>]+>/giu, '');
  return `<div><p><strong>Macro:</strong> ${escapeHtml(name)}</p>${content}</div>`;
};

const readAttribute = (source: string, name: string): string | null => {
  const match = source.match(
    new RegExp(`${escapeForRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu'),
  );
  return match?.[2] ?? match?.[3] ?? null;
};

const renderNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  return renderElement(node as Element);
};

const renderElement = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style') return '';
  if (tag === 'ac:link') return renderConfluenceLink(element);
  if (tag === 'ac:image') return '<p><em>[Image]</em></p>';
  if (tag === 'ri:page' || tag === 'ri:url') return escapeHtml(linkTargetFrom(element) ?? '');
  if (PASSTHROUGH_TAGS.has(tag)) return renderChildren(element);
  if (!SAFE_BLOCK_TAGS.has(tag)) return renderChildren(element);
  if (tag === 'a') return renderAnchor(element);
  return `<${tag}>${renderChildren(element)}</${tag}>`;
};

const renderChildren = (element: Element): string =>
  Array.from(element.childNodes)
    .map((child) => renderNode(child))
    .join('');

const renderConfluenceLink = (element: Element): string => {
  const label = renderChildren(element).trim();
  const target = linkTargetFrom(element);
  if (target === null || !isSafeHref(target))
    return label.length === 0 ? '' : `<span>${label}</span>`;
  const text = label.length === 0 ? escapeHtml(target) : label;
  return `<a href="${escapeHtmlAttribute(target)}" rel="noreferrer" target="_blank">${text}</a>`;
};

const renderAnchor = (element: Element): string => {
  const href = element.getAttribute('href');
  const text = renderChildren(element);
  if (href === null || !isSafeHref(href)) return text;
  return `<a href="${escapeHtmlAttribute(href)}" rel="noreferrer" target="_blank">${text}</a>`;
};

const linkTargetFrom = (element: Element): string | null => {
  if (element.tagName.toLowerCase() === 'ri:url') {
    return (
      element.getAttribute('ri:value') ?? element.getAttribute('data-linked-resource-default-alias')
    );
  }
  if (element.tagName.toLowerCase() === 'ri:page') {
    const title = element.getAttribute('ri:content-title');
    return title === null ? null : `#${title}`;
  }
  for (const child of Array.from(element.children)) {
    const target = linkTargetFrom(child);
    if (target !== null) return target;
  }
  return null;
};

const isSafeHref = (href: string): boolean =>
  /^(https?:|mailto:|\/|#)/iu.test(href) && !/^javascript:/iu.test(href);

const sanitizeFallbackHtml = (input: string): string => {
  const state: {
    output: string[];
    stack: { name: string; outputTag: string | null; suppressText: boolean }[];
  } = {
    output: [],
    stack: [],
  };
  for (const token of tokenizeHtml(input)) {
    const suppressing = state.stack.some((entry) => entry.suppressText);
    if (token.kind === 'text') {
      if (!suppressing) state.output.push(escapeHtml(token.value));
      continue;
    }
    if (token.kind === 'close') {
      closeTag(state, token.name);
      continue;
    }
    if (DROP_CONTENT_TAGS.has(token.name)) {
      if (!token.selfClosing) {
        state.stack.push({ name: token.name, outputTag: null, suppressText: true });
      }
      continue;
    }
    if (suppressing) {
      if (!token.selfClosing) {
        state.stack.push({ name: token.name, outputTag: null, suppressText: true });
      }
      continue;
    }
    if (token.name === 'a') {
      const href = readAttribute(token.attributes, 'href');
      if (!token.selfClosing && href !== null && isSafeHref(href)) {
        state.output.push(
          `<a href="${escapeHtmlAttribute(href)}" rel="noreferrer" target="_blank">`,
        );
        state.stack.push({ name: token.name, outputTag: 'a', suppressText: false });
      } else if (!token.selfClosing) {
        state.stack.push({ name: token.name, outputTag: null, suppressText: false });
      }
      continue;
    }
    if (PASSTHROUGH_TAGS.has(token.name) || !SAFE_BLOCK_TAGS.has(token.name)) {
      if (!token.selfClosing) {
        state.stack.push({ name: token.name, outputTag: null, suppressText: false });
      }
      continue;
    }
    if (token.selfClosing || VOID_TAGS.has(token.name)) {
      state.output.push(`<${token.name}>`);
      continue;
    }
    state.output.push(`<${token.name}>`);
    state.stack.push({ name: token.name, outputTag: token.name, suppressText: false });
  }
  while (state.stack.length > 0) {
    const entry = state.stack.pop();
    if (entry?.outputTag !== null && entry !== undefined) {
      state.output.push(`</${entry.outputTag}>`);
    }
  }
  return state.output.join('');
};

const closeTag = (
  state: {
    output: string[];
    stack: { name: string; outputTag: string | null; suppressText: boolean }[];
  },
  name: string,
): void => {
  for (let index = state.stack.length - 1; index >= 0; index -= 1) {
    const entry = state.stack[index];
    if (entry === undefined) continue;
    state.stack.splice(index);
    if (entry.outputTag !== null) state.output.push(`</${entry.outputTag}>`);
    if (entry.name === name) break;
  }
};

const tokenizeHtml = (
  input: string,
): readonly (
  | { kind: 'text'; value: string }
  | { kind: 'open'; name: string; attributes: string; selfClosing: boolean }
  | { kind: 'close'; name: string }
)[] => {
  const tokens: (
    | { kind: 'text'; value: string }
    | { kind: 'open'; name: string; attributes: string; selfClosing: boolean }
    | { kind: 'close'; name: string }
  )[] = [];
  for (const part of input.split(/(<[^>]+>)/gu)) {
    if (part.length === 0) continue;
    const closing = part.match(/^<\s*\/\s*([a-z0-9:_-]+)\s*>$/iu);
    if (closing !== null) {
      const [, name] = closing;
      if (name === undefined) continue;
      tokens.push({ kind: 'close', name: name.toLowerCase() });
      continue;
    }
    const opening = part.match(/^<\s*([a-z0-9:_-]+)\b([^>]*)\s*(\/?)>$/iu);
    if (opening !== null) {
      const [, name, attributes = '', selfClosing = ''] = opening;
      if (name === undefined) continue;
      tokens.push({
        kind: 'open',
        name: name.toLowerCase(),
        attributes,
        selfClosing: selfClosing === '/',
      });
      continue;
    }
    tokens.push({ kind: 'text', value: part });
  }
  return tokens;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const escapeHtmlAttribute = (value: string): string => escapeHtml(value).replaceAll("'", '&#39;');

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
