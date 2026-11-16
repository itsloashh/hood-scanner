// ─────────────────────────────────────────────────────────────
//  HOOD DESK HUB — one inbox for everything the bots say, plus
//  Web Push to the Hood Desk app (iPhone Home Screen app / desktop).
//
//  • Hub is a Durable Object (SQLite-backed, free plan): the inbox of
//    events, the push subscriptions, the VAPID keys and notification prefs.
//    One instance ("main"), so writes never race.
//  • webPush() sends an encrypted push (RFC 8291 aes128gcm + RFC 8292 VAPID)
//    with nothing but WebCrypto — no npm packages, no extra secrets:
//    the VAPID key pair is generated on first use and kept inside the Hub.
// ─────────────────────────────────────────────────────────────

const KEEP_EVENTS = 600;
const enc = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

// ── the Durable Object ───────────────────────────────────────
export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const s = this.state.storage;
    const json = (x) => Response.json(x);
    switch (body.op) {
      case 'add': {
        const seq = ((await s.get('seq')) || 0) + 1;
        const ev = { id: seq, at: Date.now(), ...cleanEvent(body.event) };
        await s.put({ seq, [evKey(seq)]: ev });
        if (seq > KEEP_EVENTS) await s.delete(evKey(seq - KEEP_EVENTS));
        return json({ id: seq, event: ev, subs: await this.subs(), prefs: await this.prefs(), vapid: await this.vapid() });
      }
      case 'list': {
        const limit = Math.min(Math.max(Number(body.limit) || 60, 1), 200);
        const since = Number(body.since) || 0;
        const before = Number(body.before) || 0;
        const opts = { prefix: 'ev:', reverse: true, limit };
        if (before) opts.end = evKey(before);
        const evs = [...(await s.list(opts)).values()].filter((e) => e.id > since);
        return json({ events: evs, seq: (await s.get('seq')) || 0, prefs: await this.prefs() });
      }
      case 'sub': {
        const sub = body.subscription;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: 'bad subscription' });
        await s.put(await subKey(sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now(), device: String(body.device || '').slice(0, 80) });
        return json({ ok: true, devices: (await this.subs()).length });
      }
      case 'unsub':
        await s.delete(await subKey(body.endpoint || ''));
        return json({ ok: true, devices: (await this.subs()).length });
      case 'subs':
        return json({ subs: await this.subs(), vapid: await this.vapid() });
      // stocks/options paper account (Hood Desk terminal): versioned so two writers can't overwrite each other
      case 'tget':
        return json({ acct: (await s.get('trade:acct')) || null, ver: (await s.get('trade:ver')) || 0 });
      case 'tput': {
        const ver = (await s.get('trade:ver')) || 0;
        if (Number(body.ver) !== ver) return json({ ok: false, conflict: true, ver });
        await s.put({ 'trade:acct': body.acct, 'trade:ver': ver + 1 });
        return json({ ok: true, ver: ver + 1 });
      }
      case 'key':
        return json({ publicKey: (await this.vapid()).publicKey, devices: (await this.subs()).length, prefs: await this.prefs() });
      case 'prefs': {
        if (body.set) await s.put('prefs', { ...(await this.prefs()), ...pickPrefs(body.set) });
        return json({ prefs: await this.prefs() });
      }
      default:
        return json({ error: 'unknown op' });
    }
  }

  async subs() {
    return [...(await this.state.storage.list({ prefix: 'sub:' })).values()];
  }

  async prefs() {
    return { telegram: true, ...((await this.state.storage.get('prefs')) || {}) };
  }

  async vapid() {
    let v = await this.state.storage.get('vapid');
    if (!v) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
      await this.state.storage.put('vapid', v);
    }
    return v;
  }
}

const evKey = (n) => `ev:${String(n).padStart(10, '0')}`;
const subKey = async (endpoint) => `sub:${b64u(await crypto.subtle.digest('SHA-256', enc(endpoint))).slice(0, 32)}`;
const pickPrefs = (p) => ({ ...(typeof p.telegram === 'boolean' ? { telegram: p.telegram } : {}) });

// Every event has the same shape whatever sent it
export function cleanEvent(e = {}) {
  const str = (x, n) => (x == null ? null : String(x).slice(0, n));
  return {
    kind: str(e.kind, 40) || 'update',
    source: str(e.source, 40) || 'bot',
    title: str(e.title, 200) || 'Update',
    body: str(e.body, 6000) || '',
    html: Boolean(e.html),
    url: e.url && /^\/[\w\-/?=&%.#:]*$/.test(e.url) ? str(e.url, 300) : null,
    tag: str(e.tag, 80),
  };
}

// Telegram text → { title, body }: first line is the headline
export function splitText(text = '', html = false) {
  const lines = String(text).split('\n');
  const first = lines.findIndex((l) => l.trim());
  const strip = (s) => (html ? s.replace(/<[^>]+>/g, '') : s).trim();
  return { title: strip(lines[first] || 'Update'), body: lines.slice(first + 1).join('\n').replace(/^\n+/, '') };
}

// ── Web Push (RFC 8291 + RFC 8292) ───────────────────────────
async function hkdf(salt, ikm, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

export async function encryptPayload(sub, payload, { salt = crypto.getRandomValues(new Uint8Array(16)), asKeys = null } = {}) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const as = asKeys || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc('WebPush: info\0'), uaPublic, asPublic), 256);
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = typeof payload === 'string' ? enc(payload) : payload;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export async function vapidHeader(endpoint, vapid, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://hood-desk.vercel.app' })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

export async function webPush(sub, payload, vapid, { ttl = 86_400, urgency = 'high' } = {}) {
  const body = await encryptPayload(sub, payload);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidHeader(sub.endpoint, vapid),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency,
    },
    body,
  });
}

// ── helpers the Worker uses ──────────────────────────────────
function stub(env) {
  return env.HUB ? env.HUB.get(env.HUB.idFromName('main')) : null;
}

export async function hubCall(env, op, data = {}) {
  const s = stub(env);
  if (!s) return null;
  const r = await s.fetch('https://hub/op', { method: 'POST', body: JSON.stringify({ op, ...data }) });
  return r.json();
}

// Store an event, push it to every device. Returns whether Telegram should also get it.
export async function publish(env, event) {
  const r = await hubCall(env, 'add', { event });
  if (!r) return { telegram: true, stored: false };
  const ev = r.event;
  const short = (ev.html ? ev.body.replace(/<[^>]+>/g, '') : ev.body).replace(/\n{2,}/g, '\n').slice(0, 220);
  const payload = JSON.stringify({ title: ev.title.slice(0, 120), body: short, url: ev.url || `/inbox#e${ev.id}`, tag: ev.tag || `e${ev.id}`, id: ev.id, kind: ev.kind });
  const results = await Promise.allSettled(
    (r.subs || []).map(async (s) => {
      const res = await webPush(s, payload, r.vapid);
      if (res.status === 404 || res.status === 410) await hubCall(env, 'unsub', { endpoint: s.endpoint }); // device gone
      return res.status;
    }),
  );
  return { telegram: r.prefs?.telegram !== false, stored: true, id: r.id, pushed: results.filter((x) => x.status === 'fulfilled' && x.value < 300).length };
}

// HMAC for events from GitHub Actions: signed with the bot token both sides already have
export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
