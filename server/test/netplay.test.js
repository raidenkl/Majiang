/*!
 *  電脳麻将: ネット対戦サーバー 結合テスト
 *
 *  実サーバーを ephemeral port で起動し、socket.io-client で模擬クライアントを
 *  接続して HELLO/ROOM/START/GAME/END の一連の流れを検証する。
 *
 *  実行: node --test server/test/
 */
"use strict";

const test   = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');
const Majiang = require('@kobalab/majiang-core');

const { create_app } = require('../index');

const TIMEOUT_MS = 180 * 1000;      // AI 対局の完走待ち

/* ---- テスト用ユーティリティ ---- */

function start_server(opts) {
    const app = create_app(null, opts);     // 静的ファイルは不要
    const host = app.lan.enabled ? '0.0.0.0' : '127.0.0.1';
    return new Promise(resolve =>
        app.server.listen({ port: 0, host }, ()=>resolve(app)));
}

function base_url(server) {
    return `http://127.0.0.1:${server.address().port}`;
}

/* 待ち受けアドレスの切替(200ms 遅延)完了を待つ */
async function wait_address(server, address, ms = 3000) {
    const t0 = Date.now();
    for (;;) {
        const addr = server.address();
        if (addr && addr.address == address) return;
        if (Date.now() - t0 > ms) break;
        await new Promise(r=>setTimeout(r, 50));
    }
    assert.fail(`address が ${address} になりません`);
}

function wait_hello(sock, ms = 5000) {
    return new Promise((resolve, reject)=>{
        const t = setTimeout(()=>reject(new Error('HELLO timeout')), ms);
        sock.on('HELLO', u=>{ clearTimeout(t); resolve(u) });
        sock.on('connect_error', e=>{ clearTimeout(t); reject(e) });
    });
}

/* ゲストログインして socket.io を張り、HELLO を待つ */
async function connect(base, name) {

    const res = await fetch(`${base}/server/auth/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body:    `name=${encodeURIComponent(name)}&passwd=*`,
        redirect: 'manual',
    });
    assert.ok([200, 302].includes(res.status), `ログイン成功 status=${res.status}`);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('connect.sid='), 'セッション cookie を取得');

    const sock = io(base, {
        path: '/server/socket.io/',
        extraHeaders: { Cookie: cookie },
        transports:   [ 'websocket' ],
        reconnection: false,
    });
    const hello = await wait_hello(sock);
    return { sock, uid: hello && hello.uid,
             name: hello && hello.name, cookie };
}

/* 同一セッション cookie での再接続。setup は HELLO より先に
 * リスナを登録させるために使う(復元メッセージの取りこぼし防止) */
async function reconnect_same_session(base, cookie, setup) {

    const sock = io(base, {
        path: '/server/socket.io/',
        extraHeaders: { Cookie: cookie },
        transports:   [ 'websocket' ],
        reconnection: false,
    });
    if (setup) setup(sock);
    const hello = await wait_hello(sock);
    return { sock, uid: hello && hello.uid, name: hello && hello.name };
}

function send(sock, event, ...args) { sock.emit(event, ...args) }

function wait_event(sock, event, pred = ()=>true, ms = TIMEOUT_MS) {
    return new Promise((resolve, reject)=>{
        const timer = setTimeout(()=>{
            sock.off(event, handler);
            reject(new Error(`${event} timeout`));
        }, ms);
        const handler = (...args)=>{
            if (! pred(...args)) return;
            clearTimeout(timer);
            sock.off(event, handler);
            resolve(args);
        };
        sock.on(event, handler);
    });
}

/* seq 付き GAME メッセージにすべて即座に空応答で返すボット
 * (エンジンは空応答をパス/ツモ切りの自動処理に置き換える) */
function auto_reply(sock) {
    sock.on('GAME', msg=>{
        if (msg && msg.seq) send(sock, 'GAME', { seq: msg.seq });
    });
}

async function close(sock) {
    if (sock.disconnected) return;
    await new Promise(resolve=>{ sock.on('disconnect', resolve);
                                sock.disconnect() });
}

/* ---- テスト ---- */

test('ログインと HELLO', async ()=>{

    const { server } = await start_server();
    try {
        const base = base_url(server);

        const client = await connect(base, 'テスト太郎');
        assert.ok(client.uid, 'uid をもらう');
        assert.equal(client.name, 'テスト太郎');
        await close(client.sock);

        /* 未ログインの接続は HELLO null */
        const sock = io(base, { path: '/server/socket.io/',
                                transports: [ 'websocket' ],
                                reconnection: false });
        assert.equal(await wait_hello(sock), null, '未ログインは null');
        sock.disconnect();
    }
    finally {
        server.closeAllConnections?.();
        await new Promise(r=>{
            server.close(r);
            setTimeout(r, 3000).unref?.();
        });
    }
});

test('部屋の作成・入室・満員・退室', async ()=>{

    const { server } = await start_server();
    try {
        const base   = base_url(server);
        const a      = await connect(base, 'A');
        const b      = await connect(base, 'B');
        const others = [];
        for (let i = 0; i < 3; i++) others.push(await connect(base, `X${i}`));

        /* A が部屋を作成 */
        let p = wait_event(a.sock, 'ROOM');
        send(a.sock, 'ROOM', 'room-test');
        let msg = (await p)[0];
        assert.equal(msg.room_no, 'room-test');
        assert.equal(msg.user.length, 1);
        assert.equal(msg.user[0].uid, a.uid);

        /* B が入室 */
        p = wait_event(a.sock, 'ROOM', m => m.user.length == 2);
        const q = wait_event(b.sock, 'ROOM');
        send(b.sock, 'ROOM', 'room-test');
        msg = (await p)[0];
        assert.equal(msg.user[0].uid, a.uid, '先入室者が部屋の主');
        assert.equal(msg.user[1].uid, b.uid);
        assert.equal((await q)[0].user.length, 2);

        /* X0, X1 が入室 → 4 人で満員 */
        for (let i = 0; i < 2; i++) {
            const c = others[i];
            p = wait_event(a.sock, 'ROOM', m => m.user.length == 3 + i);
            send(c.sock, 'ROOM', 'room-test');
            await p;
        }

        /* 5 人目は満員で ERROR */
        const e = await connect(base, 'Z');
        let perr = wait_event(e.sock, 'ERROR', undefined, 5000);
        send(e.sock, 'ROOM', 'room-test');
        assert.ok(typeof (await perr)[0] == 'string');
        await close(e.sock);

        /* 入室できなかった X2 も満員で ERROR */
        const x2 = others[2];
        perr = wait_event(x2.sock, 'ERROR', undefined, 5000);
        send(x2.sock, 'ROOM', 'room-test');
        assert.ok((await perr)[0]);

        /* B が退室(自分の uid を指定) */
        p = wait_event(a.sock, 'ROOM', m => m.user.length == 3);
        send(b.sock, 'ROOM', 'room-test', b.uid);
        msg = (await p)[0];
        assert.ok(! msg.user.find(u => u.uid == b.uid));

        /* 他人の uid での退室は部屋の主しかできない */
        perr = wait_event(x2.sock, 'ERROR', undefined, 5000);
        send(x2.sock, 'ROOM', 'room-test', a.uid);
        assert.ok((await perr)[0], '部屋の主以外の強制退室は ERROR');

        for (const c of [a, b, ...others]) await close(c.sock);
    }
    finally {
        server.closeAllConnections?.();
        await new Promise(r=>{
            server.close(r);
            setTimeout(r, 3000).unref?.();
        });
    }
});

test('部屋の主以外は対局を開始できない', async ()=>{

    const { server } = await start_server();
    try {
        const base = base_url(server);
        const a = await connect(base, 'A');
        const b = await connect(base, 'B');

        send(a.sock, 'ROOM', 'room-owner');
        await wait_event(a.sock, 'ROOM');
        send(b.sock, 'ROOM', 'room-owner');
        await wait_event(a.sock, 'ROOM', m => m.user.length == 2);

        const perr = wait_event(b.sock, 'ERROR', undefined, 5000);
        const rule = Majiang.rule({ '場数': 0 });
        send(b.sock, 'START', 'room-owner', rule, [ 5 ]);
        assert.ok((await perr)[0], '部屋の主以外の START は ERROR');

        await close(a.sock);
        await close(b.sock);
    }
    finally {
        server.closeAllConnections?.();
        await new Promise(r=>{
            server.close(r);
            setTimeout(r, 3000).unref?.();
        });
    }
});

test('1人 + AI 3人で一局完走', { timeout: 300 * 1000 }, async ()=>{

    const { server } = await start_server();
    try {
        const base = base_url(server);
        const a    = await connect(base, 'solo');
        auto_reply(a.sock);

        const p_room_join = wait_event(a.sock, 'ROOM');
        send(a.sock, 'ROOM', 'solo');
        await p_room_join;

        /* 対局開始(一局戦) */
        const game_msgs = [];
        a.sock.on('GAME', msg => game_msgs.push(msg));

        let rooms_seen = 0;
        const p_back = wait_event(a.sock, 'ROOM', ()=>++rooms_seen >= 1);

        /* 一局戦 + 連荘なし:1 局で必ず終わる */
        const rule = Majiang.rule({ '場数': 0, '連荘方式': 0 });
        send(a.sock, 'START', 'solo', rule, [ 5 ]);

        await wait_event(a.sock, 'START');
        await wait_event(a.sock, 'END');
        const back = (await p_back)[0];

        /* seq は 1 から単調増加 */
        const seqs = game_msgs.filter(m => m.seq).map(m => m.seq);
        assert.ok(seqs.length > 10, `十分な数の seq メッセージ (${seqs.length})`);
        assert.deepEqual(seqs, seqs.map((_, i)=>i + 1), 'seq は 1 から単調増加');

        const kaiju = game_msgs.map(m => m.kaiju).find(Boolean);
        assert.equal(kaiju.id, 0, 'human は player id 0');
        assert.deepEqual(kaiju.player, [ a.name, 'CPU', 'CPU', 'CPU' ],
                         '対局者名が反映される');

        /* qipai は自分の席の手牌だけが見える
         * (席 l = player_id[l] == 0 となる席 = 開局の起家・局数から求まる) */
        const qipai = game_msgs.map(m => m.qipai).find(Boolean);
        const visible = qipai.shoupai
                    .map((s, i)=>[s, i]).filter(([s])=>0 < s.length);
        assert.equal(visible.length, 1, '手牌が見えるのは1席だけ');
        assert.ok(0 < visible[0][0].length, '自分の手牌は見える');
        assert.equal(visible[0][1],
                     (4 - (kaiju.qijia + qipai.jushu) % 4) % 4,
                     '見えるのは自分の席の牌');

        /* players 全員生存 */
        const players = game_msgs.map(m => m.players).find(Boolean);
        assert.deepEqual(players, [ true, true, true, true ]);

        /* jieju で牌譜一式がもらえる */
        const jieju = game_msgs.map(m => m.jieju).find(Boolean);
        assert.ok(jieju, 'jieju 付きのメッセージがある');
        assert.equal(jieju.rank.length, 4);
        assert.equal(jieju.point.length, 4);
        assert.ok(jieju.log.length >= 1, 'log がある');

        /* END のあと部屋に戻される */
        assert.equal(back.room_no, 'solo');
        assert.equal(back.user.length, 1);

        await close(a.sock);
    }
    finally {
        /* 失敗時も dangling な接続で抱き込まれないよう、
         * サーバー無応答なら 3 秒で諦める */
        server.closeAllConnections?.();
        await new Promise(r=>{
            server.close(r);
            setTimeout(r, 3000).unref?.();
        });
    }
});

test('対局中の切断・再接続', { timeout: 120 * 1000 }, async ()=>{

    const { server } = await start_server();
    try {
        const base = base_url(server);
        const a    = await connect(base, 'reconnect');
        auto_reply(a.sock);

        send(a.sock, 'ROOM', 'reconnect-room');
        await wait_event(a.sock, 'ROOM');

        /* 一局戦 + 連荘なし:1 局で必ず終わる */
        const rule = Majiang.rule({ '場数': 0, '連荘方式': 0 });
        send(a.sock, 'START', 'reconnect-room', rule, [ 3 ]);
        await wait_event(a.sock, 'START');

        /* seq メッセージを 3 つ受けてから切断 */
        let count = 0;
        await wait_event(a.sock, 'GAME',
                         m => m && m.seq && ++count >= 3, 30000);
        a.sock.disconnect();

        /* 少し待ってから同じセッションで再接続。
         * リスナは HELLO より先に register する(取りこぼし防止) */
        await new Promise(r=>setTimeout(r, 500));
        const resumed = [];
        let p_start;
        const b = await reconnect_same_session(base, a.cookie, sock=>{
            auto_reply(sock);
            sock.on('GAME', msg => resumed.push(msg));
            p_start = wait_event(sock, 'START', undefined, 30000);
        });
        assert.equal(b.uid, a.uid, '同一 uid で復帰');

        await p_start;

        /* 再接続直後:players → 開局(棋譜ログ付き) → 未応答 or 続行メッセージ */
        await new Promise((resolve, reject)=>{
            const check = ()=>{
                if (resumed.length < 2) return;
                assert.deepEqual(resumed[0].players,
                                 [ true, true, true, true ]);
                const kaiju = resumed[1].kaiju;
                assert.ok(kaiju, '開局メッセージ');
                assert.ok(Array.isArray(kaiju.log) && kaiju.log.length >= 1,
                          '棋譜ログ付き');
                resolve();
            };
            const t = setTimeout(
                ()=>reject(new Error('resume timeout')), 30000);
            b.sock.on('GAME', ()=>check());
            check();
        });

        /* 牌局が生きている:さらに 2 メッセージ受信できる */
        await new Promise((resolve, reject)=>{
            const check = ()=>{
                if (resumed.length < 4) return;
                clearTimeout(t);
                resolve();
            };
            const t = setTimeout(
                ()=>reject(new Error('対局再開 timeout')), 60000);
            b.sock.on('GAME', ()=>check());
            check();
        });

        await close(b.sock);
    }
    finally {
        server.closeAllConnections?.();
        await new Promise(r=>{
            server.close(r);
            setTimeout(r, 3000).unref?.();
        });
    }
});

test('局域网联机开关・ログアウト・ログイン回跳', async ()=>{

    const app = await start_server({ lan_default: false });
    const { server } = app;
    try {
        const base = base_url(server);

        /* 既定は OFF */
        let res = await fetch(`${base}/local/lan`);
        let state = await res.json();
        assert.equal(state.enabled, false);
        assert.equal(state.url, null);
        assert.equal(server.address().address, '127.0.0.1');

        /* ON に切替 → 0.0.0.0 で待ち受け、招待 URL がもらえる */
        res = await fetch(`${base}/local/lan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        });
        state = await res.json();
        assert.equal(state.enabled, true);
        assert.match(state.url,
                     /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\//);
        await wait_address(server, '0.0.0.0');

        /* GET でも状態を確認できる */
        assert.deepEqual(await (await fetch(`${base}/local/lan`)).json(),
                         state);

        /* 部屋が有効な間は OFF にできない(409) */
        const a = await connect(base, 'A');
        send(a.sock, 'ROOM', 'lan-room');
        await wait_event(a.sock, 'ROOM');
        res = await fetch(`${base}/local/lan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        });
        assert.equal(res.status, 409);
        await close(a.sock);

        /* 全員離席後は OFF に戻せる */
        res = await fetch(`${base}/local/lan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        });
        state = await res.json();
        assert.equal(state.enabled, false);
        assert.equal(state.url, null);
        await wait_address(server, '127.0.0.1');

        /* ログインの戻り先:to=netplay.html(既定) */
        res = await fetch(`${base}/server/auth/`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'name=X&passwd=*',
            redirect: 'manual',
        });
        assert.match(res.headers.get('location'), /\/netplay\.html$/);

        /* to=index.html なら ?netplay=1 付き */
        res = await fetch(`${base}/server/auth/`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'name=X&passwd=*&to=index.html',
            redirect: 'manual',
        });
        assert.match(res.headers.get('location'),
                     /\/index\.html\?netplay=1$/);

        /* logout すると同一 cookie の再接続で HELLO が null になる */
        const b = await connect(base, 'B');
        res = await fetch(`${base}/server/logout`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded',
                       Cookie: b.cookie },
            body: 'to=netplay.html',
            redirect: 'manual',
        });
        assert.match(res.headers.get('location'), /\/netplay\.html$/);
        const c = await reconnect_same_session(base, b.cookie);
        assert.equal(c.uid, null, 'ログアウト後は HELLO null');
        await close(c.sock);
        await close(b.sock);
    }
    finally {
        server.closeAllConnections?.();
        await new Promise(r=>{
            server.close(r);
            setTimeout(r, 3000).unref?.();
        });
    }
});
