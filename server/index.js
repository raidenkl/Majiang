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
 *
 *  起動: npm run server
 */
"use strict";

const path     = require('path');
const crypto   = require('crypto');
const http     = require('http');
const express  = require('express');
const session  = require('express-session');
const { Server } = require('socket.io');
const Majiang  = require('@kobalab/majiang-core');

const { RoomManager, valid_room_no } = require('./room');

const PORT          = process.env.PORT || 3830;
const BASE_PATH     = ('/' + (process.env.BASE_PATH || ''))
                      .replace(/\/+$/, '').replace(/^\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET
                      || crypto.randomBytes(48).toString('hex');
const NAME_MAX_LEN   = 20;

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

function create_app(dist_dir) {

    const app = express();
    app.disable('x-powered-by');

    const session_middleware = session({
        secret:            SESSION_SECRET,
        resave:            false,
        saveUninitialized: true,
        cookie:            { httpOnly: true, sameSite: 'lax',
                             maxAge: 7 * 24 * 60 * 60 * 1000 },
    });

    app.use(session_middleware);
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));

    /* ゲストログイン。ニックネームだけで入れる(passwd は無視) */
    app.post('/server/auth/', (req, res)=>{
        let name = String(req.body.name || '').trim()
                       .replace(/[\u0000-\u001f\u007f]/g, '')
                       .slice(0, NAME_MAX_LEN);
        if (! name) name = 'ななし';

        req.session.user = {
            uid:  req.session.user && req.session.user.uid
                  || crypto.randomUUID(),
            name: name,
        };
        res.redirect(`${BASE_PATH}/netplay.html`);
    });
    /* 未実装の外部認証は 404 を返す(クライアントがボタンを隠す) */

    if (dist_dir) app.use(express.static(dist_dir));

    const server  = http.createServer(app);
    const io      = new Server(server, {
        path: `${BASE_PATH}/server/socket.io/`,
    });
    io.engine.use(session_middleware);

    const manager = new RoomManager();

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

    return { app, server, io, manager };
}

if (require.main === module) {
    const dist_dir = path.join(__dirname, '..', 'dist');
    const { server } = create_app(dist_dir);
    server.listen(PORT, ()=>{
        console.log(`電脳麻将ネット対戦サーバー 起動: ` +
                    `http://localhost:${PORT}${BASE_PATH}/netplay.html`);
    });
}

module.exports = { create_app, normalize_rule, normalize_timer };
