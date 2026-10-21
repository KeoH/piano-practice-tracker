import { isMacOS } from './platform';

describe('isMacOS', () => {
  it('recognises the macOS webview', () => {
    expect(isMacOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(true);
  });

  it('is false on Linux and without a user agent', () => {
    expect(isMacOS('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(false);
    expect(isMacOS('')).toBe(false);
  });
});
