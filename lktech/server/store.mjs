import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { seed } from './seed.mjs';

export function openStore(directory = resolve(process.env.DATA_DIR || 'data')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(directory, 'uploads'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, 'site.sqlite'));
  try { chmodSync(resolve(directory, 'site.sqlite'), 0o600); } catch {}
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(kind TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL, admin_id INTEGER);
    CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, cep TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'novo', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS limits_expira ON limits(expires_at);
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO documents VALUES (?, ?, 1, ?)');
  for (const kind of ['draft', 'published']) insert.run(kind, JSON.stringify(seed), new Date().toISOString());
  const read = kind => { const row = db.prepare('SELECT * FROM documents WHERE kind=?').get(kind); return { config: JSON.parse(row.body), revision: row.revision, updatedAt: row.updated_at }; };
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  return {
    db, directory, read, transaction,
    save(config, expected) {
      const result = db.prepare('UPDATE documents SET body=?, revision=revision+1, updated_at=? WHERE kind=\'draft\' AND revision=?').run(JSON.stringify(config), new Date().toISOString(), expected);
      if (!result.changes) throw Object.assign(new Error('Este conteúdo foi alterado em outra sessão. Recarregue antes de salvar.'), { status: 409 });
      return read('draft');
    },
    publish(expected, adminId, conferido) { return transaction(() => {
      const draft = read('draft');
      if (conferido) draft.config = conferido;
      if (draft.revision !== expected) throw Object.assign(new Error('O rascunho mudou. Recarregue antes de publicar.'), { status: 409 });
      db.prepare('INSERT INTO history(body,created_at,admin_id) VALUES(?,?,?)').run(JSON.stringify(read('published').config), new Date().toISOString(), adminId);
      db.prepare('UPDATE documents SET body=?,revision=revision+1,updated_at=? WHERE kind=\'published\'').run(JSON.stringify(draft.config), new Date().toISOString());
      db.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 30)');
      return read('published');
    }); },
    // Tentativas que falharam (login, troca de senha): conta só erros e zera quando acerta.
    tentativas(key) { const row = db.prepare('SELECT count FROM limits WHERE key=? AND expires_at>=?').get(key, Date.now()); return row ? row.count : 0; },
    registrarFalha(key, seconds) { const now = Date.now(); db.prepare('DELETE FROM limits WHERE key=? AND expires_at<?').run(key, now); db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + seconds * 1000); },
    zerar(key) { db.prepare('DELETE FROM limits WHERE key=?').run(key); },
    limit(key, maximum, seconds) { return transaction(() => {
      const now = Date.now(); db.prepare('DELETE FROM limits WHERE expires_at<?').run(now);
      const row = db.prepare('SELECT * FROM limits WHERE key=?').get(key);
      if (row && row.count >= maximum) return false;
      db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + seconds * 1000);
      return true;
    }); }
  };
}
