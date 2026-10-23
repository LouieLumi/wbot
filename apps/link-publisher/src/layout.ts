export type ArticleImage = {url: string; alt: string};
export type ArticleBlock =
  | {kind: 'image'; image: ArticleImage}
  | {kind: 'paragraph' | 'heading' | 'list' | 'quote' | 'code'; text: string; level?: number; number?: number};
export type RichTranslation = {title: string; blocks: ArticleBlock[]};
export type ChannelPart = {content: string; images: ArticleImage[]};

export function splitText(text: string, maxBytes: number): string[] {
  const parts: string[] = []; let part = '', bytes = 0;
  for (const char of text) {
    const n = Buffer.byteLength(char);
    if (bytes + n > maxBytes) {
      let boundary = part.lastIndexOf('\n');
      if (boundary <= part.length / 2) boundary = part.lastIndexOf(' ');
      if (boundary > part.length / 2) {
        parts.push(part.slice(0, boundary + 1)); part = part.slice(boundary + 1);
      } else { parts.push(part); part = ''; }
      bytes = Buffer.byteLength(part);
    }
    part += char; bytes += n;
  }
  if (part) parts.push(part);
  return parts;
}

/** Keep the source DOM order. Images never go through the language model. */
export function extractBlocks(root: DocumentFragment, base: string, title: string,
  safeUrl: (url: string) => URL): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  type Style = {kind: 'paragraph' | 'heading' | 'list' | 'quote'; level?: number; number?: number};
  let buffer = '', style: Style = {kind: 'paragraph'};
  const flush = () => {
    const text = buffer.replace(/[\t \r\n]+/g, ' ').trim(); buffer = '';
    if (text && !(style.kind === 'heading' && text === title)) blocks.push({...style, text});
  };
  const image = (element: Element) => {
    const width = Number.parseInt(element.getAttribute('width') || '', 10);
    const height = Number.parseInt(element.getAttribute('height') || '', 10);
    if ((width >= 0 && width <= 2) || (height >= 0 && height <= 2)) return;
    const sets = [element.getAttribute('data-srcset'), element.getAttribute('srcset'),
      element.parentElement?.tagName === 'PICTURE' ? element.parentElement.querySelector('source')?.getAttribute('srcset') : null];
    const variants = sets.flatMap(set => (set || '').split(',').map(item => {
      const [url, size] = item.trim().split(/\s+/); return {url, size: Number.parseFloat(size || '0')};
    })).sort((a, b) => b.size - a.size).map(item => item.url);
    const candidates = [element.getAttribute('data-src'), element.getAttribute('data-original'),
      element.getAttribute('data-lazy-src'), ...variants, element.getAttribute('src')];
    for (const candidate of candidates) {
      if (!candidate || /^(data|blob|javascript):/i.test(candidate)) continue;
      try {
        const url = safeUrl(new URL(candidate, base).href).href;
        blocks.push({kind: 'image', image: {url, alt: (element.getAttribute('alt') || '').trim().slice(0, 500)}});
        return;
      } catch { /* Skip unsafe/invalid source attributes, not the other candidates. */ }
    }
  };
  const visit = (node: Node, context: Style) => {
    if (node.nodeType === 3) { buffer += node.textContent || ''; return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const element = node.nodeType === 1 ? node as Element : undefined, tag = element?.tagName || '';
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FORM', 'FOOTER'].includes(tag)) return;
    if (tag === 'IMG') { flush(); image(element!); return; }
    if (tag === 'BR') { buffer += '\n'; return; }
    if (tag === 'PRE') {
      flush(); const text = element!.textContent?.replace(/^\n|\n$/g, '') || '';
      if (text) blocks.push({kind: 'code', text}); return;
    }
    const boundary = /^(P|DIV|SECTION|ARTICLE|FIGURE|FIGCAPTION|H[1-6]|UL|OL|LI|BLOCKQUOTE|TR|HR)$/.test(tag);
    if (boundary) flush();
    let next = context;
    if (/^H[1-6]$/.test(tag)) next = {kind: 'heading', level: Math.min(3, Number(tag[1]) + 1)};
    if (tag === 'BLOCKQUOTE') next = {kind: 'quote'};
    if (tag === 'LI') {
      const parent = element!.parentElement;
      const siblings = parent ? [...parent.children].filter(e => e.tagName === 'LI') : [];
      next = {kind: 'list', number: parent?.tagName === 'OL'
        ? (Number.parseInt(parent.getAttribute('start') || '1', 10) || 1) + siblings.indexOf(element!) : undefined};
    }
    style = next;
    for (const child of node.childNodes) visit(child, next);
    if (boundary) flush();
    style = context;
  };
  visit(root, {kind: 'paragraph'}); flush();
  return blocks;
}

export const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}\[\]<>#!|~$])/g, '\\$1');
function renderBlock(block: Exclude<ArticleBlock, {kind: 'image'}>) {
  if (block.kind === 'code') {
    const runs = block.text.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `${fence}\n${block.text}\n${fence}`;
  }
  const text = escapeMarkdown(block.text.trim());
  if (block.kind === 'heading') return '#'.repeat(block.level || 2) + ' ' + text;
  if (block.kind === 'list') return (block.number === undefined ? '- ' : block.number + '. ') + text;
  if (block.kind === 'quote') return text.split('\n').map(line => '> ' + line).join('\n');
  return text;
}

/** Native topic images appear after their part's body; continue beneath that image. */
export function richChannelParts(sourceUrl: string, translation: RichTranslation): ChannelPart[] {
  const source = '\n\n原文：' + sourceUrl;
  const limit = 19_000 - Buffer.byteLength(source);
  const parts: ChannelPart[] = []; let current: ChannelPart = {content: '', images: []};
  const flush = () => {
    if (current.content || current.images.length) parts.push(current);
    current = {content: '', images: []};
  };
  const append = (text: string) => {
    if (current.images.length) flush();
    for (const chunk of splitText(text, limit)) {
      const separator = current.content ? '\n\n' : '';
      if (Buffer.byteLength(current.content + separator + chunk) > limit) flush();
      current.content += (current.content ? '\n\n' : '') + chunk;
    }
  };
  append('# ' + escapeMarkdown(translation.title));
  for (const block of translation.blocks) {
    if (block.kind !== 'image') {
      if (block.kind === 'code') {
        for (const text of splitText(block.text, Math.floor(limit / 3))) append(renderBlock({...block, text}));
      } else append(renderBlock(block));
      continue;
    }
    // One image per section retains the exact order if any download needs a link fallback.
    if (current.images.length) flush();
    const fallback = '\n\n配图：' + escapeMarkdown(block.image.alt) + '\n' + block.image.url;
    if (Buffer.byteLength(current.content + fallback) > limit) flush();
    current.images.push(block.image);
  }
  flush();
  parts[0]!.content += source;
  return parts.map((part, index) => ({...part, content: index === 0 ? part.content
    : `续文 ${index + 1}/${parts.length}\n\n` + part.content}));
}
