import { isMacOS, isWindows } from './platform';

describe('isMacOS', () => {
  it('recognises the macOS webview', () => {
    expect(isMacOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(true);
  });

  it('is false on Linux and without a user agent', () => {
    expect(isMacOS('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(false);
    expect(isMacOS('')).toBe(false);
  });
});

describe('isWindows', () => {
  it('recognises the Windows webview', () => {
    expect(isWindows('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe(true);
  });

  it('is false on macOS, Linux and without a user agent', () => {
    expect(isWindows('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(false);
    expect(isWindows('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(false);
    expect(isWindows('')).toBe(false);
  });
});
