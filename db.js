const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data', 'album.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    thumbnail TEXT,
    original_name TEXT,
    mime_type TEXT,
    kind TEXT NOT NULL,            -- 'image' | 'video'
    guest_name TEXT,
    message TEXT,
    approved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Galeri ve admin sayfaları "approved" durumuna göre filtreleyip created_at'e göre
// sıralıyor - bu index olmadan SQLite kayıt sayısı arttıkça her istekte tüm tabloyu tarar.
db.exec(`CREATE INDEX IF NOT EXISTS idx_media_approved_created ON media (approved, created_at DESC);`);

module.exports = db;
