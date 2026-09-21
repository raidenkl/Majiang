/*
 *  局域网主机地址的规范化（纯函数，不依赖 DOM）
 *
 *  用户可能这么写：
 *      192.168.1.5                    → http://192.168.1.5:8080/
 *      192.168.1.5:9000               → http://192.168.1.5:9000/
 *      http://192.168.1.5:8080/       → http://192.168.1.5:8080/
 *      192.168.1.5:8080/netplay.html  → http://192.168.1.5:8080/   （只取 origin）
 *
 *  不接受：空串、端口越界、带用户名密码、非法主机名。
 *  IPv6 不支持 —— 主机给出的邀请地址一直是 IPv4（见 server/index.js 的 lan_ip()）。
 *
 *  浏览器里挂到 window 供启动页使用；Node 单测里当模块 require。
 */
"use strict";

var DEFAULT_PORT = '8080';

function normalizeHost(input) {

    if (input === null || input === undefined) return null;

    var s = String(input).trim().replace(/\s+/g, '');
    if (! s) return null;

    /* 没写协议就补 http://（局域网主机走 http；用户显式写了 https 就尊重） */
    if (! /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;

    var m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(s);
    if (! m) return null;

    var scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;

    var authority = m[2];
    if (! authority) return null;
    if (authority.indexOf('@') >= 0) return null;      /* user:pass@host 不陪跑 */
    if (authority.charAt(0) === '[') return null;      /* IPv6 不支持 */

    var host = authority;
    var port = DEFAULT_PORT;
    var colon = authority.lastIndexOf(':');
    if (colon >= 0) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
    }

    host = host.replace(/\.$/, '').toLowerCase();      /* 去掉结尾的点，统一小写 */
    if (! host) return null;
    if (host.length > 253) return null;
    if (! /^[0-9a-z._-]+$/.test(host)) return null;
    if (! /^[0-9]{1,5}$/.test(port)) return null;

    var p = parseInt(port, 10);
    if (! (p >= 1 && p <= 65535)) return null;

    return scheme + '://' + host + ':' + p + '/';
}

if (typeof window !== 'undefined') window.normalizeHost = normalizeHost;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeHost: normalizeHost, DEFAULT_PORT: DEFAULT_PORT };
}
