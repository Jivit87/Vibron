/** Bridge exposed by electron/preload.js. Absent when running in a browser. */
interface ViberonElectronAPI {
  isDesktop: true;
  openFolder: () => Promise<{ canceled: boolean; path?: string }>;
  newWindow: () => Promise<void>;
  openTerminal: (cwd?: string) => Promise<void>;
}

interface Window {
  electronAPI?: ViberonElectronAPI;
}
