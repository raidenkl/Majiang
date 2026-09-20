/*
 *  電脳麻将 SEA 主入口（webpack 打包为 server-bundle.cjs 后作为 SEA main）
 *
 *  = 完整的ネット対戦サーバー(express + socket.io + Majiang.Game 权威引擎)
 *    + 静态资源服务(来自 SEA 资产 dist.zip 或本地 dist 目录)
 *
 *  双击桌面版后:
 *    - 默认仅监听 127.0.0.1(局域网联机 OFF)
 *    - 在网页「ネット対戦 → 局域网联机」按钮里开启后,才对 LAN 开放(0.0.0.0),
 *      并显示邀请链接给其他设备加入
 *
 *  开发模式(非 SEA): node server-bundle.cjs ../dist
 *
 *  保留与旧版 server.js 相同的外部约定:
 *    - 端口从 8080 起寻找空闲端口
 *    - sea-source.txt / sea-url.txt 落盘(CI 冒烟测试依赖)
 *    - 自动打开系统默认浏览器
 */
"use strict";

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const { extractZip } = require('./zip.js');
const { create_app } = require('../server/index.js');

/* ------------------------------------------------------------------ *
 * SEA 资产读取(与旧 server.js 相同的 API 兼容层)
 * ------------------------------------------------------------------ */
function readSeaAsset(key) {
    let sea = null;
    try { sea = require('node:sea'); } catch (e) { /* 老版本 Node 没有该模块 */ }

    if (sea && typeof sea.isSea === 'function' && sea.isSea()) {
        // 优先 getRawAsset（ArrayBuffer，不复制）；不可用则退回 getAsset（复制一份）
        if (typeof sea.getRawAsset === 'function') {
            return Buffer.from(sea.getRawAsset(key));
        }
        if (typeof sea.getAsset === 'function') {
            return Buffer.from(sea.getAsset(key));
        }
    }
    // 兼容 Node 20.6–21.6 的旧 API（新版已移除，为 undefined）
    if (typeof process.getAsset === 'function') {
        return process.getAsset(key);
    }
    return null;
}

let distSource = '本地目录';

function resolveDistDir() {
    // 1) SEA 注入资产
    try {
        const zipBuf = readSeaAsset('dist');
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
        console.warn('[majiang-sea] 内嵌资产读取/解压失败，回退到目录模式:', e.message);
    }
    // 2) 开发模式：命令行第 2 参数或默认 ../dist
    const arg = process.argv[2] || path.join(__dirname, '..', 'dist');
    const abs = path.resolve(arg);
    if (! fs.existsSync(path.join(abs, 'index.html'))) {
        throw new Error('未找到 dist 目录（期望含 index.html）: ' + abs);
    }
    return abs;
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
 * 启动:ネット対戦サーバー(内蔵) + 静的資源
 * ------------------------------------------------------------------ */
let root;
try {
    root = resolveDistDir();
} catch (e) {
    console.error('[電脳麻将] ' + e.message);
    process.exit(1);
}

// 资源来源同步落盘。CI 冒烟测试靠它判断 SEA 注入是否成功
// （console.log 在 stdout 重定向到文件时是异步缓冲的，grep 会竞态读不到）
try {
    fs.writeFileSync(path.join(process.cwd(), 'sea-source.txt'), distSource + '\n');
} catch (e) { /* 非关键路径 */ }

/* 桌面版默认局域网联机 OFF(127.0.0.1),页面上用按钮开启 */
const lan_default = process.env.LAN_DEFAULT == null
                  ? false : !! +process.env.LAN_DEFAULT;
const { server, lan, listen_host } =
        create_app(root, { lan_default });

// 找一个空闲端口（从 8080 起，最多试 90 个）。
async function findFreePort() {
    for (let port = 8080; port < 8100; port++) {
        try {
            await new Promise((resolve, reject)=>{
                server.once('error', reject);
                server.listen({ port, host: '127.0.0.1' }, resolve);
            });
            return port;
        } catch (e) {
            if (e.code !== 'EADDRINUSE') throw e; // 非占用类错误直接抛
        }
    }
    throw new Error('8080-8099 端口均被占用，请关闭占用端口后重试');
}

(async () => {
    let port;
    try {
        port = await findFreePort();
    } catch (e) {
        console.error('[電脳麻将] ' + e.message);
        console.error('[電脳麻将] 若一闪而过，请在 cmd/PowerShell 里运行本程序查看错误。');
        process.exit(1);
    }
    listen_host.last = '127.0.0.1';

    const url = `http://127.0.0.1:${port}/`;
    // 把实际地址也写盘（sea-url.txt），方便找不到控制台窗口时打开
    try {
        fs.writeFileSync(path.join(process.cwd(), 'sea-url.txt'), url + '\n');
    } catch (e) { /* 非关键 */ }
    console.log(`[電脳麻将] 本地服务器已启动: ${url}  (资源来源: ${distSource})`);
    console.log('[電脳麻将] 局域网联机: OFF(网页「ネット対戦 → 局域网联机」按钮可开启)');
    openBrowser(url);
})().catch(e => {
    console.error('[電脳麻将] 启动失败:', e);
    process.exit(1);
});
