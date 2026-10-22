import { TestBed } from '@angular/core/testing';
import { ToastService } from '../../core/toast.service';
import { ToastsComponent } from './toasts.component';

describe('ToastsComponent', () => {
  it('renders each kind with its tone and dismisses on click', () => {
    const toast = TestBed.inject(ToastService);
    const fixture = TestBed.createComponent(ToastsComponent);
    toast.show('info', 'info', 0);
    toast.show('saved', 'success', 0);
    toast.show('careful', 'warning', 0);
    toast.show('broken', 'error', 0);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const items = [...el.querySelectorAll('[aria-live] > div')];
    expect(items.map((n) => n.querySelector('p')?.textContent)).toEqual(['info', 'saved', 'careful', 'broken']);
    expect(items.map((n) => n.getAttribute('role'))).toEqual(['status', 'status', 'status', 'alert']);
    const dots = items.map((n) => n.querySelector('.dot')!.classList);
    ['bg-faint', 'bg-ok', 'bg-accent', 'bg-rec'].forEach((tone, i) => expect(dots[i]).toContain(tone));
    expect(items[3].classList).toContain('border-rec/40');

    (items[3].querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(toast.toasts().map((t) => t.message)).toEqual(['info', 'saved', 'careful']);
  });
});
