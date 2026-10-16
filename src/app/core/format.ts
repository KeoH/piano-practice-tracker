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
