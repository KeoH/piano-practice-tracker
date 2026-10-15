/** Formatea milisegundos como `mm:ss` (o `mm:ss.d` con `withTenths`). Soporta >= 60 min (`mmm:ss`). */
export function formatMs(ms: number, withTenths = false): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  if (!withTenths) return base;
  const tenths = Math.floor((safe % 1000) / 100);
  return `${base}.${tenths}`;
}

/**
 * Parsea `mm:ss`, `mm:ss.d`, `h:mm:ss` o segundos sueltos a milisegundos.
 * Devuelve `null` si el texto no es válido.
 */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    const v = parseFloat(p);
    // Solo el último componente admite decimales
    if (i < parts.length - 1 && p.includes('.')) return null;
    total = total * 60 + v;
  }
  return Math.round(total * 1000);
}

/** Fecha corta legible a partir de ISO-8601 (o devuelve el texto si no es parseable). */
export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return d.toLocaleString('es-ES', opts);
}

/** Fecha larga con día de la semana: «Jueves, 15 de octubre de 2026 · 19:05». */
export function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `${capitalize(day)} · ${time}`;
}

/** Fecha compacta para listas: «jue 15 oct». */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(/[,.]/g, '');
}

/** Grupo de la lista lateral: «Esta semana», «Semana pasada» o el mes («Septiembre», «Marzo 2025»). */
export function dateGroupLabel(iso: string | null | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Sin fecha';
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // lunes
  if (d >= weekStart) return 'Esta semana';
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  if (d >= lastWeekStart) return 'Semana pasada';
  const month = capitalize(d.toLocaleDateString('es-ES', { month: 'long' }));
  return d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

/** «1 fragmento», «3 fragmentos», «sin fragmentos». */
export function plural(n: number, one: string, many: string, none?: string): string {
  if (n === 0 && none) return none;
  return `${n} ${n === 1 ? one : many}`;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Tiempo relativo breve ("hace 3 min"). */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'nunca';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Math.round((Date.now() - d.getTime()) / 1000);
  if (diff < 10) return 'ahora mismo';
  if (diff < 60) return `hace ${diff} s`;
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return formatDate(iso, true);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Extrae un mensaje legible de cualquier error (los comandos Tauri rechazan con string). */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
