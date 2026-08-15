// Cloudflare sürücüsü: medya dosyaları Cloudflare R2'de (S3 uyumlu), albüm bilgileri
// (isim/mesaj/onay durumu) Cloudflare D1'de (HTTP API üzerinden) tutulur.
// Render/Railway gibi diski kalıcı olmayan platformlarda kullanılır — sunucu hangi an
// yeniden başlarsa başlasın, hem dosyalar hem veritabanı Cloudflare'de kalıcı kalır.
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const archiver = require('archiver');
const heicConvert = require('heic-convert');

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      has_thumbnail INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Bu kolon daha önce oluşturulmuş (has_thumbnail'sız) bir tabloya sonradan ekleniyor olabilir.
  // Kolon zaten varsa D1 hata döner, bunu sessizce yoksayıyoruz.
  try {
    await d1Query(`ALTER TABLE media ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    // kolon zaten var - sorun değil
  }
  schemaReady = true;
}

function toRecord(row) {
  const key = row.id;
  const isVideo = row.kind === 'video';
  // Thumbnail sadece gerçekten oluşturulup R2'ye yüklendiyse thumb-*.webp'e işaret eder;
  // aksi halde (video ya da thumbnail üretimi başarısız olduysa) doğrudan orijinal dosyaya
  // düşer, böylece galeri hiçbir zaman "kırık resim" göstermez.
  const hasThumbnail = !isVideo && Number(row.has_thumbnail) === 1;
  return {
    id: key,
    url: `${PUBLIC_URL}/${encodeURIComponent(key)}`,
    thumbnail: hasThumbnail
      ? `${PUBLIC_URL}/${encodeURIComponent('thumb-' + key + '.webp')}`
      : `${PUBLIC_URL}/${encodeURIComponent(key)}`,
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

// iPhone'lar fotoğrafları varsayılan olarak HEIC/HEIF formatında üretir. Bu format
// web tarayıcılarının büyük çoğunluğunda (Android/Chrome, çoğu masaüstü tarayıcı, hatta
// bazı Safari sürümlerinde) <img> etiketiyle GÖSTERİLEMEZ - dosya galeriye "kırık resim"
// olarak düşer. Bu yüzden HEIC/HEIF olarak gelen her görseli, misafirin galeride her
// cihazda sorunsuz görebilmesi için sunucu tarafında JPEG'e çeviriyoruz.
function isHeic(file) {
  const mt = (file.mimetype || '').toLowerCase();
  if (mt === 'image/heic' || mt === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.originalname || '');
}

async function normalizeImage(file) {
  if (!isHeic(file)) {
    const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    return { buffer: file.buffer, mimetype: file.mimetype, ext: ext || '.jpg' };
  }
  try {
    const jpegBuffer = await heicConvert({ buffer: file.buffer, format: 'JPEG', quality: 0.9 });
    return { buffer: jpegBuffer, mimetype: 'image/jpeg', ext: '.jpg' };
  } catch (e) {
    // Dönüştürme başarısız olursa (bozuk dosya vb.) orijinal HEIC'i olduğu gibi
    // yüklemeye devam ediyoruz; en azından "İndir" ile erişilebilir kalır.
    console.error('HEIC donusturulemedi, orijinal dosya kullanilacak:', e.message);
    const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    return { buffer: file.buffer, mimetype: file.mimetype, ext: ext || '.heic' };
  }
}

async function saveUpload(file, meta) {
  await ensureSchema();
  const kind = file.mimetype.startsWith('video/') ? 'video' : 'image';

  let uploadBuffer = file.buffer;
  let uploadMime = file.mimetype;
  let ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();

  let hasThumbnail = false;
  if (kind === 'image') {
    const normalized = await normalizeImage(file);
    uploadBuffer = normalized.buffer;
    uploadMime = normalized.mimetype;
    ext = normalized.ext;
  }

  const key = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  await putObject(key, uploadBuffer, uploadMime);

  let hasThumbnail = false;
  if (kind === 'image') {
    try {
      const thumbBuf = await sharp(uploadBuffer).rotate().resize(500, 500, { fit: 'cover' }).webp({ quality: 78 }).toBuffer();
      await putObject(`thumb-${key}.webp`, thumbBuf, 'image/webp');
      hasThumbnail = true;
    } catch (e) {
      // Thumbnail üretilemedi (ör. bellek kısıtı, desteklenmeyen format) - sorun değil,
      // galeri orijinal görseli gösterecek. Sadece logluyoruz.
      console.error('Thumbnail olusturulamadi, orijinal gorsel kullanilacak:', e.message);
    }
  }

  const createdAt = new Date().toISOString();
  await d1Query(
    `INSERT INTO media (id, kind, original_name, guest_name, message, approved, created_at, has_thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, kind, file.originalname || null, meta.guestName || null, meta.message || null, meta.approved ? 1 : 0, createdAt, hasThumbnail ? 1 : 0]
  );

  return toRecord({
    id: key,
    kind,
    original_name: file.originalname,
    guest_name: meta.guestName,
    message: meta.message,
    approved: meta.approved ? 1 : 0,
    created_at: createdAt,
    has_thumbnail: hasThumbnail ? 1 : 0,
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