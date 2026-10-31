#!/usr/bin/env node
/**
 * Clean all SQLite databases, channel state JSON files, and sessions for demo/dev mode.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

console.log('[Clean Script] Wiping database and runtime files in:', DATA_DIR);

if (dbPath !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        console.log(`  ✔ Removed ${path.basename(p)}`);
      } catch (err) {
        console.warn(`  ⚠ Could not remove ${path.basename(p)}: ${err.message}`);
      }
    }
  }
}

const cleanDir = (dir, label) => {
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(dir, file));
          console.log(`  ✔ Removed ${label}/${file}`);
        } catch (_) {}
      }
    }
  }
};

cleanDir(path.join(DATA_DIR, 'hosted'), 'hosted');
cleanDir(path.join(DATA_DIR, 'accounts'), 'accounts');

if (fs.existsSync(DATA_DIR)) {
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (file.startsWith('provider-channels-') || file.startsWith('gateway-channels')) {
      try {
        fs.unlinkSync(path.join(DATA_DIR, file));
        console.log(`  ✔ Removed ${file}`);
      } catch (_) {}
    }
  }
}

console.log('[Clean Script] Database and demo state wiped clean!');
