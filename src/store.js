import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const token = (prefix) => `${prefix}${randomBytes(32).toString('base64url')}`;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
const minute = 60_000;

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databaseFile = join(directory, 'gateway.sqlite');
  const keyFile = join(directory, 'vault.key');
  if (!existsSync(keyFile) && !existsSync(databaseFile)) {
    try {
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const vault = readFileSync(keyFile);
  if (vault.length !== 32) throw new Error('Invalid vault.key');
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT, hash TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS usage (
      key_id TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL, used INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS logs (
      seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
      fallback INTEGER NOT NULL, data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS logs_at ON logs(at);
    CREATE UNIQUE INDEX IF NOT EXISTS key_hash ON records(json_extract(data, '$.hash')) WHERE kind = 'key';
  `);
  const pruneLogs = db.prepare('DELETE FROM logs WHERE at < ? OR seq <= (SELECT max(seq) - 20000 FROM logs)');
  let prunedAt = 0;

  function seal(value, id) {
    if (!value) return '';
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', vault, iv);
    cipher.setAAD(Buffer.from(id));
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }

  function unseal(value, id) {
    if (!value) return '';
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', vault, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  }

  function changePassword(password, reset = false) {
    if (typeof password !== 'string' || password.length < 16 || password.length > 256) {
      throw new Error('管理员密码须为 16 到 256 个字符。');
    }
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    if (!reset) {
      return db.prepare('INSERT OR IGNORE INTO credentials VALUES (1, ?, ?)').run(salt, hash).changes > 0;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR REPLACE INTO credentials VALUES (1, ?, ?)').run(salt, hash);
      db.exec('DELETE FROM sessions; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  return {
    close: () => db.close(),
    seal, unseal, changePassword,
    initialized: () => Boolean(db.prepare('SELECT 1 FROM credentials').get()),
    verifyPassword(password) {
      const row = db.prepare('SELECT salt, hash FROM credentials WHERE id = 1').get();
      return Boolean(row && typeof password === 'string' && password.length <= 256 &&
        timingSafeEqual(scryptSync(password, row.salt, 64), Buffer.from(row.hash, 'hex')));
    },
    session() {
      const secret = token('ses_');
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(secret), Date.now() + 12 * 60 * minute);
      return secret;
    },
    hasSession: (secret) => Boolean(secret && db.prepare('SELECT 1 FROM sessions WHERE hash = ? AND expires > ?')
      .get(digest(secret), Date.now())),
    removeSession: (secret) => db.prepare('DELETE FROM sessions WHERE hash = ?').run(digest(secret)),
    list: (kind) => db.prepare('SELECT data FROM records WHERE kind = ? ORDER BY rowid').all(kind)
      .map(({ data }) => JSON.parse(data)),
    get(kind, id) {
      const row = db.prepare('SELECT data FROM records WHERE kind = ? AND id = ?').get(kind, id);
      return row && JSON.parse(row.data);
    },
    findKey(secret) {
      const row = db.prepare("SELECT data FROM records WHERE kind = 'key' AND json_extract(data, '$.hash') = ?").get(digest(secret));
      return row && JSON.parse(row.data);
    },
    save: (kind, item) => db.prepare(`INSERT INTO records VALUES (?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data`).run(kind, item.id, JSON.stringify(item)),
    remove(kind, id) {
      db.prepare('DELETE FROM records WHERE kind = ? AND id = ?').run(kind, id);
      if (kind === 'key') db.prepare('DELETE FROM usage WHERE key_id = ?').run(id);
    },
    keyUse: (id) => db.prepare('SELECT used FROM usage WHERE key_id = ?').get(id)?.used ?? null,
    spend(key) {
      const now = Date.now();
      const result = db.prepare(`INSERT INTO usage VALUES (?, ?, 1, ?)
        ON CONFLICT(key_id) DO UPDATE SET window = excluded.window, used = excluded.used,
          count = CASE WHEN usage.window = excluded.window THEN usage.count + 1 ELSE 1 END
        WHERE usage.window != excluded.window OR usage.count < ?`)
        .run(key.id, Math.floor(now / minute), now, key.rpm);
      return result.changes > 0;
    },
    log(item) {
      db.prepare('INSERT INTO logs(at, route, status, fallback, data) VALUES (?, ?, ?, ?, ?)')
        .run(item.at, item.route, item.status, Number(item.fallback), JSON.stringify(item));
      if (item.at - prunedAt > minute) {
        pruneLogs.run(item.at - 7 * 24 * 60 * minute);
        prunedAt = item.at;
      }
    },
    logs({ route, failed }) {
      return db.prepare(`SELECT data FROM logs WHERE (? = '' OR route = ?) AND (? = 0 OR status >= 400)
        AND at >= ? ORDER BY seq DESC LIMIT 100`).all(route, route, Number(failed), Date.now() - 7 * 24 * 60 * minute)
        .map(({ data }) => JSON.parse(data));
    },
    stats() {
      return db.prepare(`SELECT count(*) AS total, count(*) FILTER (WHERE status < 400) AS successful,
        coalesce(sum(fallback), 0) AS fallbacks FROM logs WHERE at >= ?`).get(Date.now() - 24 * 60 * minute);
    },
  };
}
