// Saves a per-coin alert choice from Telegram: mute (no more alerts), follow (tighter updates
// + daily check-in) or normal. Run by .github/workflows/coin-pref.yml.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/store.js';

export function applyPref(file, ca, mode) {
  const addr = String(ca || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error(`"${ca}" isn't a contract address`);
  if (!['mute', 'follow', 'normal'].includes(mode)) throw new Error(`unknown mode "${mode}"`);
  let data = { coins: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* first one */ }
  data.coins ||= {};
  if (mode === 'normal') delete data.coins[addr];
  else data.coins[addr] = mode;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return data.coins[addr] || 'normal';
}

if (process.argv[1]?.endsWith('coin-pref.js')) {
  try {
    console.log(applyPref(path.join(DATA_DIR, 'coin-prefs.json'), process.env.PREF_CA, process.env.PREF_MODE));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
