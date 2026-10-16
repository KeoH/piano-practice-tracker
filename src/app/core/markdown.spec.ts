import { createMarkdownRenderer, escapeHtml, markdownDestination } from './markdown';

const render = createMarkdownRenderer((path) => `asset://localhost/vault/${path}`);

describe('escapeHtml', () => {
  it('escapes the HTML special characters', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;',
    );
  });
});

describe('createMarkdownRenderer', () => {
  it('renders regular Markdown', () => {
    const html = render('# Title\n\n**bold**');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('escapes raw HTML instead of injecting it', () => {
    const html = render('<script>alert(1)</script>\n\nText with <b onclick="x()">tag</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b onclick');
    expect(html).toContain('&lt;script&gt;');
  });

  it('blocks javascript: and data: links but keeps their text', () => {
    expect(render('[click](javascript:alert(1))')).not.toContain('href');
    expect(render('[click](data:text/html,hi)')).not.toContain('href');
    expect(render('[click](javascript:alert(1))')).toContain('click');
  });

  it('opens safe links in a new window', () => {
    expect(render('[docs](https://example.com)')).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('resolves local images against the vault', () => {
    expect(render('![score](media/score.png)')).toContain('src="asset://localhost/vault/media/score.png"');
    expect(render('![old](/home/me/old.png)')).toContain('src="asset://localhost/vault//home/me/old.png"');
  });

  it('decodes encoded local paths before resolving them', () => {
    expect(render('![s](media/my%20score.png)')).toContain('src="asset://localhost/vault/media/my score.png"');
  });

  it('leaves remote and data images alone', () => {
    expect(render('![r](https://example.com/a.png)')).toContain('src="https://example.com/a.png"');
    expect(render('![d](data:image/png;base64,AAAA)')).toContain('src="data:image/png;base64,AAAA"');
  });

  it('drops javascript: image sources', () => {
    expect(render('![x](javascript:alert(1))')).toContain('src=""');
  });

  it('escapes image alt text and titles', () => {
    const html = render('![a "quote"](media/a.png "t<i>")');
    expect(html).toContain('alt="a &quot;quote&quot;"');
    expect(html).toContain('title="t&lt;i&gt;"');
  });
});

describe('markdownDestination', () => {
  it('keeps simple paths as they are', () => {
    expect(markdownDestination('media/score.png')).toBe('media/score.png');
  });

  it('wraps paths with spaces or parentheses in angle brackets', () => {
    expect(markdownDestination('media/my score.png')).toBe('<media/my score.png>');
    expect(markdownDestination('media/a(1).png')).toBe('<media/a(1).png>');
  });

  it('encodes angle brackets inside the path', () => {
    expect(markdownDestination('media/<x>.png')).toBe('<media/%3Cx%3E.png>');
  });
});
