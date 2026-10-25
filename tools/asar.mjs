// Minimal Electron ASAR reader (list / extract) — no dependencies.
// Usage:
//   node tools/asar.mjs list <archive> [regex]
//   node tools/asar.mjs extract <archive> <innerPath> <outFile>
import fs from 'node:fs';
import path from 'node:path';

function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const size1 = head.readUInt32LE(0); // 4
    const pickleSize = head.readUInt32LE(4);
    let base = 8;
    let bufLen = pickleSize;
    const buf = Buffer.alloc(bufLen);
    fs.readSync(fd, buf, 0, bufLen, base);
    // Pickle: uint32 payloadSize followed by uint32 stringLen + JSON bytes.
    const jsonStart = buf.indexOf(0x7b); // '{'
    // find matching close brace (ASCII only scan is fine: JSON inside is escaped)
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = jsonStart; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === 0x5c) esc = true;
        else if (c === 0x22) inStr = false;
        continue;
      }
      if (c === 0x22) { inStr = true; continue; }
      if (c === 0x7b) depth++;
      else if (c === 0x7d) { depth--; if (depth === 0) { end = i; break; } }
    }
    const header = JSON.parse(buf.subarray(jsonStart, end + 1).toString('utf8'));
    const dataBase = 8 + bufLen;
    return { fd, header, dataBase, size1 };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function walk(node, prefix, out) {
  if (!node || typeof node !== 'object') return;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix ? prefix + '/' + name : name, out);
    }
  } else if (typeof node.offset === 'string') {
    out.push({ path: prefix, offset: Number(node.offset), size: node.size ?? 0, unpacked: !!node.unpacked, link: node.link });
  }
}

const [, , cmd, archive, ...rest] = process.argv;
if (!cmd || !archive) {
  console.error('usage: asar.mjs list|extract <archive> ...');
  process.exit(2);
}
const { fd, header, dataBase } = readAsar(archive);
try {
  if (cmd === 'list') {
    const all = [];
    walk(header, '', all);
    const re = rest[0] ? new RegExp(rest[0], 'i') : null;
    for (const f of all) if (!re || re.test(f.path)) console.log(f.path);
  } else if (cmd === 'extract') {
    const inner = rest[0];
    const outFile = rest[1];
    const all = [];
    walk(header, '', all);
    const want = inner.replace(/\\/g, '/').replace(/^\/+/, '');
    const exact = all.find((f) => f.path === want);
    if (!exact) { console.error('not found: ' + want); process.exit(1); }
    if (exact.link) { console.error('link not supported'); process.exit(1); }
    const buf = Buffer.alloc(exact.size);
    fs.readSync(fd, buf, 0, exact.size, dataBase + exact.offset);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, buf);
    console.log('extracted ' + want + ' -> ' + outFile + ' (' + exact.size + ' bytes)');
  } else {
    console.error('unknown command');
    process.exit(2);
  }
} finally {
  fs.closeSync(fd);
}
