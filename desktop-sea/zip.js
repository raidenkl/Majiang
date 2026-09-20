/*
 *  ZIP 解压（最小实现，仅处理标准 PKZIP + DEFLATE / STORE）。
 *  从 server.js 抽出，供 SEA 打包的 entry.js 复用。
 *  仅依赖 Node 内置模块。
 */
"use strict";

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

function readU16(buf, off) { return buf.readUInt16LE(off); }
function readU32(buf, off) { return buf.readUInt32LE(off); }

function extractZip(zipBuf, outDir) {
    // 查找 End Of Central Directory（0x06054b50），从文件末尾往前扫
    let eocd = -1;
    for (let i = zipBuf.length - 22; i >= 0 && i >= zipBuf.length - 22 - 65535; i--) {
        if (readU32(zipBuf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip: EOCD not found');
    const cdOffset = readU32(zipBuf, eocd + 16);
    const cdCount  = readU16(zipBuf, eocd + 10);
    let p = cdOffset;
    for (let n = 0; n < cdCount; n++) {
        if (readU32(zipBuf, p) !== 0x02014b50) break;
        const method = readU16(zipBuf, p + 10);
        const compSize = readU32(zipBuf, p + 20);
        const nameLen = readU16(zipBuf, p + 28);
        const extraLen = readU16(zipBuf, p + 30);
        const commentLen = readU16(zipBuf, p + 32);
        const localOff = readU32(zipBuf, p + 42);
        const name = zipBuf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        // 跳到 local header 读取 name/extra 长度以定位数据区
        const lNameLen = readU16(zipBuf, localOff + 26);
        const lExtraLen = readU16(zipBuf, localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const data = zipBuf.slice(dataStart, dataStart + compSize);
        // 目录项（名字以 '/' 结尾）跳过
        if (name.endsWith('/')) { p += 46 + nameLen + extraLen + commentLen; continue; }
        const dest = path.join(outDir, name);
        const abs  = path.resolve(dest);
        if (abs.indexOf(path.resolve(outDir)) !== 0) { /* 防目录穿越，跳过 */ }
        else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (method === 8) {      // deflate
                fs.writeFileSync(abs, zlib.inflateRawSync(data));
            } else if (method === 0) { // stored
                fs.writeFileSync(abs, data);
            } else {
                throw new Error('zip: unsupported method ' + method + ' for ' + name);
            }
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
}

module.exports = { extractZip };
