import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, stored] = encoded.split(':');
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(stored, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export function createSession(store, adminId, hours = 8) {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hashToken(token), adminId, csrf, Date.now() + hours * 3600000);
  return { token, csrf };
}
export function sessionFor(store, req) {
  const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('lk_session='));
  const token = cookie?.slice('lk_session='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return store.db.prepare('SELECT sessions.*,admins.email FROM sessions JOIN admins ON admins.id=sessions.admin_id WHERE token_hash=? AND expires_at>?').get(hashToken(token), Date.now()) || null;
}
