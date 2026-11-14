// One-person login: a password (env DASHBOARD_PASSWORD) and a signed, http-only cookie.
// Works in both the proxy (edge) and server actions — Web Crypto only.
export const COOKIE = 'hs_session';
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

function secret() {
  const s = process.env.AUTH_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!s) throw new Error('DASHBOARD_PASSWORD is not set');
  return `hood-dashboard:${s}`;
}

async function hmac(msg: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Buffer.from(sig).toString('base64url');
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function makeSession() {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  return `${exp}.${await hmac(String(exp))}`;
}

export async function validSession(value: string | undefined) {
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  try {
    return safeEqual(sig, await hmac(exp));
  } catch {
    return false;
  }
}

export async function checkPassword(input: string) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return false;
  // compare hashes so timing doesn't leak length
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(input)), crypto.subtle.digest('SHA-256', enc.encode(pw))]);
  return safeEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
}
