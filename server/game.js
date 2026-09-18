/*!
 *  電脳麻将: ネット対戦サーバー - 対局セッション
 *
 *  Majiang.Game(@kobalab/majiang-core)を権威エンジンとしてサーバー側で走らせ、
 *  各席のメッセージを socket.io 経由で個別に配信する。
 *  人間の席は NetPlayer がソケットを代理し、空席は Majiang.AI が補う。
 */
"use strict";

const Majiang = require('@kobalab/majiang-core');
const AI      = require('@kobalab/majiang-ai');

/* クライアントが持ち時間を指定しなかった場合の既定値(秒) */
const DEFAULT_LIMIT = 20;
/* サーバー側の応答待ちに上乗せする通信遅延の猶予(ミリ秒) */
const GRACE_MS      = 2000;
/* クライアント応答として認めるフィールドの語彙(UI.Player の応答語彙と一致) */
const REPLY_FIELDS  = ['hule', 'daopai', 'dapai', 'gang', 'fulou'];
const REPLY_MAX_LEN = 40;

/*
 *  クライアントからの応答を UI.Player の語彙に制限する。
 *  余計なフィールドや型はエンジンに渡さず、空応答(パス)に落とす。
 *  値の正当性(ツモ切り `_` や立直 `*` の有無など)はエンジン側で検証され、
 *  不正値は自動的にパス扱いになる。
 */
function sanitize_reply(reply) {

    if (! reply || typeof reply != 'object') return {};

    for (let key of REPLY_FIELDS) {
        let value = reply[key];
        if (typeof value == 'string' && 0 < value.length
            && value.length <= REPLY_MAX_LEN)
        {
            return { [key]: value };
        }
    }
    return {};
}

/*
 *  人間の席。Majiang.Game の player として振る舞い、
 *  メッセージを保有する User の全 socket に転送し、
 *  応答(または持ち時間切れ)をエンジンへ返す。
 */
class NetPlayer {

    constructor(session, id, user) {
        this.session = session;
        this.id      = id;          // player id (0-3)
        this.user    = user;        // 席の主(全 socket に転送する)
        this.pending = null;        // { seq, msg, callback, timer }
    }

    get online() { return this.user.online }

    /* Majiang.Game からの呼び出し */
    action(msg, callback) {

        if (! callback) {           // 一方向通知(kaigang など)には seq を付さない
            this.send(msg);
            return;
        }

        const seq     = ++ this.session.seq;
        this.pending  = {
            seq:      seq,
            msg:      msg,
            callback: callback,
            timer:    setTimeout(()=>this.timeout(seq),
                                  this.session.limit_ms + GRACE_MS),
        };
        /* timer フィールドはクライアント側カウントダウン(limit, allowed) */
        this.send({ seq: seq, timer: this.session.timer_field, ...msg });
    }

    send(msg) {
        this.user.emit('GAME', msg);
    }

    send_one(socket, msg) {         // 再接続した 1 個の socket だけへ送る
        socket.emit('GAME', msg);
    }

    /* クライアントからの応答。seq が未応答のものと一致したときだけ受理 */
    receive(reply) {

        if (! this.pending || ! reply || reply.seq !== this.pending.seq)
            return false;

        clearTimeout(this.pending.timer);
        const callback = this.pending.callback;
        this.pending   = null;
        callback(sanitize_reply(reply));
        return true;
    }

    /* 持ち時間切れ。エンジンに空応答を返す(ツモ切りはエンジンが自動選択) */
    timeout(seq) {

        if (! this.pending || this.pending.seq != seq) return;

        const callback = this.pending.callback;
        this.pending   = null;
        callback({});
    }

    flush() {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending = null;
        }
    }
}

/*
 *  一局の対局。部屋の members(最大4)を player id 順に席割りし、
 *  空席を AI が補う。
 */
class GameSession {

    constructor(room, rule, timer) {

        this.room        = room;
        this.rule        = rule;
        const limit      = Array.isArray(timer) && timer[0] > 0
                         ? timer[0] : DEFAULT_LIMIT;
        this.limit_ms    = limit * 1000;
        this.timer_field = [ limit, 0 ];
        this.seq         = 0;       // 対局内で単調増加する応答通番
        this.players     = [];      // player id -> NetPlayer | AI
        this.game        = null;
        this.finished    = false;
    }

    get title() {
        return `電脳麻将ネット対戦 部屋 ${this.room.no}`;
    }

    start() {

        const users = this.room.users;
        /* 4 席固定。空席は AI が補う */
        this.players = [0, 1, 2, 3].map(id =>
                    users[id] ? new NetPlayer(this, id, users[id])
                              : new AI());

        this.game = new Majiang.Game(this.players, ()=>this.finish(),
                                     this.rule, this.title);
        this.game._speed = 0;       // 全ディレイを 0 にして非同期で進行
        this.game._model.title  = this.title;
        this.game._model.player = [0, 1, 2, 3].map(id =>
                        users[id] ? users[id].name : 'CPU');
        this.game.view = {          // エンジンからのコールバック(表示は不要)
            say:     (name, l)=> this.broadcast({ say: { name: name, l: l } }),
            kaiju:   ()=>{},
            redraw:  ()=>{},
            update:  ()=>{},
            summary: ()=>{},
        };

        this.broadcast_players();
        for (let p of this.players) {
            if (p instanceof NetPlayer) p.user.emit('START');
        }
        this.game.kaiju();
    }

    finish() {

        if (this.finished) return;
        this.finished = true;
        for (let p of this.players) if (p.flush) p.flush();

        this.room.on_game_end();
    }

    abort() {                       // 部屋の破棄などで対局を強制終了
        this.finish();
    }

    /* クライアントの応答をその席へ振り分ける */
    route_reply(user, reply) {

        if (this.finished) return;

        const id = this.room.users.indexOf(user);
        if (id < 0) return;

        const player = this.players[id];
        if (player instanceof NetPlayer) player.receive(reply);
    }

    broadcast(msg) {
        for (let p of this.players) {
            if (p instanceof NetPlayer) p.send(msg);
        }
    }

    broadcast_players() {
        this.broadcast({ players: this.players.map(p =>
                            p instanceof NetPlayer ? p.online : true) });
    }

    /*
     * 再接続:START → 在席情報 → 開局(棋譜ログ付き) → 未応答メッセージ
     * クライアントは棋譜ログを再生して盤面を再構築する。
     * 新しい socket 1 個だけへ送る(他のタブの画面は壊さない)。
     */
    resume(player, socket) {

        socket.emit('START');
        this.broadcast_players();

        const paipu = this.game._paipu;
        player.send_one(socket, {
            kaiju: {
                id:     player.id,
                rule:   this.rule,
                title:  paipu.title,
                player: paipu.player,
                qijia:  paipu.qijia,
                log:    JSON.parse(JSON.stringify(paipu.log)),
            },
        });

        if (player.pending) {
            player.send_one(socket, {
                seq:   player.pending.seq,
                timer: this.timer_field,
                ...player.pending.msg,
            });
        }
    }
}

module.exports = { GameSession, NetPlayer, sanitize_reply,
                   DEFAULT_LIMIT, GRACE_MS };
