/**
 * Rolling record of how many output tokens real answers used, so price
 * estimates can show a typical cost instead of the worst-case output cap.
 * Persisted so the average survives gateway restarts.
 */
const fs = require('fs');
const path = require('path');

const MAX_SAMPLES = 100;

class UsageStats {
  constructor(storePath) {
    this.storePath = storePath;
    this.samples = [];
    if (storePath && fs.existsSync(storePath)) {
      this.samples = JSON.parse(fs.readFileSync(storePath, 'utf8')).samples || [];
    }
  }

  record(outputTokens) {
    const n = parseInt(outputTokens, 10);
    if (!(n > 0)) return;
    this.samples.push(n);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    if (!this.storePath) return;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify({ samples: this.samples }));
  }

  /**
   * Typical output length for a request capped at `maxOutputTokens`.
   * Answers can't exceed the cap, so each sample is clamped to it first.
   * Without history, assume half the cap.
   */
  expectedOutputTokens(maxOutputTokens) {
    if (this.samples.length === 0) {
      return { tokens: Math.ceil(maxOutputTokens / 2), source: 'default', sampleCount: 0 };
    }
    const sum = this.samples.reduce((s, n) => s + Math.min(n, maxOutputTokens), 0);
    return { tokens: Math.round(sum / this.samples.length), source: 'history', sampleCount: this.samples.length };
  }
}

module.exports = UsageStats;
