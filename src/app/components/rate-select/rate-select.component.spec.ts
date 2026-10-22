import { TestBed } from '@angular/core/testing';
import { mockApi } from '../../testing/mock-api';
import { PLAYBACK_RATES, PlaybackStore } from '../../core/playback.store';
import { RateSelectComponent } from './rate-select.component';

describe('RateSelectComponent', () => {
  it('lists the speeds and changes the global one', async () => {
    const mock = mockApi({ setPlaybackRate: (rate: number) => Promise.resolve(rate) });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    const fixture = TestBed.createComponent(RateSelectComponent);
    fixture.componentRef.setInput('showLabel', false);
    fixture.detectChanges();
    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select.options).toHaveLength(PLAYBACK_RATES.length);
    expect(fixture.nativeElement.querySelector('label').classList).toContain('sr-only');

    select.value = '0.7';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(mock.argsOf('setPlaybackRate')).toEqual([0.7]);
    expect(TestBed.inject(PlaybackStore).rate()).toBe(0.7);
    fixture.detectChanges();
    expect(select.classList).toContain('text-accent');
  });
});
