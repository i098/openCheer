// Vexo Open band over USB (macOS). Contract: https://github.com/VexoAI-Org/vexo-open-kit
const fs = require('fs');
const { execFile } = require('child_process');

const OP_STREAM_START = 0x10, OP_STREAM_STOP = 0x11, MOTION = 0x10, MASK_MOTION = 1;
const SILENT_MS = 3000, RETRY_MS = 3000;

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

const REAL_IO = {
  tickMs: 1000,
  findPort,
  exists: fs.existsSync,
  open: p => fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NOCTTY),
  stty: (p, cb) => execFile('stty', ['-f', p, 'raw', '-echo'], cb),
  write: fs.writeSync,
  read: fs.read,
  close: fs.closeSync,
};

// Finds, opens and streams from the band by itself, and recovers when it vanishes or goes silent.
// Calls onMotion(m) per MOTION frame and onState(true|false) when "a MOTION frame in the last 3 s" changes.
// Returns stop(); does nothing off macOS (io is for tests).
function startBand(onMotion, log = console.log, onState = () => {}, io = null) {
  const T = io || REAL_IO;
  let fd = null, port = null, stopped = false, busy = false, connected = false;
  let last = 0, sentAt = 0, seq = 0, triedAt = 0;
  const send = (op, mask) => T.write(fd, streamCmd(op, seq = (seq + 1) & 0xff, mask));
  const drop = why => {
    if (fd !== null) {
      try { send(OP_STREAM_STOP, 0xffff); } catch {}
      try { T.close(fd); } catch {}
      fd = null;
    }
    if (why) log(`band: ${why}`);
  };
  const stop = () => { stopped = true; clearInterval(timer); drop(); };

  const pump = myFd => {
    let pending = Buffer.alloc(0);
    const buf = Buffer.alloc(512);
    const next = () => {
      T.read(myFd, buf, 0, buf.length, null, (e, n) => {
        if (stopped || fd !== myFd) return;
        if (e || n === 0) return drop(`port failed: ${e ? e.message : 'closed'}`);
        pending = Buffer.concat([pending, buf.subarray(0, n)]);
        let z;
        while ((z = pending.indexOf(0)) >= 0) {
          const frame = z ? cobsDecode(pending.subarray(0, z)) : null;
          pending = pending.subarray(z + 1);
          const m = frame && parseMotion(frame);
          if (m) { last = Date.now(); onMotion(m); }
        }
        if (pending.length > 1024) pending = Buffer.alloc(0);
        next();
      });
    };
    next();
  };

  const connect = () => {
    busy = true;
    T.findPort(found => {
      if (stopped) return;
      if (!found) { busy = false; return; }
      let myFd;
      try { myFd = T.open(found); }
      catch (e) { busy = false; return log(`band: cannot open ${found}: ${e.message}`); }
      T.stty(found, err => {
        busy = false;
        if (stopped) { try { T.close(myFd); } catch {} return; }
        if (err) { try { T.close(myFd); } catch {} return log(`band: stty failed: ${err.message}`); }
        fd = myFd; port = found;
        try {
          T.write(fd, Buffer.from([0])); // resync, then clear any stream a previous program left running
          send(OP_STREAM_STOP, 0xffff);
          send(OP_STREAM_START, MASK_MOTION);
        } catch (e) { return drop(`write failed: ${e.message}`); }
        sentAt = Date.now();
        log(`band: streaming from ${port}`);
        pump(fd);
      });
    });
  };

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    if (busy) {
      // wait for the open in progress
    } else if (fd === null) {
      if ((process.platform === 'darwin' || io) && now - triedAt >= RETRY_MS) { triedAt = now; connect(); }
    } else if (!T.exists(port)) {
      drop('port gone');
    } else if (now - Math.max(last, sentAt) > SILENT_MS) {
      try { send(OP_STREAM_START, MASK_MOTION); sentAt = now; log('band: silent, restarting stream'); }
      catch (e) { drop(`write failed: ${e.message}`); }
    }
    const live = last > 0 && now - last < SILENT_MS;
    if (live !== connected) { connected = live; log(`band: ${connected ? 'connected' : 'not connected'}`); onState(connected); }
  };
  const timer = setInterval(tick, T.tickMs);
  timer.unref();
  tick();
  return stop;
}

module.exports = { cobsEncode, cobsDecode, streamCmd, parseMotion, startBand };
