/*
 *  電脳麻将 Node SEA 静态服务器
 *
 *  职责：
 *    1) 从 SEA 注入资产取出 dist.zip 并解压到临时目录（首启动幂等）
 *       —— 无注入资产时回退到命令行指定的 dist 目录（便于 node server.js ../dist 开发）
 *    2) 用 Node 内置 http 模块 serve 解压后的目录
 *    3) 固定端口 8080，被占用时退到 8081
 *    4) 自动打开系统默认浏览器；失败则打印 URL
 *
 *  仅依赖 Node 内置模块，不 require 任何第三方包。
 */
"use strict";

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const zlib   = require('zlib');
const crypto = require('crypto');
const { exec, execFileSync } = require('child_process');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico':  'image/x-icon',
    '.svg':  'image/svg+xml',
    '.wav':  'audio/wav',
    '.mp3':  'audio/mpeg',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.txt':  'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * ZIP 解压（最小实现，仅处理标准 PKZIP + DEFLATE / STORE）
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ *
 * 解析 dist 来源：优先 SEA 资产，否则用命令行给的目录
 * ------------------------------------------------------------------ */
let distSource = '本地目录';

function resolveDistDir() {
    // 1) SEA 注入资产
    if (process.getAsset && typeof process.getAsset === 'function') {
        try {
            const zipBuf = process.getAsset('dist');
            if (zipBuf && zipBuf.length) {
                const hash = crypto.createHash('sha1').update(zipBuf).digest('hex').slice(0, 12);
                const dir = path.join(os.tmpdir(), 'majiang-' + hash);
                // 解压幂等：存在且非空则复用
                if (! fs.existsSync(path.join(dir, 'index.html'))) {
                    fs.rmSync(dir, { recursive: true, force: true });
                    fs.mkdirSync(dir, { recursive: true });
                    extractZip(zipBuf, dir);
                }
                distSource = 'SEA 内嵌资源';
                return dir;
            }
        } catch (e) {
            console.warn('[majiang-sea] 资产解压失败，回退到目录模式:', e.message);
        }
    }
    // 2) 开发模式：命令行第 2 参数或默认 ./dist
    const arg = process.argv[2] || path.join(__dirname, '..', 'dist');
    const abs = path.resolve(arg);
    if (! fs.existsSync(path.join(abs, 'index.html'))) {
        throw new Error('未找到 dist 目录（期望含 index.html）: ' + abs);
    }
    return abs;
}

/* ------------------------------------------------------------------ *
 * 静态服务器
 * ------------------------------------------------------------------ */
function createServer(root) {
    return http.createServer((req, res) => {
        try {
            let urlPath;
            try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
            catch (e) { urlPath = req.url.split('?')[0]; }

            if (urlPath === '/') urlPath = '/index.html';
            // 归一化并防目录穿越
            let filePath = path.normalize(path.join(root, urlPath));
            if (filePath.indexOf(root) !== 0 && ! filePath.startsWith(root + path.sep)) {
                res.writeHead(403); res.end('Forbidden'); return;
            }

            if (! fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('404 Not found'); return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const type = MIME[ext] || 'application/octet-stream';
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': stat.size,
                'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
            });
            fs.createReadStream(filePath).pipe(res);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('500 Internal Server Error: ' + e.message);
        }
    });
}

function openBrowser(url) {
    let cmd;
    if (process.platform === 'win32')   cmd = `start "" "${url}"`;
    else if (process.platform === 'darwin') cmd = `open "${url}"`;
    else                                    cmd = `xdg-open "${url}" >/dev/null 2>&1 &`;
    try { exec(cmd); } catch (e) { /* 打不开就打印 URL */ }
    console.log('\n[電脳麻将] 请在浏览器打开: ' + url);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
let root;
try {
    root = resolveDistDir();
} catch (e) {
    console.error('[電脳麻将] ' + e.message);
    process.exit(1);
}

// 资源来源同步落盘（writeFileSync 一定落盘）。CI 冒烟测试靠它判断 SEA 注入是否成功：
// console.log 在 stdout 重定向到文件时是异步缓冲的，grep 会竞态读不到，不可靠。
try {
    fs.writeFileSync(path.join(process.cwd(), 'sea-source.txt'), distSource + '\n');
} catch (e) { /* 非关键路径，写不了就算了 */ }

const start = (port) => new Promise((resolve, reject) => {
    const srv = createServer(root);
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
});

(async () => {
    let url = 'http://127.0.0.1:8080/';
    try {
        await start(8080);
    } catch (e) {
        if (e.code === 'EADDRINUSE') {
            await start(8081);
            url = 'http://127.0.0.1:8081/';
        } else {
            throw e;
        }
    }
    console.log(`[電脳麻将] 本地服务器已启动: ${url}  (资源来源: ${distSource})`);
    openBrowser(url);
})().catch(e => {
    console.error('[電脳麻将] 启动失败:', e);
    process.exit(1);
});