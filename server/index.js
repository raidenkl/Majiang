/*!
 *  電脳麻将: ネット対戦サーバー
 *
 *  express + socket.io。静的ファイル(dist/)の配信、ゲストログイン、
 *  部屋/対局のイベントを処理する。
 *
 *  環境変数:
 *    PORT           リッスン番号(既定 3830)
 *    BASE_PATH      サブパスで運用するときの接頭辞(既定なし)
 *    SESSION_SECRET セッション署名鍵(既定は起動時に乱数生成)
 *    LAN_DEFAULT    起動直後の局域网開放(1/0、既定 1)。
 *                   桌面版(内蔵サーバー)は 0 で起動し、ページの
 *                   「局域网联机」ボタンで開放する。
 *
 *  起動: npm run server
 */
"use strict";

const path     = require('path');
const crypto   = require('crypto');
const os       = require('os');
const http     = require('http');
const express  = require('express');
const session  = require('express-session');
const { Server } = require('socket.io');
const Majiang  = require('@kobalab/majiang-core');

const { RoomManager } = require('./room');

const PORT          = process.env.PORT || 3830;
const BASE_PATH     = ('/' + (process.env.BASE_PATH || ''))
                      .replace(/\/+$/, '').replace(/^\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET
                      || crypto.randomBytes(48).toString('hex');
const NAME_MAX_LEN   = 20;

/* ログイン/ログアウト後の戻り先として認めるページ */
const REDIRECT_PAGES = ['index.html', 'netplay.html'];

/* クライアントから渡されるルール/持ち時間を安全な形に正規化する */
function normalize_rule(rule) {
    try {
        if (! rule || typeof rule != 'object' || Array.isArray(rule)) return {};
        return Majiang.rule(JSON.parse(JSON.stringify(rule)));
    } catch (e) { return {} }
}

function normalize_timer(timer) {
    if (! Array.isArray(timer)) return null;
    return timer.map(Number).filter(Number.isFinite).slice(0, 4);
}

/* 局域网への公開に使える IPv4 アドレス(なければ null) */
function lan_ip() {
    for (let list of Object.values(os.networkInterfaces())) {
        for (let ni of list) {
            if (ni.family == 'IPv4' && ! ni.internal) return ni.address;
        }
    }
    return null;
}

/*
 *  アプリを構築する。リッスンは行わない(呼び出し側で server.listen する)。
 *  戻り値の listen_host(host, cb) で、対話的に待ち受けアドレスを
 *  0.0.0.0(局域网開放) / 127.0.0.1(ローカルのみ)へ切り替えられる。
 */
function create_app(dist_dir, opts = {}) {

    const app = express();
    app.disable('x-powered-by');

    const session_middleware = session({
        secret:            SESSION_SECRET,
        resave:            false,
        saveUninitialized: true,
        cookie:            { httpOnly: true, sameSite: 'lax',
                             maxAge: 7 * 24 * 60 * 60 * 1000 },
    });

    /* 局域网開放の状態。false なら 127.0.0.1 だけで待ち受ける */
    const lan = {
        enabled: opts.lan_default != null ? !! opts.lan_default : true,
    };

    app.use(session_middleware);
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '1kb' }));

    function redirect_to(req, def) {
        const to = req.body && String(req.body.to || '');
        return REDIRECT_PAGES.includes(to) ? to : def;
    }

    /* ローカル(この端末)からのアクセスか */
    function is_local(req) {
        const peer = req.socket.remoteAddress || '';
        return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(peer);
    }

    /*
     *  ゲストログイン / 名前変更。ニックネームだけで入れる(passwd は無視)。
     *
     *  name フィールドが無い POST は受け付けない。クライアント側の認証方式
     *  探测(空 body の POST)や第三者からの空リクエストが「ななし」ログイン
     *  として通ってしまい、毎回ページを読み込むたびに名前を上書きして
     *  「改名が効かない」状態になるため。
     *  既にログイン済みなら uid は維持する(＝改名)。
     */
    app.post('/server/auth/', (req, res)=>{

        if (! req.body || req.body.name === undefined) {
            return res.status(400).json({ error: 'name が必要です' });
        }

        let name = String(req.body.name || '').trim()
                       .replace(/[\u0000-\u001f\u007f]/g, '')
                       .slice(0, NAME_MAX_LEN);
        if (! name) name = 'ななし';

        req.session.user = {
            uid:  req.session.user && req.session.user.uid
                  || crypto.randomUUID(),
            name: name,
        };
        const to = redirect_to(req, 'netplay.html');
        res.redirect(`${BASE_PATH}/${to}${to == 'index.html' ? '?netplay=1'
                                                             : ''}`);
    });

    /* ログアウト(牌譜画面のフォームから) */
    app.post('/server/logout', (req, res)=>{
        req.session.user = null;
        res.redirect(`${BASE_PATH}/${redirect_to(req, 'netplay.html')}`);
    });
    /* 未実装の外部認証は 404 を返す(クライアントがボタンを隠す) */

    if (dist_dir) app.use(express.static(dist_dir));

    const server  = http.createServer(app);
    const io      = new Server(server, {
        path: `${BASE_PATH}/server/socket.io/`,
        serveClient: typeof SOCKET_IO_CLIENT_SRC != 'string',
    });

    /* SEA/desktop バンドルでは socket.io の serveClient が使えない
     * (require.resolve + fs 読みが効かない)。ビルド時に埋め込んだ
     * クライアントソースを、エンジンの request ハンドラの前段で
     * この URL だけ先回しして配信する。 */
    if (typeof SOCKET_IO_CLIENT_SRC == 'string') {
        const client_path = `${BASE_PATH}/server/socket.io/socket.io.js`;
        const delegates   = server.listeners('request').slice();
        server.removeAllListeners('request');
        server.on('request', (req, res)=>{
            if (req.url.split('?')[0] == client_path) {
                const body = Buffer.from(SOCKET_IO_CLIENT_SRC);
                res.writeHead(200, {
                    'Content-Type':   'application/javascript',
                    'Content-Length': body.length,
                });
                res.end(body);
                return;
            }
            for (const l of delegates) l.call(server, req, res);
        });
    }
    io.engine.use(session_middleware);

    const manager = new RoomManager();

    function lan_url() {
        const addr = server.address();
        const ip   = lan_ip();
        if (! lan.enabled || ! addr || ! ip) return null;
        return `http://${ip}:${addr.port}${BASE_PATH}/`;
    }

    /*
     * 待ち受けアドレスの切り替え。同じポートのまま
     * close → listen する(session / io インスタンスは維持される)。
     *
     * server.close() のコールバックは、アップグレード済みの WebSocket が
     * 接続として残るため発火しない(実測)。よって短い兜底タイマーで
     * listen し直す。実測:150ms で切替完了し、切替前に張られていた
     * socket.io 接続も切れない(クライアントの再接続は不要)。
     */
    function listen_host(host, cb = ()=>{}) {

        const addr = server.address();
        if (! addr) {                       // まだ listen していない
            server.listen({ port: 0, host: host }, cb);
            return;
        }

        server.closeAllConnections();
        let done = false;
        const relisten = ()=>{
            if (done) return;
            done = true;
            server.listen({ port: addr.port, host: host }, cb);
        };
        server.close(relisten);
        setTimeout(relisten, 150).unref?.();    // WebSocket が残ると close 回调は発火しない
    }

    /* 局域网開放の状態(GET/POST 共通のペイロード) */
    function lan_state(req) {
        return { enabled: lan.enabled, url: lan_url(), local: is_local(req) };
    }

    /* 局域网開放の状態照会。local はこの端末から操作できるか */
    app.get('/local/lan', (req, res)=>{
        res.json(lan_state(req));
    });

    /* 局域网開放の切替(ローカルからのみ)。再バインド完了後に応答する */
    app.post('/local/lan', async (req, res)=>{

        if (! is_local(req)) {
            return res.status(403).json(
                        { error: 'ローカルからのみ操作できます' });
        }

        const enable = !! (req.body && req.body.enabled);
        if (enable != lan.enabled) {
            if (manager.has_active()) {
                return res.status(409).json(
                    { error: '部屋・対局が有効な間は切り替えられません' });
            }
            lan.enabled = enable;
            const host = enable ? '0.0.0.0' : '127.0.0.1';
            /* 切替はこの応答を流し切ってから(自分の接続を切らない) */
            res.json(lan_state(req));
            setTimeout(()=>listen_host(host), 200);
            return;
        }
        res.json(lan_state(req));
    });

    io.on('connection', (sock)=>{

        const suser = sock.request.session && sock.request.session.user;
        if (! suser) { sock.emit('HELLO', null); return; }

        const user = manager.ensure_user(suser.uid, suser.name);
        sock.emit('HELLO', { uid: user.uid, name: user.name });
        user.attach(sock);

        sock.on('ROOM', (room_no, quit_uid)=>{
            try {
                if (quit_uid != null) {
                    if (! user.room || user.room.no != room_no)
                        throw new Error('部屋に入っていません');
                    user.room.quit(user, String(quit_uid));
                }
                else {
                    manager.join(String(room_no), user);
                }
            }
            catch (e) { sock.emit('ERROR', e.message) }
        });

        sock.on('START', (room_no, rule, timer)=>{
            try {
                if (! user.room || user.room.no != room_no)
                    throw new Error('部屋に入っていません');
                user.room.start(user,
                                normalize_rule(rule), normalize_timer(timer));
            }
            catch (e) { sock.emit('ERROR', e.message) }
        });

        sock.on('GAME', (reply)=>{
            const game = user.room && user.room.game;
            if (game) game.route_reply(user, reply);
        });

        sock.on('disconnect', ()=>{
            user.detach(sock);
            manager.drop_user_if_orphan(user);
        });

        /* 再接続:入室済みの部屋があれば状態を復元する */
        const room = user.room;
        if (room) {
            room.cancel_destroy();
            const game = room.game;
            if (game) {
                const id = room.users.indexOf(user);
                const player = game.players[id];
                if (player && player.user == user)
                    game.resume(player, sock);
            }
            room.broadcast();
        }
    });

    return { app, server, io, manager,
             listen_host, lan,
             get lan_enabled(){ return lan.enabled } };
}

if (require.main === module) {

    const dist_dir = path.join(__dirname, '..', 'dist');
    const lan_default = process.env.LAN_DEFAULT == null
                      ? true : !! +process.env.LAN_DEFAULT;
    const { server, lan, listen_host } = create_app(dist_dir,
                                                    { lan_default });
    const host = lan.enabled ? '0.0.0.0' : '127.0.0.1';
    server.listen(PORT, host, ()=>{
        listen_host.last = host;
        console.log(`電脳麻将ネット対戦サーバー 起動: ` +
                    `http://localhost:${PORT}${BASE_PATH}/netplay.html ` +
                    `(局域网: ${lan.enabled ? 'ON' : 'OFF'})`);
    });
}

module.exports = { create_app, normalize_rule, normalize_timer };
