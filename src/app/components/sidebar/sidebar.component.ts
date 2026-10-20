import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MessageKey } from '../../core/i18n/languages';
import type { SessionSummaryDto } from '../../core/models';
import { NavStore, type AppView } from '../../core/nav.store';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { VaultStore } from '../../core/vault.store';
import { IconComponent, type IconName } from '../icon/icon.component';

const NAV_ITEMS: { view: AppView; label: MessageKey; icon: IconName }[] = [
  { view: 'sessions', label: 'nav.sessions', icon: 'calendar' },
  { view: 'stats', label: 'nav.stats', icon: 'chart' },
];

@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  host: { class: 'flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-ink-950' },
  templateUrl: './sidebar.component.html',
})
export class SidebarComponent {
  protected readonly store = inject(SessionStore);
  protected readonly rec = inject(RecordingStore);
  protected readonly vault = inject(VaultStore);
  protected readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);
  protected readonly nav = inject(NavStore);
  protected readonly navItems = NAV_ITEMS;

  protected readonly formatMs = formatMs;

  protected readonly totalCount = computed(() => this.store.sessions().length);

  /** Sessions grouped by week / month, keeping the list order. */
  protected readonly groups = computed(() => {
    const now = new Date();
    const groups: { label: string; items: SessionSummaryDto[] }[] = [];
    for (const s of this.store.filteredSessions()) {
      const label = this.i18n.dateGroup(s.session_date || s.updated_at, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(s);
      else groups.push({ label, items: [s] });
    }
    return groups;
  });

  /** State of the chosen keyboard for the sidebar footer. */
  protected readonly port = computed(() => {
    const p = this.rec.selectedPort();
    if (!p) {
      return this.rec.ports().length
        ? { detail: this.i18n.t('sidebar.port.notFound'), ok: false }
        : { detail: this.i18n.t('sidebar.port.none'), ok: false };
    }
    if (p.is_virtual) return { detail: this.i18n.t('sidebar.port.virtual'), ok: false };
    return { detail: this.i18n.t('sidebar.port.connected'), ok: true };
  });

  protected select(s: SessionSummaryDto): void {
    if (this.rec.isRecording() && this.rec.recordingSessionId() !== s.id) {
      this.toast.warning(this.i18n.t('sidebar.stopToSwitch'));
      return;
    }
    this.nav.view.set('sessions');
    void this.store.select(s.id);
  }

  protected newSession(): void {
    if (this.rec.isRecording()) {
      this.toast.warning(this.i18n.t('sidebar.stopToCreate'));
      return;
    }
    this.nav.view.set('sessions');
    void this.store.create();
  }
}
