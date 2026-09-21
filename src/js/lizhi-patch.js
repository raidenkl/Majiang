/*!
 *  立直の取り消しと待ち牌ヒント (lizhi patch)
 *
 *  问题:
 *    1) majiang-ui v1.6.1 的 Player 按下「リーチ」后，会用 select_dapai() 把
 *       可立直的打牌变成唯一可点击的对象 (blink)，没有任何退回手段，
 *       而且设定了 _default_reply (超时会自动立直)。
 *       -> node_modules/@kobalab/majiang-ui/lib/player.js action_zimo()
 *    2) 立直时看不到自己要和什么牌 (待ち牌)。
 *
 *  方针: 不修改 node_modules。这里用原型覆写的方式给 Majiang.UI.Player 打补丁，
 *        只需在 src/js/index.js / netplay.js 里 require 本模块即可生效。
 *        (majiang-2.5.5.js 先加载并定义全局 Majiang，index-2.5.5.js 后加载)
 *
 *  注意: Player 内部使用全局 $ (由 majiang-2.5.5.js 设定的 jQuery 实例)，
 *        本模块也必须使用同一个全局 $，否则 .off() 无法解除对方的处理器。
 */
"use strict";

/* ================================================================== *
 *  待ち牌・残り枚数の計算 (与 DOM 无关，可单独测试)
 * ================================================================== */

// 13 张牌形态的手牌 (或已去掉摸牌的形态) 的待ち牌
function tingpai_of(shoupai) {
    if (Majiang.Util.xiangting(shoupai) != 0) return [];
    return Majiang.Util.tingpai(shoupai) || [];
}

// 打出 p 之后的待ち牌。Majiang.Util.tingpai() 在有 _zimo 时返回 null，
// 所以必须 clone() 之后 dapai() 去掉摸牌。
function tingpai_after_dapai(shoupai, p) {
    return tingpai_of(shoupai.clone().dapai(p));
}

// 现在手牌的待ち牌。立直后是ツモ切り，所以按「打掉摸到的牌」计算。
function current_tingpai(player) {
    const shoupai = player.shoupai;
    const zimo    = shoupai._zimo;
    if (zimo && zimo.length <= 2) return tingpai_after_dapai(shoupai, zimo);
    if (zimo) {                     // 副露后 (_zimo 是面子) -> 13 张手牌的待ち
        const sp = shoupai.clone();
        sp._zimo = null;
        return tingpai_of(sp);
    }
    return tingpai_of(shoupai);
}

// 自己可见的 p 的张数 (自家手牌 + 四家河 + 副露 + ドラ表示牌)
function n_visible(player, p, shoupai) {

    const key = p[0] + p[1].replace('0','5');
    let n = (shoupai._bingpai[key[0]] || [])[+key[1]] || 0;

    const model = player.model;
    for (let l = 0; l < 4; l++) {
        for (let q of model.he[l]._pai) {
            if (q[0] + q[1].replace('0','5') == key) n++;
        }
        for (let m of model.shoupai[l]._fulou) {
            for (let d of m.match(/\d/g) || []) {
                if (m[0] + (d == '0' ? '5' : d) == key) n++;
            }
        }
    }
    if (model.shan && model.shan.baopai) {
        for (let q of model.shan.baopai) {
            if (q && q[0] + q[1].replace('0','5') == key) n++;
        }
    }
    return n;
}

// 剩下的张数。n_extra 是「即将打进河里的牌」与自己待ち牌相同的张数。
function n_remaining(player, p, shoupai, n_extra) {
    return Math.max(0, 4 - n_visible(player, p, shoupai) - (n_extra || 0));
}

const api = {
    tingpai_of:          tingpai_of,
    tingpai_after_dapai: tingpai_after_dapai,
    current_tingpai:     current_tingpai,
    n_visible:           n_visible,
    n_remaining:         n_remaining,
};
if (typeof module == 'object' && module.exports) module.exports = api;

/* ================================================================== *
 *  以下はブラウザ専用 (Majiang.UI.Player へのパッチ)
 * ================================================================== */

if (typeof window != 'undefined' && window.Majiang && window.Majiang.UI
    && Majiang.UI.Player)
(function(){

    const { show, hide, setSelector } = Majiang.UI.Util;
    const proto = Majiang.UI.Player.prototype;

    const MAX_ROWS = 6;         // ヒントに並べる最大行数

    const _action_zimo   = proto.action_zimo;
    const _action_dapai  = proto.action_dapai;
    const _action_fulou  = proto.action_fulou;
    const _action_gang   = proto.action_gang;
    const _select_dapai  = proto.select_dapai;
    const _clear_dapai   = proto.clear_dapai;

    /* ---- 牌画像とヒント領域 -------------------------------------- */

    let pai = null;
    function pai_image(p) {
        if (! pai) pai = Majiang.UI.pai($('#loaddata'));
        return pai(p);
    }

    let hint = null;
    function hint_node() {
        if (! hint || ! hint.length) {
            hint = $('.lizhi-hint', $('#board > .board')).eq(0);
            if (! hint.length) {
                hint = $('<div class="lizhi-hint hide">')
                            .appendTo($('#board > .board'));
            }
        }
        return hint;
    }

    function clear_hint() {
        if (! hint || ! hint.length) return;
        hint.empty();
        hint.addClass('hide fadeout');
    }

    // rows: [ { p, dapai, tingpai, n, selected } ]  p が null なら「現在の待ち」表示
    function render_hint(player, rows) {

        const node = hint_node();
        node.empty();
        if (! rows.length) { hide(node); return; }

        for (let row of rows) {

            if (row.other) {
                node.append($('<div class="lizhi-hint-row other">')
                                .text('他 ' + row.other + ' 通り'));
                continue;
            }

            const div = $('<div class="lizhi-hint-row">')
                            .attr('data-pai', row.dapai || '')
                            .toggleClass('selected', !! row.selected);

            if (row.p) {
                div.append($('<span class="label">').text('打'));
                div.append($('<span class="dapai">')
                    .append(pai_image(row.dapai))
                    .on('click', ()=>{
                        clear_hint();
                        player.callback({ dapai: row.p + '*' });
                    }));
            }

            div.append($('<span class="label">').text('待'));
            if (row.tingpai.length) {
                const dapai = row.dapai ? row.dapai.replace('0','5') : null;
                for (let p of row.tingpai) {
                    const img = pai_image(p);
                    // 自分の河にある待ち牌 (またはこの打牌で捨てる牌) は
                    // ロンできないので薄く表示する
                    if (player.he.find(p) || p == dapai) img.addClass('furiten');
                    div.append(img);
                }
            }
            else {
                div.append($('<span class="label">').text('なし'));
            }
            div.append($('<span class="n">').text(row.n + '枚')
                            .toggleClass('zero', row.n == 0));

            node.append(div);
        }
        show(node);
    }

    /* ---- 立直打牌の選択 (待ち牌ヒント付き) ----------------------- */

    function enter_lizhi(player, lizhi) {

        const rows = [];
        const seen = {};
        for (let p of lizhi) {

            const key = p[0] + (+p[1] || 5);
            if (seen[key]) continue;                    // 同種の牌は 1 行にまとめる
            seen[key] = true;

            const shoupai = player.shoupai.clone().dapai(p);
            const tingpai = tingpai_of(shoupai);
            const dapai   = p.slice(0,2);
            const n       = tingpai.reduce((n, q)=>
                                n + n_remaining(player, q, shoupai,
                                        q == dapai.replace('0','5') ? 1 : 0), 0);

            rows.push({ p: p, dapai: dapai, tingpai: tingpai, n: n });
        }

        // 残り枚数の多い順 (牌理ページと同じ並び)。良い候補を下(手牌寄り)に置く
        rows.sort((a,b)=> b.n - a.n || (a.p < b.p ? -1 : 1));

        const display = ()=>{
            const list = rows.slice(0, MAX_ROWS).reverse();
            if (rows.length > MAX_ROWS) list.unshift({ other: rows.length - MAX_ROWS });
            return list;
        };
        render_hint(player, display());

        // 手牌の候補をポイントすると、その打牌だけの待ち牌を表示する
        $('.pai[tabindex]', player._node.dapai)
            .on('mouseover.lizhihint', (ev)=>{
                const p = $(ev.currentTarget).attr('data-pai');
                for (let row of rows) {
                    if (row.dapai == p) {
                        render_hint(player, [ Object.assign({ selected: true },
                                                            row) ]);
                        return;
                    }
                }
            })
            .on('mouseout.lizhihint', ()=>render_hint(player, display()));
    }

    // × = 立直を取り消して、リーチを押す前のメニューに戻る
    function cancel_lizhi(player) {
        player.clear_handler();         // 点滅・打牌クリック・ボタンを解除
        delete player._default_reply;   // 時間切れの自動リーチをやめる
        clear_hint();
        if (player._lizhi_zimo) _action_zimo.apply(player, player._lizhi_zimo);
        else                    player.select_dapai();
        show_current_hint(player);      // 取り消しても聴牌なら待ち牌を出し直す
    }

    /* ---- 現在の待ち牌を表示 (聴牌していれば常に出す) -------------- */

    function show_current_hint(player) {
        const tingpai = current_tingpai(player);
        if (! tingpai.length) return clear_hint();
        const n = tingpai.reduce((n, p)=>
                    n + n_remaining(player, p, player.shoupai, 0), 0);
        render_hint(player, [ { p: null, dapai: null,
                                tingpai: tingpai, n: n } ]);
    }

    /* ---- メソッドの差し替え -------------------------------------- */

    proto.select_dapai = function(lizhi) {

        _select_dapai.call(this, lizhi);

        if (lizhi) {
            enter_lizhi(this, lizhi);
            // メニューを描き直すと show_button() が #board にクリックハンドラを
            // 登録し直すため、同じクリックがそのまま伝わらないようにする
            this.set_button('cansel', (ev)=>{
                if (ev && ev.stopPropagation) ev.stopPropagation();
                cancel_lizhi(this);
            });
            show(this._node.button.width($(this._node.dapai).width()));
            setSelector($('.button[tabindex]', this._node.button), 'button',
                        { focus: -1, touch: false });
        }
        else {
            show_current_hint(this);    // 聴牌なら現在の待ちを表示
        }
    };

    proto.clear_dapai = function() {
        $('.pai', this._node.dapai).off('.lizhihint');
        return _clear_dapai.call(this);
    };

    proto.action_zimo = function(zimo, gangzimo) {
        if (zimo.l == this._menfeng) this._lizhi_zimo = [ zimo, gangzimo ];
        _action_zimo.call(this, zimo, gangzimo);
        if (zimo.l == this._menfeng) {
            show_current_hint(this);    // 自分のツモ: 聴牌ならツモ切りの待ちを表示
        }
    };

    proto.action_dapai = function(dapai) {
        _action_dapai.call(this, dapai);
        show_current_hint(this);        // 聴牌なら常に表示、非聴牌なら消える
    };

    // 副露 (ポン/チー/槓) の後も、聴牌していれば待ち牌を表示する。
    // 他家の副露でも、見えている枚数が変わるので表示を更新する。
    proto.action_fulou = function(fulou) {
        _action_fulou.call(this, fulou);      // 先に元の処理 (select_dapai -> clear_hint)
        show_current_hint(this);
    };

    proto.action_gang = function(gang) {
        _action_gang.call(this, gang);
        show_current_hint(this);
    };

    // 一局が終わったら消す
    for (let name of [ 'action_qipai', 'action_hule',
                       'action_pingju', 'action_jieju' ]) {
        const orig = proto[name];
        proto[name] = function(...args) {
            clear_hint();
            return orig.apply(this, args);
        };
    }

})();
