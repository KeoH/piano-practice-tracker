import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let toast: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    toast = TestBed.inject(ToastService);
  });

  afterEach(() => vi.useRealTimers());

  it('shows toasts and dismisses them after their timeout', () => {
    toast.info('one');
    toast.success('two');
    expect(toast.toasts().map((t) => [t.kind, t.message])).toEqual([
      ['info', 'one'],
      ['success', 'two'],
    ]);
    vi.advanceTimersByTime(2500);
    expect(toast.toasts().map((t) => t.message)).toEqual(['one']);
    vi.advanceTimersByTime(1500);
    expect(toast.toasts()).toEqual([]);
  });

  it('skips a duplicate of the last toast and keeps at most five', () => {
    toast.warning('same');
    toast.warning('same');
    expect(toast.toasts()).toHaveLength(1);
    for (let i = 0; i < 6; i++) toast.show(`n${i}`, 'info', 0);
    expect(toast.toasts().map((t) => t.message)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });

  it('formats errors with a prefix', () => {
    toast.error(new Error('disk full'), 'Could not save');
    toast.error('plain');
    expect(toast.toasts().map((t) => [t.kind, t.message])).toEqual([
      ['error', 'Could not save: disk full'],
      ['error', 'plain'],
    ]);
    toast.dismiss(toast.toasts()[0].id);
    expect(toast.toasts()).toHaveLength(1);
  });
});
