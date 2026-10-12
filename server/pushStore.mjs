import Database from 'better-sqlite3'

export function createPushStore(databasePath = ':memory:') {
  const database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('driver', 'customer')),
      owner_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions(owner_type, owner_id);
  `)

  return {
    save(ownerType, ownerId, subscription) {
      database.prepare(`
        INSERT INTO push_subscriptions (endpoint, owner_type, owner_id, p256dh, auth, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          owner_type = excluded.owner_type, owner_id = excluded.owner_id,
          p256dh = excluded.p256dh, auth = excluded.auth
      `).run(
        subscription.endpoint,
        ownerType,
        ownerId,
        subscription.keys?.p256dh ?? '',
        subscription.keys?.auth ?? '',
        new Date().toISOString(),
      )
    },

    remove(endpoint) {
      database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
    },

    removeForOwner(ownerType, ownerId) {
      database.prepare('DELETE FROM push_subscriptions WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId)
    },

    list(ownerType, ownerId = null) {
      const rows = ownerId === null
        ? database.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner_type = ?').all(ownerType)
        : database.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner_type = ? AND owner_id = ?').all(ownerType, ownerId)
      return rows.map(({ endpoint, p256dh, auth }) => ({ endpoint, keys: { p256dh, auth } }))
    },

    close() {
      database.close()
    },
  }
}
