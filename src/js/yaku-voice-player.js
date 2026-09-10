/*
 * 役种语音播放器
 * 用于和牌后依次播报役种名称
 */

module.exports = class YakuVoicePlayer {
    constructor(audioLoader) {
        this._audio = audioLoader;
        this._playing = false;
        this._queue = [];

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
     * 播放和牌的役种列表
     * @param {Array} hupai - 役种数组，每项 { name, fanshu }
     *
     * 宝牌数量取自「ドラ」/「赤ドラ」自己那几行的番数之和，
     * 不需要总番数 —— 早先版本用「总番数 - 役种番数」反推，多余且易错。
     */
    async playYakuList(hupai) {
        if (!hupai || hupai.length === 0) return;
        if (this._playing) return;

        this._playing = true;
        this._queue = [];

        // 处理每个役种
        let doraCount = 0;
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
                this._queue.push(voiceName);
            } else {
                // 役名和映射表不一致时唯一的线索，保留
                console.warn('[yaku-voice] 未找到映射:', JSON.stringify(name));
            }
        }

        // 处理宝牌
        if (doraCount > 0) {
            this._queue.push(`yaku_dora${Math.min(doraCount, 13)}`);
        }

        console.log('[yaku-voice] 播放队列:', this._queue.join(' → '));

        // 依次播放。用 try/finally 保证 _playing 一定会被释放，
        // 否则一次异常就会让播放器永久卡死，之后再也不出声。
        try {
            for (let voiceName of this._queue) {
                await this._playVoice(voiceName);
                await this._delay(300); // 300ms间隔
            }
        } finally {
            this._playing = false;
        }
    }

    /**
     * 获取役种对应的语音名称。役牌/連風牌 的各种写法直接写在映射表里，
     * 不做前缀拆解 —— 拆完再拼回去得到的是同一个 key，等于没查。
     */
    _getVoiceName(yakuName) {
        return this._yakuMap[yakuName] || null;
    }

    /**
     * 播放单个语音
     */
    _playVoice(voiceName) {
        // 这个 Promise 只 resolve，不 reject：一条语音失败不应该中断整个队列。
        // 同时用超时兜底，避免 onended 不触发时永久挂起。
        return new Promise((resolve) => {
            let done = false;
            const finish = (reason) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (reason) console.warn(`[yaku-voice] ${voiceName}: ${reason}`);
                resolve();
            };

            const timer = setTimeout(
                () => finish('timeout (onended 未触发)'), 5000);

            let audio;
            try {
                audio = this._audio(voiceName);
            } catch (err) {
                return finish(`音频元素获取失败 - ${err.message}`);
            }
            if (!audio) return finish('音频元素不存在（data-name 未匹配？）');

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
