import { Marked, type Tokens } from 'marked';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^\s*(javascript|vbscript|data):/i.test(h) && !/^data:image\//i.test(h)) return null;
  return h;
}

/**
 * Creates a safe Markdown renderer:
 * - Raw HTML (blocks and inline tags) is escaped instead of injected.
 * - Local images are rewritten with `resolveLocal` (asset protocol): paths relative to the vault
 *   (`media/…`, as the editor inserts them) and absolute ones (`/…`, old notes).
 * - `javascript:` links are blocked.
 */
export function createMarkdownRenderer(resolveLocal: (path: string) => string): (md: string) => string {
  const marked = new Marked({
    gfm: true,
    breaks: true,
    async: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      image({ href, title, text }: Tokens.Image): string {
        let src = safeHref(href ?? '') ?? '';
        if (isLocalPath(src)) src = resolveLocal(decodeSafe(src));
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text ?? '')}"${t} loading="lazy">`;
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link): string {
        const inner = this.parser.parseInline(tokens);
        const h = safeHref(href ?? '');
        if (!h) return inner;
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(h)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
      },
    },
  });
  return (md: string) => {
    try {
      return marked.parse(md ?? '', { async: false }) as string;
    } catch (err) {
      return `<pre>${escapeHtml(String(err))}</pre>`;
    }
  };
}

/** Local file path: absolute (`/…`) or relative without a scheme (`media/x.png`). */
function isLocalPath(src: string): boolean {
  if (!src || src.startsWith('//') || src.startsWith('#')) return false;
  return src.startsWith('/') || !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

function decodeSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Markdown link destination for a path (inside `<…>` if it contains spaces or parentheses). */
export function markdownDestination(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, encodeURIComponent)}>` : path;
}
