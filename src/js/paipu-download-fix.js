/*
 *  牌譜ダウンロード互換レイヤー (paipu download fix)
 *
 *  問題: majiang-ui の牌譜保存は <a href="blob:..." download="牌譜(x).json">
 *        で実装されている (lib/file.js, lib/gamectl.js)。
 *        Android の WebView 系ブラウザ (Via / 微信 / QQ / UC など) は
 *        blob: ダウンロードをシステムの DownloadManager に渡すため、
 *        「GET /<uuid> 404」となり保存に失敗する。
 *
 *  方針: 動作する環境ではネイティブ挙動を一切変更せず、失敗する環境
 *        (WebView 系 UA) でのみクリックを横取りして代替手段を出す。
 *          1) navigator.share ファイル共有 (HTTPS のみ / 対応ブラウザのみ)
 *          2) JSON をクリップボードへコピー (非セキュア環境でも動く)
 *        node_modules は改変しない。エントリ JS から require するだけで有効。
 */
"use strict";

const $ = require('jquery');

/* ------------------------------------------------------------------ *
 * 1. blob URL -> テキスト の捕捉
 *    file.js / gamectl.js が URL.createObjectURL(blob) を呼ぶ瞬間に
 *    中身を非同期で読み取って保持する。fetch(blob:) が使えない環境
 *    でも確実にデータを取り出せるようにするため。
 * ------------------------------------------------------------------ */
const blobTexts = new Map();
const MAX_ENTRIES = 32;    // file.js は blob URL を revoke しないので上限を切る

function blobToText(blob) {
    if (typeof blob.text === 'function') return blob.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
}

function captureBlobText(url, blob) {
    blobToText(blob).then(text => {
        blobTexts.set(url, text);
        // 上限超過時は最古のエントリから捨てる (Map は挿入順を保持する)
        while (blobTexts.size > MAX_ENTRIES) {
            blobTexts.delete(blobTexts.keys().next().value);
        }
    }).catch(() => { /* 読めなければ諦めてフォールバックに任せる */ });
}

(function patchCreateObjectURL() {
    if (! window.URL || ! window.URL.createObjectURL) return;

    const origCreate = window.URL.createObjectURL.bind(window.URL);
    window.URL.createObjectURL = function(obj) {
        const url = origCreate(obj);
        try {
            if (obj instanceof Blob && /json/i.test(obj.type || '')) {
                captureBlobText(url, obj);
            }
        }
        catch (e) { /* 捕捉に失敗してもネイティブ動作は壊さない */ }
        return url;
    };

    const origRevoke = window.URL.revokeObjectURL.bind(window.URL);
    window.URL.revokeObjectURL = function(url) {
        blobTexts.delete(url);
        return origRevoke(url);
    };
})();

function getBlobText(link) {
    return new Promise((resolve, reject) => {
        const href = link.href;
        if (blobTexts.has(href)) return resolve(blobTexts.get(href));

        // blob.text() は非同期なので、直撃クリックのケースに備えて少し待つ
        setTimeout(() => {
            if (blobTexts.has(href)) return resolve(blobTexts.get(href));
            // それでも無ければ fetch(blob:) を試す (Chromium 系は大抵OK)
            fetch(href).then(res => res.text())
                       .then(resolve, () => reject(new Error('read blob failed')));
        }, 50);
    });
}

/* ------------------------------------------------------------------ *
 * 2. 環境判定: ネイティブの <a download> が期待通り動くか
 * ------------------------------------------------------------------ */
function isWebviewLike() {
    const ua = navigator.userAgent;
    // Android WebView 系ブラウザの目印 (Via は UA に "Via/x.y" を付ける)
    if (/Via\/|MicroMessenger|MQQBrowser|QQBrowser|UCBrowser|UCWEB|BaiduBoxApp|baidubrowser|HiBrowser|;\s*wv\)/i.test(ua)) return true;
    // "Chrome/xxx" を含まない Android ブラウザもまずダウンローダ経由になる
    if (/Android/i.test(ua) && ! /Chrome\/\d+/i.test(ua)) return true;
    return false;
}

function canShareFiles() {
    try {
        return !!(navigator.share && navigator.canShare
                  && File && new File([''], 't.json', { type: 'application/json' }));
    }
    catch (e) { return false; }
}

/* ------------------------------------------------------------------ *
 * 3. 代替 UI
 * ------------------------------------------------------------------ */
let $dialog;

function ensureDialog() {
    if ($dialog) return $dialog;

    $dialog = $(
        '<div id="paipu-save-dialog" style="display:none;'
      + 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);'
      + 'align-items:center;justify-content:center;">'
      +   '<div style="background:#fff;color:#222;border-radius:8px;'
      +        'max-width:88%;min-width:260px;padding:18px 20px;'
      +        'font-size:14px;line-height:1.6;text-align:center;">'
      +     '<div class="msg" style="margin-bottom:6px;"></div>'
      +     '<div class="sub" style="font-size:12px;color:#666;margin-bottom:12px;"></div>'
      +     '<div style="display:flex;flex-direction:column;gap:8px;">'
      +       '<button class="share" style="display:none;padding:10px;'
      +              'border:1px solid #888;border-radius:6px;background:#f5f5f5;">分享 / 保存到文件</button>'
      +       '<button class="copy" style="padding:10px;'
      +              'border:1px solid #888;border-radius:6px;background:#f5f5f5;">复制牌谱 JSON</button>'
      +       '<button class="close" style="padding:10px;'
      +              'border:1px solid #888;border-radius:6px;background:#f5f5f5;">关闭</button>'
      +     '</div>'
      +   '</div>'
      + '</div>');

    $dialog.on('click', ev => { if (ev.target === $dialog[0]) hideDialog(); });
    $dialog.on('click', '.close', hideDialog);
    $dialog.on('click', '.copy', function() {
        const text = $dialog.data('paipu-json') || '';
        copyText(text).then(ok => {
            $(this).text(ok ? '已复制 ✓ (粘贴保存为 .json)' : '复制失败，请长按屏幕手动复制');
        });
    });
    $dialog.on('click', '.share', function() {
        const text  = $dialog.data('paipu-json') || '';
        const fname = $dialog.data('paipu-name') || '牌譜.json';
        shareFile(text, fname).catch(() => { /* ユーザ中断は無視 */ });
    });

    $('body').append($dialog);
    return $dialog;
}

function hideDialog() {
    if ($dialog) $dialog.hide();
}

function showDialog(text, filename) {
    const dlg = ensureDialog();
    dlg.data('paipu-json', text).data('paipu-name', filename);

    if (text == null) {
        dlg.find('.msg').text('牌谱数据读取失败');
        dlg.find('.sub').text('请刷新页面后重试');
        dlg.find('.share').hide();
        dlg.find('.copy').hide();
    }
    else {
        dlg.find('.msg').text('当前浏览器不支持直接下载牌谱文件');
        dlg.find('.share').toggle(canShareFiles());
        dlg.find('.copy').show().text('复制牌谱 JSON');
        dlg.find('.sub').text(canShareFiles()
            ? '可分享到文件管理器保存为 .json'
            : '复制后粘贴到备忘录等，保存为 .json 文件即可');
    }
    dlg.css('display', 'flex');
}

function shareFile(text, filename) {
    const file = new File([text], filename, { type: 'application/json' });
    return navigator.share({ files: [file], title: filename });
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
                   .then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
}

// 非セキュアコンテキスト (http) 用のフォールバック
function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    return ok;
}

/* ------------------------------------------------------------------ *
 * 4. クリック横取り
 *    ・blob: 以外のリンクには一切干渉しない
 *    ・通常ブラウザ (デスクトップ / Android Chrome / iOS 14.5+) は
 *      ネイティブのダウンロードにそのまま任せる
 * ------------------------------------------------------------------ */
$(document).on('click', 'a[download]', function(ev) {
    const link = this;
    const href = link.getAttribute('href') || '';
    if (href.slice(0, 5) !== 'blob:') return;   // blob ダウンロード以外は素通し
    if (! isWebviewLike()) return;              // 動く環境はネイティブに任せる

    ev.preventDefault();
    ev.stopPropagation();

    const filename = link.getAttribute('download') || '牌譜.json';
    getBlobText(link)
        .then(text => showDialog(text, filename))
        .catch(()  => showDialog(null, filename));
});
