// State + dataset files. Everything lives in /data so the GitHub Action can
// commit it back to the repo after each run (free persistence, full history).
import fs from 'node:fs';
import path from 'node:path';
import { newPaperState } from './paper.js';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const STATE_FILE = () => path.join(DATA_DIR, 'state.json');

export function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    s.paper ||= newPaperState();
    s.alerts ||= {};
    s.holders ||= {};
    s.volumeHistory ||= [];
    return s;
  } catch {
    return { paper: newPaperState(), alerts: {}, holders: {}, volumeHistory: [], lastDigest: null, runs: 0 };
  }
}

export function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // trim history so the file stays small
  const cutoff = Date.now() - 45 * 86_400_000;
  for (const [k, arr] of Object.entries(state.holders)) {
    state.holders[k] = arr.filter((s) => s[0] >= cutoff).slice(-60);
    if (!state.holders[k].length) delete state.holders[k];
  }
  state.volumeHistory = state.volumeHistory.slice(-84); // ~7 days of 2-hourly runs
  fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 1));
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function appendCsv(relPath, columns, rows) {
  if (!rows.length) return;
  const file = path.join(DATA_DIR, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  fs.appendFileSync(file, (exists ? '' : columns.join(',') + '\n') + lines.join('\n') + '\n');
}

export const SNAPSHOT_COLUMNS = [
  'ts', 'token', 'symbol', 'pool', 'quote', 'priceUsd', 'marketCap', 'liquidityUsd', 'ageDays',
  'volume24h', 'buyers24h', 'sellers24h', 'change24h', 'holders', 'top1Pct', 'top10Pct', 'devPct',
  'drawdownPct', 'baseRange', 'volRatio', 'holderChange3d', 'narratives', 'score', 'decision', 'reasons',
];

export const TRADE_COLUMNS = [
  'closedAt', 'symbol', 'token', 'score', 'openedAt', 'sizeUsd', 'realized', 'pnl', 'multiple', 'hit3x',
];
