const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { startBand } = require('./band');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay, ctl;
let glowOn = false, bandOn = false, sparklesOn = false, wordsOn = true;
let overlayReady = false;
let spawnQueued = false;

const MAX_SPOKEN = 300; // longest spoken text typed (chars)
const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

const MAC_RELEASE = 'key up {control, shift, option, command}';
const MAC_RELEASE_SCRIPT = `tell application "System Events" to ${MAC_RELEASE}`;
const OSA_OPTS = { timeout: 5000 };

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        `  ${MAC_RELEASE}`,
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], OSA_OPTS, err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('xdotool', ['key', '--clearmodifiers', 'alt+Tab'], err => {
        if (err) {
          console.warn('refocus previous app (Alt+Tab) failed. Install xdotool:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('opencheer: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

// macOS uses the template PNG (icon/Template.png + @2x), tinted by the system.
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true }); // clicks reach the app below
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    overlay.webContents.send('sparkles', sparklesOn);
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
      refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    glowOn = false;
    pushState();
    spawnQueued = false;
  });
}

function pushState() {
  if (ctl && !ctl.isDestroyed()) ctl.webContents.send('control-state', { enabled: glowOn, band: bandOn, sparkles: sparklesOn, words: wordsOn });
}

function setGlow(on) {
  if (on === glowOn) return pushState();
  glowOn = on;
  if (!on) {
    if (overlay && overlay.isVisible()) overlay.webContents.send('drop-whip');
  } else {
    if (!overlay) createOverlay();
    overlay.show();
    if (overlayReady) {
      overlay.webContents.send('spawn-whip');
      refocusPreviousApp();
    } else {
      spawnQueued = true;
    }
  }
  pushState();
}

// ── Control window ──────────────────────────────────────────────────────────
function showControl(inactive) {
  if (ctl && !ctl.isDestroyed()) return ctl.show();
  const wa = screen.getPrimaryDisplay().workArea;
  ctl = new BrowserWindow({
    width: 280, height: 240, useContentSize: true,
    x: wa.x + wa.width - 280 - 16, y: wa.y + 16,
    alwaysOnTop: true,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    show: false,
    title: 'openCheer',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  ctl.setMenuBarVisibility(false);
  ctl.loadFile('control.html');
  ctl.once('ready-to-show', () => (inactive ? ctl.showInactive() : ctl.show()));
  ctl.on('closed', () => { ctl = null; });
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', (_e, text) => {
  try {
    sendMacro(text, wordsOn ? 'enter' : 'full'); // words on: the words are typed live, a cheer only presses Return
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); glowOn = false; pushState(); });
ipcMain.on('sparkles-set', (_e, on) => {
  sparklesOn = !!on;
  if (overlay && overlayReady) overlay.webContents.send('sparkles', sparklesOn);
  pushState();
});
ipcMain.on('words-set', (_e, on) => { wordsOn = !!on; pushState(); });
ipcMain.on('control-set', (_e, on) => setGlow(!!on));
ipcMain.handle('control-get', () => ({ enabled: glowOn, band: bandOn, sparkles: sparklesOn, words: wordsOn }));

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
// kind: 'full' = Ctrl+C, text, Return (words off); 'words' = text only; 'enter' = Return only.
function sendMacro(spoken, kind) {
  // Type the spoken words if given, else a random phrase from a list of similar phrases
  const phrases = [
    'You got this!',
    'Great work, keep going!',
    'Believe in yourself!',
    'Nice progress!',
    'You are doing amazing!',
    'Keep it up, champion!',
  ];
  const text = kind === 'enter' ? '' : kind === 'words' ? cleanSpoken(spoken) + ' ' : phrases[Math.floor(Math.random() * phrases.length)];
  if (kind === 'words' && !text.trim()) return;
  const job = { text, ctrlC: kind === 'full', enter: kind !== 'words' };

  if (process.platform === 'win32') {
    sendMacroWindows(job);
  } else if (process.platform === 'darwin') {
    sendMacroMac(job);
  } else if (process.platform === 'linux') {
    sendMacroLinux(job);
  }
}

// Spoken text comes from outside: one line, no control characters, bounded length.
function cleanSpoken(t) {
  return t.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_SPOKEN);
}

// AppleScript strings treat only backslash and double quote specially.
function macTypeScript(text, enter) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'tell application "System Events"',
    text ? `  keystroke "${escaped}"` : '',
    enter ? '  key code 36' : '', // Enter
    `  ${MAC_RELEASE}`,
    'end tell'
  ].join('\n');
}

function sendMacroWindows({ text, ctrlC, enter }) {
  if (!keybd_event || !VkKeyScanA) return;
  const tapKey = vk => {
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
  };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) return;
    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(0x10, 0, 0, 0); // Shift down
    tapKey(vk);
    if (shiftState & 1) keybd_event(0x10, 0, KEYUP, 0); // Shift up
  };

  if (ctrlC) {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_C, 0, 0, 0);
    keybd_event(VK_C, 0, KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYUP, 0);
  }
  for (const ch of text) tapChar(ch);
  if (enter) {
    keybd_event(VK_RETURN, 0, 0, 0);
    keybd_event(VK_RETURN, 0, KEYUP, 0);
  }
}

// Never type into Messages: a cheer there goes to a real chat. If the front app is unknown, skip too.
function ifNotMessages(run, onSkip) {
  const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
  execFile('osascript', ['-e', script], OSA_OPTS, (err, out) => {
    if (err) { console.warn('mac macro skipped, front app unknown:', err.message); return onSkip(); }
    if (out.trim() === 'Messages') return onSkip();
    run();
  });
}

const AX_MSG = 'Typing needs Accessibility: System Settings > Privacy & Security > Accessibility > Electron';
let axWarnedAt = 0;
function axTrusted() {
  if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
  if (Date.now() - axWarnedAt > 60000) { axWarnedAt = Date.now(); console.log(AX_MSG); }
  return false;
}

let macMacroBusy = false;
const macWordsQueue = []; // words that arrive while a macro runs wait here (last MAC_QUEUE_MAX kept)
const MAC_QUEUE_MAX = 5;
function sendMacroMac(job) {
  if (!axTrusted()) return;
  if (macMacroBusy) { // a Return-only cheer is dropped (cooldown covers it); words are queued
    if (!job.ctrlC && job.text) { macWordsQueue.push(job); if (macWordsQueue.length > MAC_QUEUE_MAX) macWordsQueue.shift(); }
    return;
  }
  macMacroBusy = true;
  ifNotMessages(() => sendMacroMacUnchecked(job), finishMacMacro);
}

// Free the busy flag, then run the next queued words.
function nextMacMacro() {
  macMacroBusy = false;
  const next = macWordsQueue.shift();
  if (next) sendMacroMac(next);
}

// Always release every modifier, then free the busy flag.
function finishMacMacro() {
  execFile('osascript', ['-e', MAC_RELEASE_SCRIPT], OSA_OPTS, nextMacMacro);
}

function sendMacroMacUnchecked({ text, ctrlC, enter }) {
  const interruptScript = [
    'tell application "System Events"',
    '  key code 8 using {control down}', // Ctrl+C interrupt
    `  ${MAC_RELEASE}`,
    'end tell'
  ].join('\n');
  const typeScript = macTypeScript(text, enter);
  const type = () => ifNotMessages(() => {
    execFile('osascript', ['-e', typeScript], OSA_OPTS, err2 => {
      if (err2) {
        console.warn('mac macro failed (enable Accessibility for terminal/app):', err2.message);
      }
      finishMacMacro();
    });
  }, finishMacMacro);
  if (!ctrlC) return type();

  execFile('osascript', ['-e', interruptScript], OSA_OPTS, err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
      return finishMacMacro();
    }
    setTimeout(type, 300);
  });
}

let linuxTail = Promise.resolve(); // keeps typed words in order
function sendMacroLinux({ text, ctrlC, enter }) {
  const args = [];
  if (ctrlC) args.push('key', '--clearmodifiers', 'ctrl+c');
  if (text) args.push('type', '--delay', '1', '--clearmodifiers', '--', text);
  if (enter) args.push('key', 'Return');
  linuxTail = linuxTail.then(() => new Promise(resolve => execFile('xdotool', args, err => {
    if (err) console.warn('linux macro failed. Install xdotool:', err.message);
    resolve();
  })));
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('openCheer - click for controls');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => showControl(false));
  showControl(true);
  stopBand = startBand(m => {
    if (overlay && overlayReady) overlay.webContents.send('band-motion', m);
  }, console.log, on => { bandOn = on; pushState(); });
  if (process.platform === 'darwin') {
    await askMic();
    if (!systemPreferences.isTrustedAccessibilityClient(false)) { systemPreferences.isTrustedAccessibilityClient(true); axWarnedAt = Date.now(); console.log(AX_MSG); }
  }
  stopVoice = startVoice() || stopVoice;
});

// macOS shows the microphone prompt only for the app that asks. The sidecar is a bare python
// child that never prompts, so Electron asks first; its Info.plist has NSMicrophoneUsageDescription.
async function askMic() {
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') await systemPreferences.askForMediaAccess('microphone');
    const s = systemPreferences.getMediaAccessStatus('microphone');
    if (s !== 'granted') console.log(`microphone access ${s}: voice hears silence. Allow openCheer/Electron in System Settings > Privacy & Security > Microphone, then restart`);
  } catch (err) {
    console.log('microphone access check failed:', err.message);
  }
}

// ── Voice: Pipecat + Deepgram sidecar prints LEVEL and SAY lines ────────
function startVoice() {
  const script = path.join(__dirname, 'voice', 'voice.py');
  let key = process.env.DEEPGRAM_API_KEY;
  try {
    const m = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/^\s*DEEPGRAM_API_KEY\s*=\s*(.+?)\s*$/m);
    if (!key && m) key = m[1].replace(/^["']|["']$/g, '');
  } catch {}
  if (!key || !fs.existsSync(script)) return console.log('voice off: set DEEPGRAM_API_KEY and add voice/voice.py');
  const py = process.env.OPENCHEER_PYTHON || path.join(__dirname, 'voice', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let child, quitting = false;
  const run = () => {
    child = spawn(fs.existsSync(py) ? py : 'python3', [script], {
      env: { ...process.env, DEEPGRAM_API_KEY: key },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.on('error', err => console.log('voice off:', err.message));
    child.on('exit', (code, signal) => {
      if (quitting) return;
      console.log(`voice exited (code ${code}, signal ${signal}); restarting in 2 s`);
      setTimeout(() => { if (!quitting) run(); }, 2000);
    });
    let buf = '';
    child.stdout.on('data', d => {
      const lines = (buf + d).split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!overlay || !overlayReady) continue;
        if (l.startsWith('LEVEL ')) overlay.webContents.send('voice-level', Number(l.slice(6)) || 0);
        else if (l.startsWith('SAY ') && l.slice(4).trim()) onSay(l.slice(4));
      }
    });
  };
  run();
  return () => { quitting = true; child.kill(); };
}

// Words on: type each transcript at once while the sticks are shown. Words off: a voice cheer, as before.
function onSay(text) {
  if (!wordsOn) return overlay.webContents.send('voice-cheer', text);
  if (!glowOn) return;
  try { sendMacro(text, 'words'); } catch (err) { console.warn('sendMacro failed:', err?.message || err); }
}

let stopBand = () => {};
let stopVoice = () => {};
app.on('will-quit', () => {
  stopBand(); stopVoice();
  if (process.platform === 'darwin') {
    try { execFileSync('osascript', ['-e', MAC_RELEASE_SCRIPT], { timeout: 2000 }); } catch {}
  }
});
app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
