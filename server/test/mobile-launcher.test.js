/*
 *  Android 壳的测试（纯 Node，不需要模拟器 / 与 DOM 无关）
 *
 *  APK 本身只能在 CI 里构建，本地能守住的就两件事：
 *    ① 启动页的主机地址规范化（手输 IP 是唯一入口，错了就联不上）
 *    ② manifest / 启动页 / MainActivity 里那些"漏了必然出问题"的关键配置
 *       （明文放行、联网权限、横屏、音频手势、内置资源路径）
 */
"use strict";

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT   = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

const { normalizeHost } = require(path.join(ASSETS, 'host-input.js'));

test('Android 启动页：主机地址规范化', () => {

    /* 只写 IP、或 IP:端口 */
    assert.equal(normalizeHost('192.168.1.5'),      'http://192.168.1.5:8080/');
    assert.equal(normalizeHost('192.168.1.5:9000'), 'http://192.168.1.5:9000/');
    assert.equal(normalizeHost('  192.168.1.5  '),  'http://192.168.1.5:8080/');

    /* 直接粘贴主机页面上显示的邀请地址 */
    assert.equal(normalizeHost('http://192.168.1.5:8080/'),
                 'http://192.168.1.5:8080/');
    assert.equal(normalizeHost('http://192.168.1.5:8080/netplay.html'),
                 'http://192.168.1.5:8080/');

    /* 主机名 / 大小写 / 结尾的点 */
    assert.equal(normalizeHost('Majiang.LOCAL'),    'http://majiang.local:8080/');
    assert.equal(normalizeHost('majiang.local.'),   'http://majiang.local:8080/');

    /* 用户显式写了 https 就尊重（不静默降级成 http） */
    assert.equal(normalizeHost('https://majiang.example.com'),
                 'https://majiang.example.com:8080/');

    /* 非法输入一律返回 null，让启动页给出提示而不是导航到垃圾地址 */
    for (const bad of [ '', '   ', null, undefined, 'http://', '192.168.1.5:0',
                        '192.168.1.5:65536', '192.168.1.5:abc', 'user:pw@192.168.1.5',
                        'ftp://192.168.1.5', '[::1]:8080', '192.168.1.5:8080:1' ]) {
        assert.equal(normalizeHost(bad), null,
                     `应拒绝: ${JSON.stringify(bad)}`);
    }
});

test('Android 工程：漏了必然出问题的关键配置', () => {

    const manifest = fs.readFileSync(
        path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    /* 局域网主机是明文 http，Android 9+ 默认禁止，必须显式放行 */
    assert.match(manifest, /android:usesCleartextTraffic="true"/);
    /* 联机需要联网权限 */
    assert.match(manifest, /android\.permission\.INTERNET/);
    /* 手机端布局靠 @media (max-height:450px) 的 tablet 样式触发 → 锁横屏 */
    assert.match(manifest, /android:screenOrientation="landscape"/);

    const launcher = fs.readFileSync(path.join(ASSETS, 'launcher.html'), 'utf8');
    assert.match(launcher, /host-input\.js/);       // 依赖脚本确实引入
    assert.match(launcher, /www\/index\.html/);     // 单机入口指向内置资源
    assert.match(launcher, /MajiangHost/);          // 用原生桥记住主机地址

    const main = fs.readFileSync(
        path.join(ROOT, 'android/app/src/main/java/com/raidenkl/majiang/MainActivity.java'),
        'utf8');
    /* WebView 默认要求用户手势才出声，不改的话役种语音全哑 */
    assert.match(main, /setMediaPlaybackRequiresUserGesture\(false\)/);
    /* 启动页是内置资源；本地资源用 file:// 而不是拦截式加载 */
    assert.match(main, /file:\/\/\/android_asset\/launcher\.html/);
    assert.match(main, /setAllowFileAccess\(true\)/);

    const gradle = fs.readFileSync(
        path.join(ROOT, 'android/app/build.gradle'), 'utf8');
    assert.match(gradle, /\.\.\/package\.json/);    // 版本号与 Web 端同源
    assert.match(gradle, /copyWebAssets/);          // dist/ 会被打进 APK
});
