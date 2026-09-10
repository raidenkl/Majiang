/*
 *  构建脚本：把 dist/ 打包成 dist.zip（纯 Node，跨平台）。
 *  用于 SEA 资产注入。压缩方法用 DEFLATE，文件名按相对路径（'/' 分隔）。
 */
"use strict";

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIST   = path.join(__dirname, '..', 'dist');
const OUTPUT = path.join(__dirname, 'dist.zip');

function walk(dir, base, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const rel  = (base ? base + '/' : '') + ent.name;
        if (ent.isDirectory()) walk(full, rel, out);
        else out.push({ rel, full });
    }
    return out;
}

function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf); // Node >= 22.2
    let c, table = crc32.table || (crc32.table = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })());
    c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const files = walk(DIST, '');
const localParts = [];
const centralParts = [];
let offset = 0;

const dosTime = 0x1f2e;
const dosDate = 0x5721;

for (const { rel, full } of files) {
    const raw = fs.readFileSync(full);
    const nameBuf = Buffer.from(rel, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const nameLen = nameBuf.length;

    // local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    lh.writeUInt16LE(8, 8);           // method: deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameLen, 26);
    lh.writeUInt16LE(0, 28);          // extra len
    localParts.push(lh, nameBuf, comp);
    const localSize = 30 + nameLen + comp.length;

    // central directory header
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameLen, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);
    const centralSize = 46 + nameLen;

    offset += localSize;
}

const cdSize = centralParts.reduce((a, b) => a + (Buffer.isBuffer(b) ? b.length : 0), 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const out = Buffer.concat([...localParts, ...centralParts, eocd]);
fs.writeFileSync(OUTPUT, out);
console.log(`[majiang-sea] dist.zip 生成: ${files.length} 个文件, ${(out.length/1024/1024).toFixed(2)} MB`);