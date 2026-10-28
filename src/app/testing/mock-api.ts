import type { Provider } from '@angular/core';
import { TauriApiService } from '../core/tauri-api.service';

export interface ApiCall {
  cmd: string;
  args: unknown[];
}

type ApiOverrides = { -readonly [K in keyof TauriApiService]?: TauriApiService[K] };

/**
 * Mock of the IPC facade for tests. Every method is recorded in `calls`; the ones not given in
 * `overrides` resolve to `undefined`. `set` replaces a method in the middle of a test.
 */
export function mockApi(overrides: ApiOverrides = {}) {
  const calls: ApiCall[] = [];
  const impl: Record<string, unknown> = {
    available: true,
    onPlaybackProgress: () => Promise.resolve(() => undefined),
    fileSrc: (path: string) => `asset://localhost${path}`,
    ...overrides,
  };
  const api = new Proxy(impl, {
    get(target, prop) {
      // Not a thenable, so `await` and Angular's DI leave it alone.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const value = target[prop];
      if (prop in target && typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ cmd: prop, args });
        return typeof value === 'function' ? value(...args) : Promise.resolve(undefined);
      };
    },
  }) as unknown as TauriApiService;

  return {
    api,
    calls,
    names: () => calls.map((c) => c.cmd),
    /** Arguments of the latest call to `cmd`. */
    argsOf: (cmd: keyof TauriApiService) => calls.filter((c) => c.cmd === cmd).at(-1)?.args,
    count: (cmd: keyof TauriApiService) => calls.filter((c) => c.cmd === cmd).length,
    set<K extends keyof TauriApiService>(cmd: K, value: TauriApiService[K]) {
      impl[cmd] = value;
    },
    provider: { provide: TauriApiService, useValue: api } as Provider,
  };
}

export type MockApi = ReturnType<typeof mockApi>;

/** Lets pending promise callbacks (and the ones they chain) run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
