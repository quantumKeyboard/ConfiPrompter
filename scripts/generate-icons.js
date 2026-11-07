#!/usr/bin/env node
// Generates the app and tray icons as PNGs with no dependencies.
// Run: node scripts/generate-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Signed distance to a rounded rectangle centred at (cx, cy).
function roundedRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function coverage(dist) {
  return Math.min(1, Math.max(0, 0.5 - dist));
}

// Rounded square with three "text lines" knocked out.
function draw(size, { fg, lineColor, template = false }) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size;
  const pad = s * (template ? 0.06 : 0.08);
  const half = (s - pad * 2) / 2;
  const radius = s * 0.22;
  const lines = [
    { y: 0.37, x0: 0.27, x1: 0.73 },
    { y: 0.52, x0: 0.27, x1: 0.6 },
    { y: 0.67, x0: 0.27, x1: 0.68 }
  ];
  const lineHalf = s * 0.045;

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      // 4x supersampling for smooth edges at tiny tray sizes
      let bodyCov = 0;
      let lineCov = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          const inBody = roundedRectDist(px, py, s / 2, s / 2, half, half, radius) <= 0;
          let inLine = false;
          for (const line of lines) {
            const cx = ((line.x0 + line.x1) / 2) * s;
            const hw = ((line.x1 - line.x0) / 2) * s;
            if (roundedRectDist(px, py, cx, line.y * s, hw, lineHalf, lineHalf) <= 0) {
              inLine = true;
            }
          }
          if (inBody) {
            bodyCov += 1;
            if (inLine) {
              lineCov += 1;
            }
          }
        }
      }
      bodyCov /= 16;
      lineCov /= 16;

      const i = (y * s + x) * 4;
      if (template) {
        // macOS template image: opaque black where drawn, lines are holes.
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = Math.round((bodyCov - lineCov) * 255);
      } else {
        const t = bodyCov ? lineCov / bodyCov : 0;
        rgba[i] = Math.round(fg[0] * (1 - t) + lineColor[0] * t);
        rgba[i + 1] = Math.round(fg[1] * (1 - t) + lineColor[1] * t);
        rgba[i + 2] = Math.round(fg[2] * (1 - t) + lineColor[2] * t);
        rgba[i + 3] = Math.round(bodyCov * 255);
      }
    }
  }
  return encodePng(size, rgba);
}

const CORAL = [255, 122, 89];
const INK = [34, 15, 8];

fs.mkdirSync(OUT_DIR, { recursive: true });
const outputs = {
  'icon.png': draw(512, { fg: CORAL, lineColor: INK }),
  'tray.png': draw(32, { fg: CORAL, lineColor: INK }),
  'trayTemplate.png': draw(16, { template: true }),
  'trayTemplate@2x.png': draw(32, { template: true })
};

for (const [name, data] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(OUT_DIR, name), data);
  console.log(`wrote assets/${name} (${data.length} bytes)`);
}
