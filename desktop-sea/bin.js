/*
 *  构建脚本：复制 node 运行时为可执行文件，并注入 SEA blob。
 *  跨平台：Windows 产 .exe，Linux/macOS 产无扩展名可执行文件。
 *  用法：node bin.js   （由 npm run build 自动调用）
 *  依赖：postject（devDependencies，用其 JS API，避免 npx 子进程与网络）。
 */
"use strict";

const fs = require('fs');
const path = require('path');
const { inject } = require('postject');

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const outName = process.platform === 'win32' ? '電脳麻将.exe' : '電脳麻将';
const outPath = path.join(__dirname, outName);
const blobPath = path.join(__dirname, 'sea-prep.blob');

async function main() {
    if (! fs.existsSync(blobPath)) {
        console.error('[majiang-bin] 缺少 sea-prep.blob，请先运行: npm run build:blob');
        process.exit(1);
    }

    // 1) 复制正在运行的 node 运行时（其含 SEA 支持与 fuse）
    fs.copyFileSync(process.execPath, outPath);
    if (process.platform !== 'win32') {
        fs.chmodSync(outPath, 0o755);
    }
    console.log(`[majiang-bin] 已复制 node → ${outName}`);

    // 2) 注入 SEA blob（postject JS API；sentinelFuse 必须用 NODE_SEA_FUSE_ 前缀）
    const blob = fs.readFileSync(blobPath);
    try {
        await inject(outPath, 'NODE_SEA_BLOB', blob, { sentinelFuse: FUSE });
    } catch (e) {
        console.error('[majiang-bin] postject 注入失败:', e.message);
        process.exit(1);
    }
    console.log(`[majiang-bin] ✅ 完成: ${outName} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

main();
