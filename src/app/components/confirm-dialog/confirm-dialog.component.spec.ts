import { TestBed } from '@angular/core/testing';
import { ConfirmService } from '../../core/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  function setup() {
    TestBed.inject(I18nService).setLang('en');
    const confirm = TestBed.inject(ConfirmService);
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    fixture.detectChanges();
    return { confirm, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows the open request and answers with the buttons', async () => {
    const { confirm, fixture, el } = setup();
    expect(el.querySelector('[role=alertdialog]')).toBeNull();

    const answer = confirm.ask({ title: 'Delete session?', message: 'It cannot be undone', confirmLabel: 'Delete' });
    fixture.detectChanges();
    expect(el.querySelector('#confirm-title')?.textContent).toBe('Delete session?');
    const buttons = el.querySelectorAll('button');
    expect(buttons[1].textContent?.trim()).toBe('Delete');
    expect(buttons[1].classList).toContain('btn-danger');
    buttons[1].click();
    expect(await answer).toBe(true);
    fixture.detectChanges();
    expect(el.querySelector('[role=alertdialog]')).toBeNull();
  });

  it('cancels with the backdrop, the cancel button and Escape', async () => {
    const { confirm, fixture, el } = setup();
    const open = () => {
      const p = confirm.ask({ title: 'T', message: 'M', danger: false });
      fixture.detectChanges();
      return p;
    };

    let answer = open();
    expect(el.querySelectorAll('button')[1].classList).toContain('btn-primary');
    (el.querySelector('.fixed') as HTMLElement).click();
    expect(await answer).toBe(false);

    answer = open();
    el.querySelectorAll('button')[0].click();
    expect(await answer).toBe(false);

    answer = open();
    el.querySelector('[role=alertdialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await answer).toBe(false);

    answer = open();
    (el.querySelector('[role=alertdialog]') as HTMLElement).click(); // a click inside does not close it
    expect(confirm.current()).not.toBeNull();
    confirm.answer(true);
    expect(await answer).toBe(true);
  });
});
