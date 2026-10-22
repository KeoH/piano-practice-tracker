import { TestBed } from '@angular/core/testing';
import { ConfirmService } from './confirm.service';
import { I18nService } from './i18n/i18n.service';

describe('ConfirmService', () => {
  let confirm: ConfirmService;

  beforeEach(() => {
    TestBed.inject(I18nService).setLang('en');
    confirm = TestBed.inject(ConfirmService);
  });

  it('resolves with the answer and closes', async () => {
    const answer = confirm.ask({ title: 'Delete?', message: 'Gone for good' });
    expect(confirm.current()).toMatchObject({ title: 'Delete?', danger: true, confirmLabel: 'Confirm' });
    confirm.answer(true);
    expect(await answer).toBe(true);
    expect(confirm.current()).toBeNull();
    confirm.answer(false); // nothing open: ignored
  });

  it('cancels the open request when another one arrives', async () => {
    const first = confirm.ask({ title: 'A', message: '' });
    const second = confirm.ask({ title: 'B', message: '', confirmLabel: 'Go', danger: false });
    expect(await first).toBe(false);
    expect(confirm.current()).toMatchObject({ title: 'B', confirmLabel: 'Go', danger: false });
    confirm.answer(false);
    expect(await second).toBe(false);
  });
});
