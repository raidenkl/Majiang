/*
 * 役种语音播放器
 * 用于和牌后依次播报役种名称
 */

module.exports = class YakuVoicePlayer {
    constructor(audioLoader) {
        this._audio = audioLoader;
        this._playing = false;
        this._queue = [];
        this._generation = 0;   // 序列代号：新序列/取消时自增，旧序列据此中止

        // 役种名称到语音文件的映射表
        this._yakuMap = {
            '立直':             'yaku_liqi',
            'リーチ':           'yaku_liqi',
            '一発':             'yaku_yifa',
            'イーファー':       'yaku_yifa',
            '門前清自摸和':     'yaku_zimo',
            'ツモ':             'yaku_zimo',
            '平和':             'yaku_pinghu',
            'ピンフ':           'yaku_pinghu',
            '断幺九':           'yaku_duanyao',
            'タンヤオ':         'yaku_duanyao',
            '一盃口':           'yaku_yibeikou',
            'イーペーコー':     'yaku_yibeikou',
            '役牌 東':          'yaku_dong',
            '役牌 南':          'yaku_nan',
            '役牌 西':          'yaku_xi',
            '役牌 北':          'yaku_bei',
            '役牌 白':          'yaku_bai',
            '役牌 發':          'yaku_fa',
            '役牌 中':          'yaku_zhong',
            '翻牌 東':          'yaku_dong',
            '翻牌 南':          'yaku_nan',
            '翻牌 西':          'yaku_xi',
            '翻牌 北':          'yaku_bei',
            '翻牌 白':          'yaku_bai',
            '翻牌 發':          'yaku_fa',
            '翻牌 中':          'yaku_zhong',
            '自風 東':          'yaku_dong',
            '自風 南':          'yaku_nan',
            '自風 西':          'yaku_xi',
            '自風 北':          'yaku_bei',
            '場風 東':          'yaku_dong',
            '場風 南':          'yaku_nan',
            '場風 西':          'yaku_xi',
            '場風 北':          'yaku_bei',
            '連風牌 東':        'yaku_doubledong',
            '連風牌 南':        'yaku_doublenan',
            '連風牌 西':        'yaku_doublexi',
            '連風牌 北':        'yaku_doublebei',
            '海底摸月':         'yaku_haidi',
            '河底撈魚':         'yaku_hedi',
            '嶺上開花':         'yaku_lingshang',
            '槍槓':             'yaku_qianggang',
            'ダブル立直':       'yaku_dliqi',
            'ダブルリーチ':     'yaku_dliqi',
            '三色同順':         'yaku_sansetongshun',
            'サンショク':       'yaku_sansetongshun',
            '一気通貫':         'yaku_yiqitongguan',
            'イッツー':         'yaku_yiqitongguan',
            '混全帯幺九':       'yaku_hunquandaiyaojiu',
            'チャンタ':         'yaku_hunquandaiyaojiu',
            '七対子':           'yaku_qiduizi',
            'チートイツ':       'yaku_qiduizi',
            '対々和':           'yaku_duiduihu',
            'トイトイ':         'yaku_duiduihu',
            '三暗刻':           'yaku_sananke',
            'サンアンコー':     'yaku_sananke',
            '三色同刻':         'yaku_sansetongke',
            'サンショクドーコー': 'yaku_sansetongke',
            '三槓子':           'yaku_sangangzi',
            'サンカンツ':       'yaku_sangangzi',
            '混老頭':           'yaku_hunlaotou',
            'ホンロー':         'yaku_hunlaotou',
            '小三元':           'yaku_xiaosanyuan',
            'ショウサンゲン':   'yaku_xiaosanyuan',
            '二盃口':           'yaku_erbeikou',
            'リャンペーコー':   'yaku_erbeikou',
            '混一色':           'yaku_hunyise',
            'ホンイツ':         'yaku_hunyise',
            '純全帯幺九':       'yaku_chunquandaiyaojiu',
            'ジュンチャン':     'yaku_chunquandaiyaojiu',
            '清一色':           'yaku_qingyise',
            'チンイツ':         'yaku_qingyise',
            '天和':             'yaku_tianhu',
            '地和':             'yaku_dihu',
            '大三元':           'yaku_dasanyuan',
            '大四喜':           'yaku_dasixi',
            '小四喜':           'yaku_xiaosixi',
            '字一色':           'yaku_ziyise',
            '緑一色':           'yaku_lvyise',
            '清老頭':           'yaku_qinglaotou',
            '四暗刻':           'yaku_sianke',
            '四暗刻単騎':       'yaku_siankedanqi',
            '四槓子':           'yaku_sigangzi',
            '九蓮宝燈':         'yaku_jiulianbaodeng',
            '純正九蓮宝燈':     'yaku_chunzhengjiulianbaodeng',
            '国士無双':         'yaku_guoshiwushuang',
            '国士無双十三面':   'yaku_guoshishisanmian',
            '流し満貫':         'yaku_liujumanguan',
        };
    }

    /**
     * 依序执行演出步骤：显现一行 ↔ 播报一句（雀魂式）。
     * @param {Array} steps - 每项 { voiceName, reveal }：
     *   - reveal: 显现该步对应 DOM 行的回调（同步执行）
     *   - voiceName: 语音 key；缺失（映射不到/音频文件没放）时只显现不播报
     * @returns {boolean} 是否完整播完（false = 被新序列或弹窗关闭打断）
     *
     * generation token：新序列开始会使旧序列失效，防连续两局串音。
     */
    async playSteps(steps) {
        if (! steps || steps.length === 0) return true;
        if (this._playing) return false;

        /* 播报队列打一行日志：真机上「哪些没响」可以直接和它对照 */
        console.log('[yaku-voice] 演出队列: '
            + steps.map(s => s.voiceName || '(无声音)').join(' → '));

        this._playing = true;
        const gen = ++this._generation;

        try {
            for (let step of steps) {
                if (gen !== this._generation) return false;   // 被新序列取代

                if (typeof step.reveal === 'function') step.reveal();

                if (step.voiceName) {
                    await this._playVoice(step.voiceName);
                    await this._delay(250);   // 播完后的短停顿
                } else {
                    await this._delay(300);   // 无语音的行也给个节奏
                }
            }
            return gen === this._generation;
        } finally {
            if (gen === this._generation) this._playing = false;
        }
    }

    /**
     * 使当前正在进行的序列立即失效（弹窗被关闭/新和牌开始时调用）。
     * 正在播的语音靠 onended/超时自然结束，不会再推进下一步。
     */
    cancel() {
        this._generation++;
        this._playing = false;
    }

    /**
     * 播放和牌的役种列表（旧接口：无显现回调，仅排队播报）
     * @param {Array} hupai - 役种数组，每项 { name, fanshu }
     *
     * 宝牌数量取自「ドラ」/「赤ドラ」自己那几行的番数之和，
     * 不需要总番数 —— 早先版本用「总番数 - 役种番数」反推，多余且易错。
     */
    async playYakuList(hupai) {
        if (!hupai || hupai.length === 0) return;

        // 处理每个役种
        let doraCount = 0;
        const queue = [];
        for (let yaku of hupai) {
            let name = yaku.name;

            // 跳过ドラ/赤ドラ/裏ドラ，统一计数后处理
            // （裏ドラ按需求并进普通宝牌数量一起播报）
            if (name.includes('ドラ') || name.includes('宝牌')) {
                doraCount += yaku.fanshu || 0;
                continue;
            }

            let voiceName = this._getVoiceName(name);

            if (voiceName) {
                queue.push({ voiceName: voiceName });
            } else {
                // 役名和映射表不一致时唯一的线索，保留
                console.warn('[yaku-voice] 未找到映射:', JSON.stringify(name));
            }
        }

        // 处理宝牌
        if (doraCount > 0) {
            queue.push({ voiceName: `yaku_dora${Math.min(doraCount, 13)}` });
        }

        console.log('[yaku-voice] 播放队列:', queue.map(s=>s.voiceName).join(' → '));
        await this.playSteps(queue);
    }

    /**
     * 获取役种对应的语音名称（公开接口，供演出模块查询）。
     * 役牌/連風牌 的各种写法直接写在映射表里，不做前缀拆解 ——
     * 拆完再拼回去得到的是同一个 key，等于没查。
     */
    getVoiceName(yakuName) {
        return this._yakuMap[yakuName] || null;
    }

    /* 内部沿用旧名 */
    _getVoiceName(yakuName) {
        return this.getVoiceName(yakuName);
    }

    /**
     * 播放单个语音
     *
     * ⚠️ 用完必须释放播放器：Chromium 从 92 起限制每个 tab 的 WebMediaPlayer
     * 数量(桌面 75，crbug.com/1144736)，超限后新建的 audio 元素 play() 不出声、
     * 一直停在加载态。以前每次播报都用 Majiang.UI.audio() 克隆新元素且从不清
     * src，于是演出越靠后的声音越容易哑掉(实测：満貫以上档位语音从未响过、
     * 宝牌时有时无、靠后的役种也会缺)。现在统一在 finish() 里清 src 触发回收，
     * 模板元素不受影响，下次仍能克隆出可播的新元素。
     */
    _playVoice(voiceName) {
        // 这个 Promise 只 resolve，不 reject：一条语音失败不应该中断整个队列。
        // 同时用超时兜底，避免 onended 不触发时永久挂起。
        return new Promise((resolve) => {
            let done = false;
            let audio;
            const finish = (reason) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                /* 播放器回收：先摘回调再清 src，避免清理过程回调重入 */
                if (audio) {
                    audio.onended = null;
                    audio.onerror = null;
                    try {
                        audio.removeAttribute('src');
                        audio.load();           // 触发资源/播放器释放
                    } catch (e) { /* 清理失败不影响演出 */ }
                }
                if (reason) console.warn(`[yaku-voice] ${voiceName}: ${reason}`);
                resolve();
            };

            const timer = setTimeout(
                () => finish('timeout (onended 未触发)'), 5000);

            try {
                audio = this._audio(voiceName);
            } catch (err) {
                return finish(`音频元素获取失败 - ${err.message}`);
            }
            if (!audio) return finish('音频元素不存在（data-name 未匹配？）');

            /* 音量立即套用（#loaddata 模板上的 volume 属性）。
             * Majiang.UI.audio() 只在 oncanplaythrough 时才设音量，而
             * preload="none" 的元素是「先 play() 后加载」＝会以 1.0 播一瞬；
             * 这里提前设好，音量与预载时代完全一致。 */
            const volume = audio.getAttribute && audio.getAttribute('volume');
            if (volume) {
                try { audio.volume = + volume } catch (e) { /* 非致命 */ }
            }

            audio.onended = () => finish();
            audio.onerror = () => finish(
                `加载失败 readyState=${audio.readyState} `
              + `networkState=${audio.networkState} src=${audio.currentSrc}`);

            let p = audio.play();
            if (p && p.catch) {
                p.catch(err => finish(`play() 被拒绝 - ${err.name}: ${err.message}`));
            }
        });
    }

    /**
     * 延迟函数
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
