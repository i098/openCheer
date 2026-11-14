// Vexo Open band over USB (macOS). Contract: https://github.com/VexoAI-Org/vexo-open-kit
const fs = require('fs');
const { execFile } = require('child_process');

const OP_STREAM_START = 0x10, OP_STREAM_STOP = 0x11, MOTION = 0x10, MASK_MOTION = 1;
const SILENT_MS = 3000;

function cobsEncode(b) {
  const out = [0];
  let code = 1, at = 0;
  for (const x of b) {
    if (code === 0xff) { out[at] = code; at = out.length; out.push(0); code = 1; }
    if (x === 0) { out[at] = code; at = out.length; out.push(0); code = 1; continue; }
    out.push(x);
    code++;
  }
  out[at] = code;
  return Buffer.from(out);
}

// Returns a Buffer, or null when the input is not valid COBS.
function cobsDecode(b) {
  const out = [];
  for (let i = 0; i < b.length;) {
    const code = b[i];
    if (code === 0 || i + code > b.length) return null;
    for (let j = 1; j < code; j++) out.push(b[i + j]);
    i += code;
    if (code < 0xff && i < b.length) out.push(0);
  }
  return Buffer.from(out);
}

// Command frame [01][seq][opcode][mask u16 LE], COBS-encoded plus the 0x00 terminator.
function streamCmd(opcode, seq, mask) {
  const f = Buffer.from([0x01, seq, opcode, mask & 0xff, mask >> 8]);
  return Buffer.concat([cobsEncode(f), Buffer.from([0])]);
}

// MOTION frame -> {ax, ay, az (g, mean), gyro (deg/s, largest |axis|)}, or null.
function parseMotion(f) {
  if (f.length < 7 || f[0] !== MOTION) return null;
  const n = f[6];
  if (n === 0 || f.length !== 7 + n * 12) return null;
  const m = { ax: 0, ay: 0, az: 0, gyro: 0 };
  for (let i = 0; i < n; i++) {
    const o = 7 + i * 12;
    m.ax += f.readInt16LE(o) / 1000 / n;
    m.ay += f.readInt16LE(o + 2) / 1000 / n;
    m.az += f.readInt16LE(o + 4) / 1000 / n;
    for (let k = 6; k < 12; k += 2) m.gyro = Math.max(m.gyro, Math.abs(f.readInt16LE(o + k)) / 10);
  }
  return m;
}

function findPort(cb) {
  execFile('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], { maxBuffer: 1 << 25 }, (err, out) => {
    if (err) return cb(null);
    let ours = false;
    for (const line of out.split('\n')) {
      if (line.includes('"USB Product Name"')) ours = line.includes('"Vexo Open band"');
      const m = ours && line.match(/"IOCalloutDevice" = "(\/dev\/cu\.usbmodem[^"]+)"/);
      if (m) return cb(m[1]);
    }
    cb(null);
  });
}

// Calls onMotion(m) for each MOTION frame. Returns stop(); does nothing off macOS or without a band.
function startBand(onMotion, log = console.log) {
  let fd = null, stopped = false, last = 0, warned = false;
  const stop = () => {
    stopped = true;
    if (fd === null) return;
    try { fs.writeSync(fd, streamCmd(OP_STREAM_STOP, 2, MASK_MOTION)); } catch {}
    try { fs.closeSync(fd); } catch {}
    fd = null;
  };
  if (process.platform !== 'darwin') return stop;

  findPort(port => {
    if (stopped) return;
    if (!port) return log('band: none found, using mouse');
    try { fd = fs.openSync(port, fs.constants.O_RDWR | fs.constants.O_NOCTTY); }
    catch (e) { return log(`band: cannot open ${port}: ${e.message}`); }
    execFile('stty', ['-f', port, 'raw', '-echo'], err => {
      if (stopped) return;
      if (err) { stop(); return log(`band: stty failed: ${err.message}`); }
      fs.writeSync(fd, Buffer.concat([Buffer.from([0]), streamCmd(OP_STREAM_START, 1, MASK_MOTION)]));
      last = Date.now();
      log(`band: streaming from ${port}`);
      const watch = setInterval(() => {
        if (stopped) return clearInterval(watch);
        if (!warned && Date.now() - last > SILENT_MS) { warned = true; log('band: silent, using mouse'); }
      }, 1000);
      watch.unref();
      let pending = Buffer.alloc(0);
      const buf = Buffer.alloc(512);
      const pump = () => {
        if (stopped) return;
        fs.read(fd, buf, 0, buf.length, null, (e, n) => {
          if (stopped) return;
          if (e || n === 0) { stop(); return log(`band: port failed: ${e ? e.message : 'closed'}`); }
          last = Date.now();
          warned = false;
          pending = Buffer.concat([pending, buf.subarray(0, n)]);
          let z;
          while ((z = pending.indexOf(0)) >= 0) {
            const frame = z ? cobsDecode(pending.subarray(0, z)) : null;
            pending = pending.subarray(z + 1);
            const m = frame && parseMotion(frame);
            if (m) onMotion(m);
          }
          if (pending.length > 1024) pending = Buffer.alloc(0);
          pump();
        });
      };
      pump();
    });
  });
  return stop;
}

module.exports = { cobsEncode, cobsDecode, streamCmd, parseMotion, startBand };
