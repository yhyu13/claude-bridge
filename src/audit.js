'use strict';
/**
 * audit.js — append-only NDJSON audit log.
 *
 * Rule this file exists to enforce (DESIGN.md §9): every code path that does
 * something *because* of a failure or a special condition must write a line.
 * When something goes wrong at 2am you read the log first and the code last.
 */

const fs = require('fs');
const path = require('path');

class Audit {
  constructor(file) {
    this.file = file;
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.stream.on('error', (e) => {
      // Never let a broken audit sink take down the bridge.
      process.stderr.write(`[audit] WRITE FAILED: ${e.message}\n`);
    });
  }

  write(event, detail) {
    const rec = { ts: new Date().toISOString(), event, detail: detail ?? null };
    try {
      this.stream.write(JSON.stringify(rec) + '\n');
    } catch (e) {
      process.stderr.write(`[audit] ${e.message}\n`);
    }
  }

  close() {
    try { this.stream.end(); } catch { /* noop */ }
  }
}

module.exports = { Audit };
