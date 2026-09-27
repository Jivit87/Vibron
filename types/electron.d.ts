/** Bridge exposed by electron/preload.js. Absent when running in a browser. */
interface ViberonElectronAPI {
  isDesktop: true;
  openFolder: () => Promise<{ canceled: boolean; path?: string }>;
  newWindow: () => Promise<void>;
  openTerminal: (cwd?: string) => Promise<void>;
  /** Native OS notification (added by the preload; optional until then). */
  notify?: (input: { title: string; body?: string }) => void | Promise<void>;
}

interface Window {
  electronAPI?: ViberonElectronAPI;
}
