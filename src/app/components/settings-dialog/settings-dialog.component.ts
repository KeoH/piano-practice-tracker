import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { RecordingStore } from '../../core/recording.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { VaultStore } from '../../core/vault.store';
import { IconComponent } from '../icon/icon.component';
import { LanguageSelectComponent } from '../language-select/language-select.component';
import { SoundfontSettingsComponent } from '../soundfont-settings/soundfont-settings.component';

/** Settings modal with three sections: general (language), sound (SoundFont) and vault (where the data is stored). */
@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SoundfontSettingsComponent, LanguageSelectComponent, TranslatePipe],
  templateUrl: './settings-dialog.component.html',
})
export class SettingsDialogComponent {
  protected readonly vault = inject(VaultStore);
  protected readonly rec = inject(RecordingStore);
  protected readonly api = inject(TauriApiService);

  protected readonly tab = signal<'general' | 'sound' | 'vault'>('general');

  protected close(): void {
    this.vault.settingsOpen.set(false);
  }

  protected async openOther(): Promise<void> {
    await this.vault.pickAndOpen();
  }

  protected async openRecent(path: string): Promise<void> {
    await this.vault.open(path);
  }
}
