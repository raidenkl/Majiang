/*
 *  雀魂式和牌演出：役种逐个显现 + 逐个播报 + 満貫以上追加档位语音
 *
 *  实现方式：包装全局类 Majiang.UI.HuleDialog.prototype.hule（不修改 node_modules）。
 *  原方法把所有役种行一次性渲染进弹窗；本模块在渲染完成后立即把这些行隐藏，
 *  再按「显现一行 ↔ 播报一句」的节奏逐个放出，最后放出点数行。
 *
 *  生效范围（按需求约定）：
 *    - 仅实战对局（index / autoplay 页面加载本模块才有补丁）
 *    - index 页进入牌谱回放时（controller 带 paipu class）不启用，保持一次性全显
 *    - 音效关闭时不启用（避免无声的慢节奏）
 *
 *  満貫以上档位判定与显示文案完全一致（照抄 majiang-ui dialog.js 的算法）：
 *    manguan = defen / (l==0 ? 6 : 4) / 2000
 *    >=1 満貫  >=1.5 跳満  >=2 倍満  >=3 三倍満  >=4 役満(含ダブル/トリプル/四五六倍)
 */
"use strict";

const $ = require('jquery');

const YakuVoicePlayer = require('./yaku-voice-player');

/* 満貫以上档位 → 语音 key（gameend 系列，文件已在 dist/audio）。
 * 顺序必须从高档到低档：役満内部还有一~六倍役満的细分。 */
const TIER_VOICE = [
    { min: 24, key: 'yaku_yiman6' },    // 六倍役満 (manguan >= 4*6)
    { min: 20, key: 'yaku_yiman5' },    // 五倍役満
    { min: 16, key: 'yaku_yiman4' },    // 四倍役満
    { min: 12, key: 'yaku_yiman3' },    // トリプル役満
    { min: 8,  key: 'yaku_yiman2' },    // ダブル役満
    { min: 4,  key: 'yaku_yiman1' },    // 役満
    { min: 3,  key: 'yaku_sanbeiman' }, // 三倍満
    { min: 2,  key: 'yaku_beiman' },    // 倍満
    { min: 1.5, key: 'yaku_tiaoman' },  // 跳満
    { min: 1,  key: 'yaku_manguan' },   // 満貫
];

/* 宝牌三类分开播报：各自计数、各自一句。
 * 现统一复用 yaku_doraN（N = 各自数量）。
 * 若以后有「赤ドラ」「裏ドラ」专用语音，把对应行改成
 *   n => `yaku_akadora${n}` / n => `yaku_uradora${n}`
 * 并在 loaddata.pug 加相应标签即可。 */
const DORA_VOICE = {
    dora:    n => `yaku_dora${n}`,      // ドラ（含カンドラ表示牌）
    akadora: n => `yaku_dora${n}`,      // 赤ドラ
    uradora: n => `yaku_dora${n}`,      // 裏ドラ
};

module.exports = function(audio, storage = 'Majiang.pref') {

    const player = new YakuVoicePlayer(audio);

    /* 音效开关。GameCtl 每次切换都会写回 localStorage，播放时读才是当前值。 */
    function isSoundOn() {
        try {
            const pref = localStorage.getItem(storage);
            if (! pref) return true;
            return JSON.parse(pref).sound_on !== false;
        } catch (e) { return true; }
    }

    /* 回放模式判定：index.js 进牌谱再生时给 controller 加 paipu class */
    function isReplayMode() {
        return $('#board .controller').hasClass('paipu');
    }

    /* 満貫以上档位语音 key（不足満貫返回 null）。算法照抄 dialog.js 的显示逻辑 */
    function tierVoice(hule) {
        if (! hule || ! hule.defen) return null;
        const manguan = hule.defen / (hule.l == 0 ? 6 : 4) / 2000;
        for (let t of TIER_VOICE) {
            if (manguan >= t.min) return t.key;
        }
        return null;
    }

    /* 组装演出步骤。
     * rows: table.hupai 里的 tr.r_hupai 行（与 hule.hupai 一一对应）
     * defenRow: tr.r_defen 行
     */
    function buildSteps(rows, defenRow, hule) {
        const steps = [];

        // 宝牌按类型分开：普通ドラ / 赤ドラ / 裏ドラ 各自计数、各自播报
        // （换行到非同类行时结算上一组；同一类型连续出现则合并数量）
        let pending = null;   // { type, rows: [...], count }
        const doraType = (name) =>
              name === '赤ドラ' ? 'akadora'
            : name === '裏ドラ' ? 'uradora'
            : name.includes('ドラ') || name.includes('宝牌') ? 'dora'
            : null;

        const flushDora = () => {
            if (! pending) return;
            // ⚠️ 闭包必须捕获「当时的」行数组和数量快照：
            // 之前写成捕获外层 let 变量，结算后被清空，reveal 变成空操作
            // —— 宝牌有语音却一行都不显现，就是这个原因。
            const curRows   = pending.rows;
            const count     = Math.min(pending.count, 13);
            const voiceName = DORA_VOICE[pending.type](count);
            steps.push({
                voiceName: voiceName,
                reveal: () => curRows.forEach(r => r.removeClass('hide')),
            });
            pending = null;
        };

        (hule.hupai || []).forEach((yaku, i) => {
            const row = rows.eq(i);
            if (! row.length) return;

            const type = doraType(yaku.name);
            if (type) {
                if (pending && pending.type !== type) flushDora();   // 类型切换，先结算
                if (! pending) pending = { type, rows: [], count: 0 };
                pending.rows.push(row);
                pending.count += parseInt(yaku.fanshu) || 0;
                return;
            }
            flushDora();   // 遇到普通役种行，先结算未完的宝牌组（防御性，宝牌一般在末尾）

            const voiceName = player.getVoiceName(yaku.name);
            if (! voiceName) {
                console.warn('[hule-reveal] 未找到映射:', JSON.stringify(yaku.name));
            }
            steps.push({
                voiceName: voiceName || null,   // 没映射也显现，只少播一句
                reveal: () => row.removeClass('hide'),
            });
        });
        flushDora();

        // 点数行最后显现；満貫以上在这一步追加档位语音
        steps.push({
            voiceName: tierVoice(hule),
            reveal: () => defenRow.removeClass('hide'),
        });

        return steps;
    }

    /* hule() 渲染完成后的入口：隐藏行 → 启动序列 */
    function onHuleRendered(dialog, hule) {

        // 门禁：静音 / 回放模式 → 保持原来的「一次性全显」，不做演出
        if (! isSoundOn() || isReplayMode()) return;

        const $table  = dialog.find('table.hupai');
        const rows    = $table.find('tr.r_hupai').filter(function(){
                            return ! $(this).hasClass('hide');   // 「役なし」的隐藏模板行除外
                        });
        const defenRow = $table.find('tr.r_defen');

        // 立即隐藏，之后逐个放出（无语音的行也按节奏出现）
        rows.addClass('hide');
        defenRow.addClass('hide');

        // 弹窗被关闭/进入下一局时中止序列：player.cancel()
        const root = dialog.closest('.hule-dialog').length ? dialog.closest('.hule-dialog')
                                                           : dialog;
        const watch = setInterval(() => {
            if (root.hasClass('hide')) {
                clearInterval(watch);
                player.cancel();
            }
        }, 200);
        $(window).one('beforeunload', () => { clearInterval(watch); player.cancel(); });

        const steps = buildSteps(rows, defenRow, hule);
        player.playSteps(steps).then(() => clearInterval(watch));
    }

    /* 安装补丁：包装 prototype.hule，原逻辑照跑，跑完后接管演出时序 */
    $(function() {
        const HuleDialog = window.Majiang && window.Majiang.UI
                            && window.Majiang.UI.HuleDialog;
        if (! HuleDialog) {
            console.warn('[hule-reveal] Majiang.UI.HuleDialog 不可用，演出功能未启用');
            return;
        }
        const orig = HuleDialog.prototype.hule;
        HuleDialog.prototype.hule = function(hule) {
            const ret = orig.call(this, hule);
            try { onHuleRendered(this._node.root, hule); }
            catch (e) { console.warn('[hule-reveal] 演出失败，保持原样:', e); }
            return ret;
        };
    });

    return player;   // 便于测试/扩展
};
