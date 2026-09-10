/*
 * 役种语音初始化
 * 独立模块，不修改游戏核心逻辑
 */

const YakuVoicePlayer = require('./yaku-voice-player');

module.exports = function(audio, storage = 'Majiang.pref') {
    // 初始化役种语音播放器
    const yakuVoicePlayer = new YakuVoicePlayer(audio);

    let lastDialogState = false;
    let hasPlayedForCurrentDialog = false;

    // 读取音效开关。GameCtl 每次切换都会把 sound_on 写回 localStorage，
    // 所以在播放时读取才能拿到当前状态（初始化时读会一直是旧值）。
    // 键不存在时按游戏默认值 true 处理。
    function isSoundOn() {
        try {
            const pref = localStorage.getItem(storage);
            if (! pref) return true;
            return JSON.parse(pref).sound_on !== false;
        } catch (e) {
            return true;
        }
    }

    // 定时检查和牌对话框的显示状态
    const intervalId = setInterval(() => {
        const $dialog = $('.hule-dialog');
        const isVisible = $dialog.is(':visible') && !$dialog.hasClass('hide');

        // 检测到对话框从隐藏变为显示
        if (isVisible && !lastDialogState) {
            lastDialogState = true;
            hasPlayedForCurrentDialog = false;

            // 延迟一下，确保内容已渲染
            setTimeout(() => {
                if (!hasPlayedForCurrentDialog && isSoundOn()) {
                    const hupaiData = extractHupaiFromDialog($dialog);

                    if (hupaiData && hupaiData.hupai.length > 0) {
                        hasPlayedForCurrentDialog = true;
                        yakuVoicePlayer.playYakuList(hupaiData.hupai);
                    }
                }
            }, 300);
        }
        // 对话框关闭了
        else if (!isVisible && lastDialogState) {
            lastDialogState = false;
            hasPlayedForCurrentDialog = false;
        }
    }, 200); // 每200ms检查一次

    // 页面卸载时停止轮询，避免常驻定时器空转
    $(window).on('beforeunload', () => clearInterval(intervalId));

    // 从和牌对话框中提取役种信息
    function extractHupaiFromDialog($dialog) {
        try {
            const hupai = [];

            // 查找所有役种行（tr.r_hupai）
            $dialog.find('table.hupai tr.r_hupai').each(function() {
                const $row = $(this);

                // 跳过隐藏的行
                if ($row.css('display') === 'none' || $row.hasClass('hide')) {
                    return;
                }

                // 获取完整的name文本，清理空格和换行
                let nameText = $row.find('td.name').text().replace(/\s+/g, ' ').trim();
                const fanshuText = $row.find('td.fanshu').text().trim();

                if (nameText) {
                    // 提取番数（去除"翻"字和其他非数字字符）。役满行番数为 '*'，parse 后为 0，
                    // 不影响宝牌计数（宝牌行的 fanshu 才是真正的数量）。
                    const fanshu = parseInt(fanshuText.replace(/[^\d]/g, '')) || 0;
                    hupai.push({ name: nameText, fanshu: fanshu });
                }
            });

            return { hupai: hupai };
        } catch (e) {
            console.error('[yaku-voice] 役种提取失败:', e);
            return { hupai: [] };
        }
    }
};
