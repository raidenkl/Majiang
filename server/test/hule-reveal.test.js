/*!
 *  和牌演出(クライアント側モジュール)の DOM 不要な単体テスト。
 *
 *  ─ なぜここに置くか ─
 *  server/test は `npm test` の唯一のテスト入口なので、DOM を使わない
 *  クライアント側モジュールの検証もここに置いて回帰に乗せる。
 *
 *  検証していること:
 *   1. 语音再生後に WebMediaPlayer を解放する(src を外して load() する)
 *      —— Chromium は 1 tab の WebMediaPlayer 数を制限(デスクトップ 75,
 *      crbug.com/1144736)していて、解放しないと演出の後半が無音になる。
 *   2. volume 属性は play() の前に反映される(preload="none" 対策)
 *   3. タイムアウト経路でも解放される
 *   4. 満貫以上なら必ず「档位语音」が演出キューに入る
 *   5. loaddata.pug の yaku_* タグに preload="none" が入っている
 *
 *  実行: npm test （= node --test "server/test/*.test.js"）
 */
"use strict";

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/* ---- 偽 audio 要素 ---- */

function fake_audio() {
    const el = {
        src:         'audio/dummy.wav',
        volume:      1,
        readyState:  0,
        networkState: 0,
        currentSrc:  'audio/dummy.wav',
        onended:     null,
        onerror:     null,
        played:      false,
        volume_at_play: null,
        released:    false,
        reloaded:    false,
        getAttribute(name)  { return name == 'volume' ? '0.3' : null },
        removeAttribute(name) { if (name == 'src') { el.released = true; el.src = '' } },
        load()              { el.reloaded = true },
        play()              { el.played = true;
                              el.volume_at_play = el.volume;
                              return Promise.resolve() },
    };
    return el;
}

/* ---- 偽 rows / defenRow(buildSteps が必要とするのは eq/length/removeClass だけ) ---- */

function fake_row() {
    return {
        length: 1,
        _hidden: false,
        removeClass() { this._hidden = false; return this },
        addClass()    { this._hidden = true;  return this },
    };
}

function fake_rows(n) {
    return {
        length: n,
        rows:   Array.from({ length: n }, () => fake_row()),
        eq(i)  { return this.rows[i] || { length: 0 } },
        addClass() { return this },
    };
}

/* ---- jquery をスタブ化して hule-reveal を Node で require できるようにする ---- */

function load_reveal() {
    const jq = require.resolve('jquery', { paths: [ ROOT ] });
    if (! require.cache[jq]) {
        const fake = (arg) => typeof arg == 'function' ? fake : { };   // DOM ready は無視
        require.cache[jq] = { id: jq, filename: jq, loaded: true, exports: fake };
    }
    return require(path.join(ROOT, 'src', 'js', 'hule-reveal'));
}

const YakuVoicePlayer = require(path.join(ROOT, 'src', 'js', 'yaku-voice-player'));

/* ---- テスト ---- */

test('和牌语音：播完要释放播放器(WebMediaPlayer 上限対策)', async ()=>{

    const made = [];
    const player = new YakuVoicePlayer(()=>{
        const el = fake_audio();
        made.push(el);
        return el;
    });

    const done = player.playSteps([{ voiceName: 'yaku_liqi', reveal(){} }]);
    while (! made.length) await new Promise(r=>setTimeout(r, 5));

    const el = made[0];
    assert.equal(el.played, true, 'play() が呼ばれる');
    assert.equal(el.volume_at_play, 0.3,
                 'volume 属性が play() の前に反映されている');

    el.onended();                       // 再生完了
    await done;

    assert.equal(el.released, true, 'src が外されて播放器が解放される');
    assert.equal(el.reloaded, true, 'load() が呼ばれて資源が解放される');
    assert.equal(el.onended, null,  '解放時に onended が外される');
    assert.equal(el.onerror, null,  '解放時に onerror が外される');
});

test('和牌语音：タイムアウト経路でも播放器を解放する', { timeout: 30000 }, async ()=>{

    const made = [];
    const player = new YakuVoicePlayer(()=>{
        const el = fake_audio();        // onended を一切発火させない
        made.push(el);
        return el;
    });

    await player.playSteps([{ voiceName: 'yaku_dora3', reveal(){} }]);

    const el = made[0];
    assert.equal(el.released, true, 'タイムアウト後も src が外される');
    assert.equal(el.reloaded, true, 'タイムアウト後も load() される');
});

test('和牌演出：満貫以上は必ず档位语音がキューに入る', ()=>{

    const initHuleReveal = load_reveal();
    const reveal = initHuleReveal(()=>fake_audio());

    assert.equal(typeof reveal.tierVoice,  'function');
    assert.equal(typeof reveal.buildSteps, 'function');

    /* defen / l(自分の席が親か) → 期待する档位语音。dialog.js の表示判定と同値 */
    const cases = [
        [  8000, 1, 'yaku_manguan'  ],
        [ 12000, 1, 'yaku_tiaoman'  ],
        [ 16000, 1, 'yaku_beiman'   ],
        [ 24000, 1, 'yaku_sanbeiman'],
        [ 32000, 1, 'yaku_yiman1'   ],
        [ 64000, 1, 'yaku_yiman2'   ],
        [ 12000, 0, 'yaku_manguan'  ],   // 親の 12000 は満貫
    ];
    for (const [ defen, l, expect ] of cases) {
        assert.equal(reveal.tierVoice({ defen, l }), expect,
                     `defen=${defen} l=${l} → ${expect}`);
    }

    /* 満貫のない手(1000点)では档位语音を付けない */
    assert.equal(reveal.tierVoice({ defen: 1000, l: 1 }), null);

    /* キューの組み立て:役種 → 宝牌 → 档位 の順で並ぶ */
    const hule = { l: 1, defen: 12000, fu: 30, fanshu: 5,
                   hupai: [ { name: '立直',   fanshu: 1 },
                            { name: '一発',   fanshu: 1 },
                            { name: '平和',   fanshu: 1 },
                            { name: 'ドラ',   fanshu: 2 },
                            { name: '赤ドラ', fanshu: 1 } ] };
    const steps = reveal.buildSteps(fake_rows(5), fake_row(), hule);
    const queue = steps.map(s=>s.voiceName);

    assert.deepEqual(queue,
                     [ 'yaku_liqi', 'yaku_yifa', 'yaku_pinghu',
                       'yaku_dora2', 'yaku_dora1', 'yaku_tiaoman' ],
                     '役種 → 宝牌(種類ごとに分計) → 档位 の順に並ぶ');

    /* 显现ステップも役種行ぶん + 点数行 = 6 ある */
    assert.equal(steps.length, 6);
    assert.equal(typeof steps[0].reveal, 'function', '各行に显现コールバックがある');
});

test('loaddata.pug：yaku_* の audio だけ preload="none" になっている', ()=>{

    const pug = fs.readFileSync(
                    path.join(ROOT, 'src', 'html', 'inc', 'loaddata.pug'), 'utf8');
    const tags = pug.split('\n').filter(l=>/<audio /.test(l));

    assert.equal(tags.length, 84, 'audio タグは 84 個');

    const yaku = tags.filter(l=>/data-name="yaku_/.test(l));
    const sfx  = tags.filter(l=>!/data-name="yaku_/.test(l));
    assert.equal(yaku.length, 75);
    assert.equal(sfx.length,   9);

    /* 役種/宝牌/档位のタグは preload="none"（読み込み時に WebMediaPlayer を
     * 占有しない＝ Chromium の上限で後半の音が死ぬのを防ぐ） */
    for (const line of yaku) {
        assert.match(line, /preload="none"/,
                     `preload="none" がない: ${line.trim()}`);
    }
    /* 効果音は従来どおり preload（oncanplaythrough で音量を先に設定するため） */
    for (const line of sfx) {
        assert.doesNotMatch(line, /preload="none"/,
                     `効果音に preload="none" を入れてはいけない: ${line.trim()}`);
    }
});
