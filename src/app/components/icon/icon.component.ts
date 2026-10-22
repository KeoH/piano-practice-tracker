import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'plus'
  | 'search'
  | 'cloud'
  | 'refresh'
  | 'settings'
  | 'play'
  | 'pause'
  | 'stop'
  | 'record'
  | 'trash'
  | 'metronome'
  | 'piano'
  | 'scissors'
  | 'chevron'
  | 'pin'
  | 'close'
  | 'copy'
  | 'external'
  | 'image'
  | 'music'
  | 'pencil'
  | 'more'
  | 'headphones'
  | 'check'
  | 'alert'
  | 'cloud-up'
  | 'cloud-check'
  | 'speaker'
  | 'arrow-right'
  | 'comment'
  | 'folder'
  | 'globe'
  | 'info'
  | 'undo'
  | 'repeat'
  | 'wand'
  | 'download'
  | 'roll'
  | 'bars'
  | 'chart'
  | 'book'
  | 'calendar'
  | 'flame'
  | 'target'
  | 'compare'
  | 'layers'
  | 'grip'
  | 'skip-back'
  | 'zoom-in'
  | 'zoom-out'
  | 'redo'
  | 'minus';

/** Inline SVG icons (1.75 stroke, inherit `currentColor`). */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', 'aria-hidden': 'true' },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @switch (name()) {
        @case ('plus') { <path d="M12 5v14M5 12h14" /> }
        @case ('minus') { <path d="M5 12h14" /> }
        @case ('info') { <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /> }
        @case ('search') { <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /> }
        @case ('folder') { <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z" /> }
        @case ('cloud') { <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5H7Z" /> }
        @case ('refresh') { <path d="M20 11a8 8 0 0 0-14.7-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16m0 4v-4h-4" /> }
        @case ('settings') {
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        }
        @case ('play') { <path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" /> }
        @case ('pause') { <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /> }
        @case ('stop') { <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /> }
        @case ('record') { <circle cx="12" cy="12" r="6.5" fill="currentColor" /> }
        @case ('trash') { <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /> }
        @case ('metronome') { <path d="M9 3h6l4 18H5L9 3ZM6.5 15h11M12 15l5-9" /> }
        @case ('piano') {
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M9 13v6M15 13v6M12 13v6M7.5 5v8h3V5M13.5 5v8h3V5" />
        }
        @case ('scissors') { <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.1 8.1 20 20M8.1 15.9 20 4" /> }
        @case ('chevron') { <path d="m9 6 6 6-6 6" /> }
        @case ('pin') { <path d="M12 21s-6-5.4-6-11a6 6 0 1 1 12 0c0 5.6-6 11-6 11Z" /><circle cx="12" cy="10" r="2" /> }
        @case ('close') { <path d="M6 6l12 12M18 6 6 18" /> }
        @case ('copy') { <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /> }
        @case ('external') { <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /> }
        @case ('image') { <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /> }
        @case ('music') { <path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /> }
        @case ('pencil') { <path d="M4 20h4L19 9l-4-4L4 16v4Z" /> }
        @case ('more') { <circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /> }
        @case ('headphones') { <path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="5" height="7" rx="1.5" /><rect x="16" y="14" width="5" height="7" rx="1.5" /> }
        @case ('check') { <path d="m5 12 5 5 9-10" /> }
        @case ('alert') { <circle cx="12" cy="12" r="9" /><path d="M12 7.5V13M12 16.5v.01" /> }
        @case ('cloud-up') { <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 8.9" /><path d="M12 13v7M9 16l3-3 3 3" /> }
        @case ('cloud-check') { <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9H7Z" /><path d="m9.5 13.5 2 2 3.5-3.5" /> }
        @case ('speaker') { <path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /> }
        @case ('arrow-right') { <path d="M5 12h14M13 6l6 6-6 6" /> }
        @case ('globe') { <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /> }
        @case ('undo') { <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /> }
        @case ('repeat') { <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /> }
        @case ('wand') { <path d="m15 4 5 5L9 20l-5-5L15 4ZM12.5 6.5l5 5M5 3v3M3.5 4.5h3M19 15v3M17.5 16.5h3" /> }
        @case ('download') { <path d="M12 4v11M7 10l5 5 5-5M5 20h14" /> }
        @case ('roll') { <path d="M4 6h5M11 10h6M6 14h4M13 18h7M15 6h3" /> }
        @case ('bars') { <path d="M5 20v-6M9.5 20V8M14 20v-9M18.5 20V4" /> }
        @case ('chart') { <path d="M4 4v16h16" /><path d="m8 15 3.5-4 3 2.5L19 8" /> }
        @case ('book') { <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v14H5.5A1.5 1.5 0 0 0 4 19.5v-14Z" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3M9 8h6" /> }
        @case ('calendar') { <rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /> }
        @case ('flame') { <path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-9-1.5 2-2 3.5-2 5-1-1-2-1.5-2.5-3C7.5 10 6 12.5 6 15a6 6 0 0 0 6 6Z" /> }
        @case ('target') { <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /> }
        @case ('compare') { <rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /> }
        @case ('layers') { <path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /> }
        @case ('grip') {
          <circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" />
        }
        @case ('skip-back') { <path d="M6 5v14" /><path d="M18 6v12l-9-6 9-6Z" fill="currentColor" /> }
        @case ('zoom-in') { <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6M11 8v6" /> }
        @case ('zoom-out') { <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /> }
        @case ('redo') { <path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /> }
        @case ('comment') { <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z" /> }
      }
    </svg>
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly size = input(16);
}
