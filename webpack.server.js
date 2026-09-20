/*!
 *  桌面版(SEA)服务器打包配置:
 *  把 ネット対戦サーバー + 静态服务 + SEA 资产读取打成单文件
 *  desktop-sea/server-bundle.cjs,作为 SEA 的 main 脚本。
 *  构建产物不进仓库(desktop-sea/.gitignore 已忽略)。
 */
"use strict";

const path    = require('path');
const fs      = require('fs');
const webpack = require('webpack');

/* socket.io サーバーの serveClient は require.resolve + fs 読みで動くため
 * バンドル内では機能しない。クライアントソースをビルド時に定数へ埋め込み、
 * server/index.js 側の自前ルートで配信する。 */
const socket_io_client_src = fs.readFileSync(
    path.join(__dirname, 'node_modules', 'socket.io-client',
              'dist', 'socket.io.js'), 'utf8');

module.exports = {
    entry:  path.join(__dirname, 'desktop-sea', 'entry.js'),
    output: {
        path:     path.join(__dirname, 'desktop-sea'),
        filename: 'server-bundle.cjs',
    },
    target: 'node',                 // 内置模块保持 require,不打包
    node: {
        /* 保持原生 __dirname 语义(相对 bundle 文件自身定位 ../dist 等) */
        __dirname: false,
        __filename: false,
    },
    mode:   'production',
    optimization: { minimize: false },  // 保留可读性,方便排障
    plugins: [
        new webpack.DefinePlugin({
            SOCKET_IO_CLIENT_SRC: JSON.stringify(socket_io_client_src),
        }),
    ],
    /* ws 的可选加速依赖,安装与否不影响功能;标记为 external,
     * 运行时 require 失败由 ws 自己的 try/catch 兜住 */
    externals: [
        ({ request }, callback)=>{
            if (/^(bufferutil|utf-8-validate)$/.test(request))
                return callback(null, 'commonjs ' + request);
            callback();
        },
    ],
};
