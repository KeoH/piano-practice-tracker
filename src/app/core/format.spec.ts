import { clamp, errorMessage, formatMs, parseTime } from './format';

describe('formatMs', () => {
  it('formats as mm:ss', () => {
    expect(formatMs(0)).toBe('00:00');
    expect(formatMs(65_000)).toBe('01:05');
    expect(formatMs(65_999)).toBe('01:05');
  });

  it('supports an hour or more as minutes', () => {
    expect(formatMs(61 * 60_000 + 7_000)).toBe('61:07');
    expect(formatMs(100 * 60_000)).toBe('100:00');
  });

  it('adds tenths when asked', () => {
    expect(formatMs(65_432, true)).toBe('01:05.4');
    expect(formatMs(65_099, true)).toBe('01:05.0');
  });

  it('treats negative and non-finite values as zero', () => {
    expect(formatMs(-1_000)).toBe('00:00');
    expect(formatMs(Number.NaN)).toBe('00:00');
    expect(formatMs(Number.POSITIVE_INFINITY, true)).toBe('00:00.0');
  });
});

describe('parseTime', () => {
  it('parses plain seconds', () => {
    expect(parseTime('42')).toBe(42_000);
    expect(parseTime('1.5')).toBe(1_500);
  });

  it('parses mm:ss and mm:ss.d', () => {
    expect(parseTime('01:05')).toBe(65_000);
    expect(parseTime('1:05.4')).toBe(65_400);
    expect(parseTime(' 2:00 ')).toBe(120_000);
  });

  it('parses h:mm:ss', () => {
    expect(parseTime('1:02:03')).toBe(3_723_000);
  });

  it('accepts decimals only in the last component', () => {
    expect(parseTime('1.5:00')).toBeNull();
    expect(parseTime('1:2.5:00')).toBeNull();
  });

  it('rejects invalid text', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('   ')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:')).toBeNull();
    expect(parseTime('-5')).toBeNull();
    expect(parseTime('1:2:3:4')).toBeNull();
  });
});

describe('clamp', () => {
  it('keeps values inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('errorMessage', () => {
  it('returns strings as they are', () => {
    expect(errorMessage('No vault is open')).toBe('No vault is open');
  });

  it('uses the message of an Error or an object with a message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage({ message: 'from ipc' })).toBe('from ipc');
  });

  it('serializes anything else', () => {
    expect(errorMessage({ code: 3 })).toBe('{"code":3}');
    expect(errorMessage({ message: 42 })).toBe('{"message":42}');
  });

  it('falls back to String() when it cannot serialize', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(errorMessage(cyclic)).toBe('[object Object]');
  });
});
