// Cloudflare sürücüsü: medya dosyaları Cloudflare R2'de (S3 uyumlu), albüm bilgileri
// (isim/mesaj/onay durumu) Cloudflare D1'de (HTTP API üzerinden) tutulur.
// Render/Railway gibi diski kalıcı olmayan platformlarda kullanılır — sunucu hangi an
// yeniden başlarsa başlasın, hem dosyalar hem veritabanı Cloudflare'de kalıcı kalır.
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const archiver = require('archiver');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET_NAME || 'ani-albumu';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const D1_DB_ID = process.env.CF_D1_DATABASE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!ACCOUNT_ID || !PUBLIC_URL || !D1_DB_ID || !CF_API_TOKEN) {
  console.warn(
    '[uyari] STORAGE_DRIVER=r2 secildi ama CF_ACCOUNT_ID / R2_PUBLIC_URL / CF_D1_DATABASE_ID / CF_API_TOKEN ' +
      'degiskenlerinden biri veya birkaci eksik. .env dosyasini kontrol edin.'
  );
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const D1_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`;

async function d1Query(sql, params = []) {
  const res = await fetch(D1_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error('D1 sorgu hatasi: ' + JSON.stringify(data.errors));
  }
  return data.result[0]; // { results, success, meta }
}

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await d1Query(`
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      original_name TEXT,
      guest_name TEXT,
      message TEXT,
      approved INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  schemaReady = true;
}

function toRecord(row) {
  const key = row.id;
  const isVideo = row.kind === 'video';
  return {
    id: key,
    url: `${PUBLIC_URL}/${encodeURIComponent(key)}`,
    thumbnail: isVideo ? `${PUBLIC_URL}/${encodeURIComponent(key)}` : `${PUBLIC_URL}/${encodeURIComponent('thumb-' + key + '.webp')}`,
    kind: row.kind,
    original_name: row.original_name,
    guest_name: row.guest_name,
    message: row.message,
    approved: !!Number(row.approved),
    created_at: row.created_at,
  };
}

async function putObject(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}

async function saveUpload(file, meta) {
  await ensureSchema();
  const kind = file.mimetype.startsWith('video/') ? 'video' : 'image';
  const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const key = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  await putObject(key, file.buffer, file.mimetype);

  if (kind === 'image') {
    try {
      const thumbBuf = await sharp(file.buffer).rotate().resize(500, 500, { fit: 'cover' }).webp({ quality: 78 }).toBuffer();
      await putObject(`thumb-${key}.webp`, thumbBuf, 'image/webp');
    } catch (e) {
      console.error('Thumbnail olusturulamadi:', e.message);
    }
  }

  const createdAt = new Date().toISOString();
  await d1Query(
    `INSERT INTO media (id, kind, original_name, guest_name, message, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [key, kind, file.originalname || null, meta.guestName || null, meta.message || null, meta.approved ? 1 : 0, createdAt]
  );

  return toRecord({
    id: key,
    kind,
    original_name: file.originalname,
    guest_name: meta.guestName,
    message: meta.message,
    approved: meta.approved ? 1 : 0,
    created_at: createdAt,
  });
}

async function listApproved() {
  await ensureSchema();
  const result = await d1Query('SELECT * FROM media WHERE approved = 1 ORDER BY created_at DESC');
  return (result.results || []).map(toRecord);
}

async function listAll() {
  await ensureSchema();
  const result = await d1Query('SELECT * FROM media ORDER BY created_at DESC');
  return (result.results || []).map(toRecord);
}

async function approve(id) {
  await d1Query('UPDATE media SET approved = 1 WHERE id = ?', [id]);
}

async function hide(id) {
  await d1Query('UPDATE media SET approved = 0 WHERE id = ?', [id]);
}

async function remove(id, resourceType) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: id }));
  if (resourceType === 'image') {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `thumb-${id}.webp` }));
    } catch (e) {
      // thumbnail zaten yoksa yoksay
    }
  }
  await d1Query('DELETE FROM media WHERE id = ?', [id]);
}

async function streamAllForZip(res, zipName) {
  const items = await listAll();
  res.attachment(zipName);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    throw err;
  });
  archive.pipe(res);

  for (const item of items) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) continue;
      const buf = Buffer.from(await response.arrayBuffer());
      const label = item.guest_name ? `${item.guest_name} - ` : '';
      archive.append(buf, { name: `${label}${item.original_name || item.id}` });
    } catch (e) {
      console.error('ZIP indirme hatasi:', item.id, e.message);
    }
  }

  await archive.finalize();
}

module.exports = {
  saveUpload,
  listApproved,
  listAll,
  approve,
  hide,
  remove,
  streamAllForZip,
};
