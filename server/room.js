/*!
 *  電脳麻将: ネット対戦サーバー - 部屋管理
 *
 *  部屋の作成/入室/退室、在席情報(ROOM イベント)の配信、
 *  対局セッション(GameSession)の起動と後片付けを行う。
 */
"use strict";

const { GameSession } = require('./game');

const MAX_USERS        = 4;              // 麻雀は4人
const IDLE_DESTROY_MS  = 60 * 1000;      // 全員オフラインで部屋を畳むまでの時間

/* 部屋番号として認める文字列 */
function valid_room_no(no) {
    return typeof no == 'string' && 0 < no.length && no.length <= 20;
}

/*
 *  対戦者。同一 uid は複数の socket(タブ/再接続)を持ちうる。
 */
class User {

    constructor(uid, name) {
        this.uid      = uid;
        this.name     = name;
        this.room     = null;
        this.quitting = false;      // 対局中の退室予定(局終了時に除籍)
        this.sockets  = new Set();
    }

    get online() { return this.sockets.size > 0 }

    emit(event, ...args) {
        for (let s of this.sockets) s.emit(event, ...args);
    }

    summary() {                     // ROOM イベントの user[] 要素
        const user = { uid: this.uid, name: this.name };
        if (! this.online) user.offline = true;
        return user;
    }

    attach(socket) {
        this.sockets.add(socket);
    }

    detach(socket) {
        this.sockets.delete(socket);
        if (! this.online && this.room) this.room.on_member_offline();
    }
}

class Room {

    constructor(manager, no) {
        this.manager = manager;
        this.no      = no;
        this.users   = [];          // user[0] が部屋の主
        this.game    = null;        // 対局中の GameSession
        this._destroy_timer = null;
    }

    /*
     * 入室。同一 uid の再入室は再接続扱い(対局中でも可)。
     * 戻り値: { user, resumed }
     */
    join(user) {

        this.cancel_destroy();

        const found = this.users.find(u => u.uid == user.uid);
        if (found) {
            found.quitting = false;
            found.room = this;
            this.broadcast();
            return { user: found, resumed: true };
        }

        if (this.game) throw new Error('対局中の部屋には入室できません');
        if (this.users.length >= MAX_USERS) throw new Error('部屋が満員です');

        user.room = this;
        this.users.push(user);
        this.broadcast();
        return { user: user, resumed: false };
    }

    /*
     * 退室。uid は自分自身、または部屋の主が指名して強制退室させる。
     * 対局中は席を守るためオフライン扱い(quit 印)にとどめる。
     */
    quit(user, uid) {

        if (uid != user.uid && this.users[0] != user)
            throw new Error('他のプレーヤーは退室させられません');

        const target = this.users.find(u => u.uid == uid);
        if (! target) return;

        if (this.game && ! target.quitting) {
            target.quitting = true;
        }
        else {
            this.remove_user(target);
        }
        this.broadcast();
    }

    remove_user(user) {
        this.users = this.users.filter(u => u != user);
        user.room  = null;
        user.quitting = false;
        if (! this.users.length) this.destroy();
    }

    /* 対局開始(部屋の主のみ) */
    start(user, rule, timer) {

        if (this.users[0] != user)
            throw new Error('部屋の主だけが対局を開始できます');
        if (this.game)
            throw new Error('すでに対局中です');

        this.game = new GameSession(this, rule, timer);
        this.game.start();
    }

    /* GameSession からの対局終了通知 */
    on_game_end() {

        this.game = null;

        for (let u of this.users.filter(u => u.quitting && ! u.online)) {
            this.remove_user(u);
        }
        this.emit_all('END');
        this.broadcast();
        this.arm_destroy_if_idle();
    }

    on_member_offline() {           // 断線によるオフライン化
        if (this.game) this.game.broadcast_players();
        this.broadcast();
        this.arm_destroy_if_idle();
    }

    broadcast() {
        this.emit_all('ROOM', {
            room_no: this.no,
            user:    this.users.map(u => u.summary()),
        });
    }

    emit_all(event, ...args) {
        for (let u of this.users) u.emit(event, ...args);
    }

    get idle() { return ! this.users.some(u => u.online) }

    arm_destroy_if_idle() {

        if (! this.idle) { this.cancel_destroy(); return; }
        if (this._destroy_timer) return;

        this._destroy_timer = setTimeout(()=>{
            this._destroy_timer = null;
            if (this.idle) this.destroy();
        }, IDLE_DESTROY_MS);
        this._destroy_timer.unref?.();  // プロセスの終了を妨げない
    }

    cancel_destroy() {
        clearTimeout(this._destroy_timer);
        this._destroy_timer = null;
    }

    destroy() {
        this.cancel_destroy();
        if (this.game) { this.game.abort(); this.game = null; }
        for (let u of this.users) {
            u.room = null;
            u.quitting = false;
        }
        this.manager.remove(this.no);
    }
}

class RoomManager {

    constructor() {
        this.rooms = new Map();     // 部屋番号 -> Room
        this.users = new Map();     // uid -> User
    }

    /* ログイン済み uid の User を取得(なければ生成) */
    ensure_user(uid, name) {

        let user = this.users.get(uid);
        if (! user) {
            user = new User(uid, name);
            this.users.set(uid, user);
        }
        user.name = name;
        return user;
    }

    drop_user_if_orphan(user) {
        if (! user.room && ! user.online) this.users.delete(user.uid);
    }

    join(room_no, user) {

        if (! valid_room_no(room_no))
            throw new Error('部屋番号が不正です');

        let room = this.rooms.get(room_no);
        if (! room) {
            room = new Room(this, room_no);
            this.rooms.set(room_no, room);
        }
        return room.join(user);
    }

    remove(room) {
        this.rooms.delete(room.no);
    }

    destroy_all() {
        for (let room of [...this.rooms.values()]) room.destroy();
    }
}

module.exports = { RoomManager, Room, User,
                   MAX_USERS, IDLE_DESTROY_MS, valid_room_no };
