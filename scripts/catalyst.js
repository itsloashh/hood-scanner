// Adds / removes a manual catalyst tag in data/catalysts.json.
// Run by .github/workflows/catalyst.yml (started from Telegram: /catalyst 0x… listing on Robinhood app)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/store.js';
import { notify } from '../src/notify.js';
import { CONFIG } from '../config.js';

export function applyCatalyst(file, ca, note, now = Date.now()) {
  const addr = String(ca || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error(`"${ca}" isn't a contract address`);
  let data = { coins: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* first tag */ }
  data.coins ||= {};
  const clean = String(note || '').trim().slice(0, 120);
  if (/^(remove|clear|delete)$/i.test(clean)) {
    delete data.coins[addr];
  } else {
    data.coins[addr] = { note: clean || 'catalyst', at: new Date(now).toISOString() };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return { addr, removed: !data.coins[addr], note: data.coins[addr]?.note };
}

if (process.argv[1]?.endsWith('catalyst.js')) {
  const file = path.join(DATA_DIR, 'catalysts.json');
  try {
    const r = applyCatalyst(file, process.env.CATALYST_CA, process.env.CATALYST_NOTE);
    await notify(r.removed
      ? `⚡ Catalyst tag removed from ${r.addr.slice(0, 6)}…${r.addr.slice(-4)}.`
      : `⚡ Catalyst saved for ${r.addr.slice(0, 6)}…${r.addr.slice(-4)}: "${r.note}".\nIt adds +${CONFIG.catalyst.manualBonus} to the coin's score for ${CONFIG.catalyst.manualDays} days. Send /check ${r.addr} to see it scored now.`);
  } catch (e) {
    await notify(`⚡ Catalyst not saved: ${e.message}`);
    process.exit(1);
  }
}
