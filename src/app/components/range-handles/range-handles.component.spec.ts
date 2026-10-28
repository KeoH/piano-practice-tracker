import { TestBed } from '@angular/core/testing';
import { TimelineDrag } from '../../core/timeline-drag';
import { RangeHandlesComponent } from './range-handles.component';

describe('RangeHandlesComponent', () => {
  function setup(durationMs: number) {
    const drag = new TimelineDrag({ track: () => undefined, durationMs: () => durationMs, locked: () => false, onSeek: () => undefined });
    drag.selection.set({ start: 2500, end: 7500 });
    const fixture = TestBed.createComponent(RangeHandlesComponent);
    fixture.componentRef.setInput('range', { start: 2500, end: 7500 });
    fixture.componentRef.setInput('durationMs', durationMs);
    fixture.componentRef.setInput('drag', drag);
    fixture.componentRef.setInput('startLabel', 'Start');
    fixture.componentRef.setInput('endLabel', 'End');
    fixture.detectChanges();
    const handles = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[role=slider]')];
    return { drag, handles };
  }

  it('places both handles and describes them as sliders', () => {
    const { handles } = setup(10_000);
    expect(handles.map((h) => h.style.left)).toEqual(['25%', '75%']);
    expect(handles.map((h) => h.getAttribute('aria-label'))).toEqual(['Start', 'End']);
    expect(handles[0].getAttribute('aria-valuemax')).toBe('7500');
    expect(handles[1].getAttribute('aria-valuemax')).toBe('10000');
    expect(handles[0].getAttribute('aria-valuetext')).toBe('00:02.5');
  });

  it('moves a handle with the keyboard', () => {
    const { drag, handles } = setup(10_000);
    handles[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(drag.selection()).toEqual({ start: 2500, end: 7600 });
  });

  it('puts the handles at the start without a duration', () => {
    const { handles } = setup(0);
    expect(handles.map((h) => h.style.left)).toEqual(['0%', '0%']);
  });
});
