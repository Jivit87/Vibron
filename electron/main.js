/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

let mainWindow;
let nextProcess;
let nextServerUrl;
let nextServerPromise;

const isDev = !app.isPackaged;
app.setName('Viberon');

// Bug fix (Critical #1): Only disable the sandbox when explicitly requested
// for debugging. Leaving no-sandbox unconditionally enabled allows a
// compromised renderer to escape Chromium's process isolation.
if (process.env.DEBUG_NO_SANDBOX === 'true') {
  app.commandLine.appendSwitch('no-sandbox');
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false, // Don't show until ready-to-show to avoid blank flash
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    title: 'Viberon',
    backgroundColor: '#08080f'
  });
  mainWindow = window;

  // Show window only after the page has painted to avoid blank flicker
  window.once('ready-to-show', () => {
    window.show();
  });

  // Dev-mode: open DevTools and log renderer errors for debugging
  if (isDev) {
    window.webContents.openDevTools({ mode: 'detach' });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[Electron] did-fail-load: ${errorCode} ${errorDescription} at ${validatedURL}`);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Electron] render-process-gone:', details);
    });

    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      console.log(`[Renderer ${levels[level] || level}] ${message} (${sourceId}:${line})`);
    });
  }

  if (isDev) {
    window.loadURL('http://localhost:3000');
  } else {
    // Production: start Next.js server
    void startNextServer(window);
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    if (nextProcess && BrowserWindow.getAllWindows().length === 0) {
      killNextProcess();
    }
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    }

    attempt();
  });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve an open port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startNextServer(window) {
  if (nextServerUrl && nextProcess) {
    window.loadURL(nextServerUrl);
    return;
  }
  if (nextServerPromise) {
    const url = await nextServerPromise;
    window.loadURL(url);
    return;
  }

  nextServerPromise = startNextServerOnce();
  try {
    const url = await nextServerPromise;
    window.loadURL(url);
  } catch (error) {
    console.error('Next.js server did not become ready:', error);
  } finally {
    nextServerPromise = null;
  }
}

async function startNextServerOnce() {
  const nextDir = path.join(__dirname, '..');
  const nextCli = path.join(nextDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const userDataDir = app.getPath('userData');
  const port = await getAvailablePort();
  const serverUrl = `http://127.0.0.1:${port}`;

  nextProcess = spawn(process.execPath, [nextCli, 'start', '-p', String(port)], {
    cwd: nextDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VIBERON_STORE_DIR: userDataDir
    },
    stdio: 'inherit',
    detached: false  // Ensure child is tied to parent process lifetime
  });

  // Bug fix (Critical #2): Surface server startup errors rather than silently leaking
  nextProcess.on('error', (err) => {
    console.error('Failed to start Next.js server:', err);
    nextProcess = null;
    nextServerUrl = null;
  });

  nextProcess.on('exit', (code, signal) => {
    console.log(`Next.js server exited: code=${code}, signal=${signal}`);
    if (nextProcess) {
      nextProcess = null;
      nextServerUrl = null;
    }
  });

  // Bug fix (Critical #2): Apply a 30-second startup timeout so we don't hang
  // forever if the Next.js server fails to bind.
  try {
    await Promise.race([
      waitForServer(serverUrl),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Next.js server startup timed out after 30s')), 30_000)
      )
    ]);
  } catch (err) {
    killNextProcess();
    throw err;
  }

  nextServerUrl = serverUrl;
  return serverUrl;
}

/**
 * Gracefully terminate the Next.js child process.
 * Sends SIGTERM first; if the process has not exited after 5 s, sends SIGKILL.
 */
function killNextProcess() {
  if (!nextProcess) return;
  const proc = nextProcess;
  nextProcess = null;
  nextServerUrl = null;

  proc.kill('SIGTERM');

  const forceKill = setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, 5_000);

  proc.once('exit', () => clearTimeout(forceKill));
}

ipcMain.handle('viberon:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open folder in Viberon'
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('viberon:new-window', async () => {
  createWindow();
  return { ok: true };
});

ipcMain.handle('viberon:open-terminal', async (_event, cwd) => {
  // Bug fix (Critical #3): Validate the renderer-supplied cwd so a compromised
  // renderer cannot open a terminal in an arbitrary (e.g. system) directory.
  const homeDir = app.getPath('home');
  let workingDirectory = homeDir;

  if (typeof cwd === 'string' && cwd.length > 0) {
    const normalized = path.normalize(path.resolve(cwd));
    // Only allow directories that are within the user's home directory.
    if (normalized === homeDir || normalized.startsWith(`${homeDir}${path.sep}`)) {
      workingDirectory = normalized;
    } else {
      console.warn(`[viberon:open-terminal] Rejected path outside home dir: ${normalized}`);
    }
  }

  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', workingDirectory], {
        detached: true,
        stdio: 'ignore'
      }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], {
        cwd: workingDirectory,
        detached: true,
        stdio: 'ignore'
      }).unref();
    } else {
      spawn('x-terminal-emulator', ['--working-directory', workingDirectory], {
        detached: true,
        stdio: 'ignore'
      }).unref();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  killNextProcess();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  killNextProcess();
});
