/*!
 *  電脳麻将: ネット対戦 v2.5.3
 *
 *  Copyright(C) 2017 Satoshi Kobayashi
 *  Released under the MIT license
 *  https://github.com/kobalab/Majiang/blob/master/LICENSE
 */
"use strict";

const { hide, show, fadeIn, scale,
        setSelector, clearSelector  } = Majiang.UI.Util;

const preset = require('./conf/rule.json');

require('./paipu-download-fix');   // 牌譜保存のWebView互換レイヤー

require('./lizhi-patch');          // 立直の取り消しと待ち牌ヒント

const base = location.pathname.replace(/\/[^\/]*?$/,'');

let loaded;

$(function(){

    const pai   = Majiang.UI.pai($('#loaddata'));
    const audio = Majiang.UI.audio($('#loaddata'));

    const analyzer = (kaiju)=>{
        $('body').addClass('analyzer');
        return new Majiang.UI.Analyzer($('#board > .analyzer'), kaiju, pai,
                                        ()=>$('body').removeClass('analyzer'));
    };
    const viewer = (paipu)=>{
        $('#board .controller').addClass('paipu')
        $('body').attr('class','board');
        scale($('#board'), $('#space'));
        return new Majiang.UI.Paipu(
                        $('#board'), paipu, pai, audio, 'Majiang.pref',
                        ()=>fadeIn($('body').attr('class','file')),
                        analyzer);
    };
    const stat = (paipu_list)=>{
        fadeIn($('body').attr('class','stat'));
        return new Majiang.UI.PaipuStat($('#stat'), paipu_list,
                        ()=>fadeIn($('body').attr('class','file')));
    };
    const file = new Majiang.UI.PaipuFile($('#file'), 'Majiang.netplay',
                                            viewer, stat);
    let sock, myuid;

    /* ---- 局域网联机屏(#lanmode) ---- */

    let lan_state = null;       // { enabled, url, local } / null はサーバー不可

    function update_lan(state) {

        lan_state = state;
        const toggle = $('#lanmode .lan-toggle');
        const state_p = $('#lanmode .state');
        const invite = $('#lanmode .invite');
        const err    = $('#lanmode .error');

        err.addClass('hide').text('');

        if (! state) {          // 対戦サーバーが見つからない
            toggle.addClass('hide');
            state_p.text('対戦サーバーに接続できません');
            invite.text('');
            return;
        }

        /* ゲスト端末(local=false)は待ち受けアドレスを切り替えられない */
        const is_local = state.local !== false;
        toggle.toggleClass('hide', ! is_local);
        toggle.toggleClass('on', !! state.enabled);
        toggle.text(state.enabled ? '局域网联机:ON'
                                  : '局域网联机:OFF');
        state_p.text(! is_local
                    ? 'この端末は招待リンクから参加しています'
                      + '(联机の切替はホスト側で行います)'
                    : state.enabled
                    ? 'ON:同じ LAN 内のデバイスが招待 URL で参加できます'
                    : 'OFF:この端末からだけアクセスできます');
        invite.text(state.url ? `邀请链接 ${state.url}` : '');
    }

    /* 切替に失敗したときの表示(例:部屋・対局中は 409 で拒否される) */
    function update_lan_error(msg) {
        const err = $('#lanmode .error');
        err.removeClass('hide')
           .text(msg || '切り替えできませんでした');
    }

    function show_lanmode() {
        fetch(`${base}local/lan`).then(res=>res.json())
            .then(state=>update_lan(state))
            .catch(()=>update_lan(null));
        fadeIn($('body').attr('class','lanmode'));
    }

    function lan_confirmed() {
        try { return sessionStorage.getItem('Majiang.lan') }
        catch (e) { return null }
    }

    /* 「対戦へ進む」:認証状態に応じて牌譜/入室画面かログイン画面へ */
    function proceed() {

        try { sessionStorage.setItem('Majiang.lan', '1') } catch (e) {}

        if (myuid) {
            fadeIn($('body').attr('class','file'));
            file.redraw();
        }
        else {
            $('body').attr('class','title');
            show($('#title .login'));
        }
    }

    function init() {

        sock = io('/', { path: `${base}/server/socket.io/`});

        $(window).on('pagehide', ()=>{ if (sock) sock.disconnect() });
        $(window).on('pageshow', ()=>{ if (sock) sock.connect() });

        sock.on('HELLO', hello);
        sock.on('ROOM', room);
        sock.on('START', start);
        sock.on('END', end);
        sock.on('ERROR', file.error);
        sock.on('disconnect', ()=>hide($('#file .netplay form.room')));

        $('#lanmode .lan-toggle').on('click', ()=>{
            const enable = ! (lan_state && lan_state.enabled);
            fetch(`${base}local/lan`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ enabled: enable }),
                })
                .then(async (res)=>{
                    let state = {};
                    try { state = await res.json() } catch (e) { /* 本文なし */ }
                    if (! res.ok) {         // 409:部屋/対局中など
                        update_lan_error(state.error);
                        return;
                    }
                    update_lan(state);
                })
                .catch(()=>update_lan(null));
            return false;
        });
        $('#lanmode .proceed').on('click', proceed);

        hide($('#title .loading'));
        show_lanmode();
    }

    function hello(user) {
        if (user) {
            myuid = user.uid;
            show($('#file .netplay form'));
            if (user.icon)
                $('#file .netplay img').attr('src', user.icon)
                                       .attr('title', user.uid);
            $('#file .netplay .name').text(user.name);
            $('#file .netplay form.rename input[name="name"]')
                .attr('placeholder', user.name);
            file.redraw();
        }
        else {
            myuid = null;
        }
        /* LAN 確認済みなら LAN 屏を飛ばして進む */
        if (lan_confirmed()) proceed();
    }

    let row, src;

    function room(msg) {
        if (! row) {
            row = $('#room .user').eq(0);
            src = $('img', row).attr('src');
        }
        $('body').attr('class','room');
        $('#room input[name="room_no"]').val(msg.room_no);
        $('#room .room').empty();
        for (let user of msg.user) {
            let r = row.clone();
            if (user.icon) $('img', r).attr('src', user.icon)
                                      .attr('title', user.uid);
            else           $('img', r).attr('src', src);
            $('.name', r).text(user.name);
            if (msg.user[0].uid == myuid || user.uid == myuid )
                show($('input[name="quit"]', r).on('click', ()=> {
                        sock.emit('ROOM', msg.room_no, user.uid);
                        return false;
                    }));
            if (user.offline) r.addClass('offline');
            else              r.removeClass('offline');
            $('#room .room').append(r);
        }
        if (msg.user[0].uid == myuid) {
            show($('#room select[name="rule"]'));
            show($('#room input[name="timer"]'));
            show($('#room input[type="submit"]'));
        }
        else {
            hide($('#room select[name="rule"]'));
            hide($('#room input[name="timer"]'));
            hide($('#room input[type="submit"]'));
        }
    }

    function start() {

        const player = new Majiang.UI.Player($('#board'), pai, audio);
        player.view  = new Majiang.UI.Board($('#board .board'), pai, audio,
                                                player.model);

        const gameCtl = new Majiang.UI.GameCtl($('#board'), 'Majiang.pref',
                                                null, player, player._view);
        gameCtl._view.no_player_name = false;

        let players = [];

        $('#board .controller').removeClass('paipu')
        $('body').attr('class','board');
        scale($('#board'), $('#space'));
        let seq = 0;
        sock.removeAllListeners('GAME');
        sock.on('GAME', (msg)=>{
            if (msg.players) {
                players = msg.players;
            }
            else if (msg.say) {
                player._view.say(msg.say.name, msg.say.l);
            }
            else if (msg.seq) {
                if (seq && msg.seq != seq) location.reload();
                player.action(msg, (reply = {})=>{
                    reply.seq = msg.seq;
                    sock.emit('GAME', reply);
                    seq = msg.seq + 1;
                });
                if (msg.jieju) {
                    file.add(msg.jieju, 10);
                }
            }
            else {
                player.action(msg);
                if (msg.kaiju && msg.kaiju.log) {
                    let log = msg.kaiju.log.pop();
                    for (let data of log) {
                        player.action(data);
                    }
                }
            }
            player._view.players(players);
        });
    }

    function end(paipu) {
        sock.removeAllListeners('GAME');
        fadeIn($('body').attr('class','file'));
        file.redraw();
        $('#file input[name="room_no"]').val('');
    }

    for (let key of Object.keys(preset)) {
        $('select[name="rule"]').append($('<option>').val(key).text(key));
    }
    if (localStorage.getItem('Majiang.rule')) {
        $('select[name="rule"]').append($('<option>')
                                .val('-').text('カスタムルール'));
    }

    $('#file form.room').on('submit', (ev)=>{
        let room = $('input[name="room_no"]', $(ev.target)).val();
        sock.emit('ROOM', room);
        return false;
    });
    $('#room form').on('submit', (ev)=>{
        let room = $('input[name="room_no"]', $(ev.target)).val();

        let rule = $('select[name="rule"]', $(ev.target)).val();
        rule = ! rule      ? {}
             : rule == '-' ? JSON.parse(
                                localStorage.getItem('Majiang.rule')||'{}')
             :               preset[rule];
        rule = Majiang.rule(rule);

        let timer = $('input[name="timer"]', $(ev.target)).val();
        timer = timer.match(/(\d+)/g);
        if (timer) timer = timer.map(t=>+t);

        sock.emit('START', room, rule, timer);
        return false;
    });

    $(window).on('resize', ()=>scale($('#board'), $('#space')));

    $(window).on('load', ()=>setTimeout(init, 500));
    if (loaded) $(window).trigger('load');

    /* 未実装の外部認証(Hatena / Google)だけを探测してボタンを隠す。
     *  - ローカル登録(server/auth/)は自分たちのサーバーが必ず実装しているので
     *    探测しない(GET だと 404 で消えてしまう)。
     *  - 探测は GET で行う。以前はフォームの method(POST)で空 body を投げていたが、
     *    サーバー側で「名前なしログイン(ななし)」として扱われ、毎回ページを
     *    読み込むたびにセッションの名前を上書きしてしまっていた。 */
    $('#title .login form').not('.local').each(function(){
        fetch($(this).attr('action'), { method: 'GET', redirect: 'manual' })
            .then(res =>{ if (res.status == 404) hide($(this)) })
            .catch(()=>{});
    });
});
$(window).on('load', ()=> loaded = true);
