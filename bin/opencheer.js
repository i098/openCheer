#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const invokedAs = path.basename(process.argv[1] || '');
if (invokedAs === 'badclaude' || invokedAs === 'badclaude.cmd') {
  console.warn('[DEPRECATED] "badclaude" has been renamed to "opencheer".');
  console.warn('Please run: npm install -g opencheer');
}

let electronBinary;
try {
  electronBinary = require('electron');
} catch (e) {
  console.error('Could not load Electron. Try: npm install -g opencheer');
  process.exit(1);
}

const appPath = path.resolve(__dirname, '..');

const child = spawn(electronBinary, [appPath], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.on('error', (err) => {
  console.error('Failed to start opencheer:', err.message);
  process.exit(1);
});

child.unref();
