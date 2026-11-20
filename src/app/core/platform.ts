/**
 * The webview runs on macOS (WebKit says `Macintosh` there). Only for platform-specific hints,
 * such as how to get a SoundFont; behaviour that depends on the OS belongs in the backend.
 */
export function isMacOS(userAgent: string = globalThis.navigator?.userAgent ?? ''): boolean {
  return userAgent.includes('Macintosh');
}

/** The webview runs on Windows (WebView2 says `Windows NT`). Same restriction as `isMacOS`. */
export function isWindows(userAgent: string = globalThis.navigator?.userAgent ?? ''): boolean {
  return userAgent.includes('Windows');
}
