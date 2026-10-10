'use strict';
/**
 * tinyws.js — 最小 WebSocket 客户端，只为 shot.js 的 CDP 通道服务。
 *
 * 为什么自己写而不是引 ws：这个项目零运行时依赖是硬约束（package.json
 * engines + 无 dependencies），工装也不能破坏它。而且这里只需要
 * 「连上、发文本、收文本」三件事，完整的 RFC 6455 实现是浪费。
 *
 * 实现范围（够用即可，不是完整协议实现）：
 *   - 客户端握手（Sec-WebSocket-Key）
 *   - 文本帧 / 关闭帧
 *   - 分片重组（continuation frame）
 *   - 服务端→客户端的掩码处理（规范要求客户端必须拒收带掩码的帧）
 *   - 不做 permessage-deflate（CDP 不要求）
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WS extends EventEmitter {
  constructor(url, opts) {
    super();
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.maxPayload = (opts && opts.maxPayload) || 64 * 1024 * 1024;
    this.ready = false;

    this.sock = net.connect(Number(u.port) || 80, u.hostname, () => {
      this.sock.write(
        'GET ' + (u.pathname + u.search) + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('data', (c) => this._onData(c));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.ready) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = this.buf.slice(0, i).toString();
      if (!/^HTTP\/1\.1 101/.test(head)) {
        this.emit('error', new Error('握手失败: ' + head.split('\r\n')[0]));
        return;
      }
      this.buf = this.buf.slice(i + 4);
      this.ready = true;
      this.emit('open');
    }
    this._drain();
  }

  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const big = this.buf.readBigUInt64BE(off); off += 8;
        if (big > BigInt(this.maxPayload)) { this.emit('error', new Error('帧过大')); return; }
        len = Number(big);
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.slice(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.slice(off + len);

      if (op === 0x8) { this.sock.end(); this.emit('close'); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }   // ping -> pong
      if (op === 0xA) continue;                                 // pong
      if (op === 0x0) {
        this.frags.push(payload);
        if (fin) { const full = Buffer.concat(this.frags); this.frags = []; this._emitMsg(this.fragOp, full); }
        continue;
      }
      if (!fin) { this.fragOp = op; this.frags = [payload]; continue; }
      this._emitMsg(op, payload);
    }
  }

  _emitMsg(op, payload) {
    if (op === 0x1) this.emit('message', payload.toString('utf8'));
    // 二进制帧（CDP 偶尔用）也当文本处理：转 latin1 再解 utf8 足够本项目用
    else if (op === 0x2) this.emit('message', payload.toString('utf8'));
  }

  _frame(op, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | op, 0x80 | len]); }
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  send(text) { this._frame(0x1, Buffer.from(text, 'utf8')); }
  close() { try { this._frame(0x8, Buffer.alloc(0)); this.sock.end(); } catch { /* 已关 */ } }
}

module.exports = WS;