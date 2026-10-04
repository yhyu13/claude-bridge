'use strict';
/**
 * auth.js — pairing token.
 *
 * The token is generated once, stored outside git, and can be revoked by deleting
 * the file. The QR code the phone scans carries this token, which is what stops a
 * stranger who guesses the port from driving your dev machine.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '..', '.bridge-token');

function loadOrCreate() {
  if (fs.existsSync(TOKEN_FILE)) {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (raw.length >= 16) return raw;
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/** Constant-time compare — a plain `===` leaks length/prefix through timing. */
function verify(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { loadOrCreate, verify, TOKEN_FILE };
