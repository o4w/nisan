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
  // Galeri (herkese açık) ve admin sayfaları her zaman "approved" durumuna göre filtreleyip
  // created_at'e göre sıralıyor - bu index olmadan D1 her istekte tüm tabloyu tarıyor.
  // Kayıt sayısı arttıkça (özellikle büyük düğünlerde yüzlerce paylaşımla) bu sorguları
  // gözle görülür şekilde hızlandırır.
  try {
    await d1Query(`CREATE INDEX IF NOT EXISTS idx_media_approved_created ON media (approved, created_at DESC)`);
  } catch (e) {
    console.error('D1 index olusturulamadi (onemli degil, sadece performansi etkiler):', e.message);
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

// iPhone'lar fotoğrafları varsayılan olarak HEIC/HEIF formatında üretir. Bu format web
// tarayıcılarının büyük çoğunluğunda <img> etiketiyle GÖSTERİLEMEZ. Sunucudaki sharp/libvips
// kurulumu da bu formatın piksel verisini çözemiyor (codec eksik) - dosyanın mimetype/uzantı
// bilgisine GÜVENMİYORUZ (mobil tarayıcılar bunu her zaman doğru bildirmeyebiliyor); bunun
// yerine doğrudan sharp ile işlemeyi DENEYİP başarısız olursa HEIC/HEIF kabul edip
// heic-convert ile JPEG'e çeviriyoruz. Bu, dosyanın gerçekten tarayıcıda açılıp açılamayacağını
// test etmenin en güvenilir yolu.
async function makeThumbBuffer(buffer) {
  return sharp(buffer).rotate().resize(500, 500, { fit: 'cover' }).webp({ quality: 78 }).toBuffer();
}

async function saveUpload(file, meta) {
  await ensureSchema();
  const kind = file.mimetype.startsWith('video/') ? 'video' : 'image';

  let uploadBuffer = file.buffer;
  let uploadMime = file.mimetype;
  let ext = (file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase() || '.jpg';
  let thumbBuf = null;

  if (kind === 'image') {
    try {
      // Önce doğrudan orijinal dosyadan thumbnail üretmeyi dene - bu aynı zamanda
      // sharp'ın bu formatı gerçekten (sadece metadata değil, piksel düzeyinde)
      // işleyebildiğinin de testidir.
      thumbBuf = await makeThumbBuffer(uploadBuffer);
    } catch (sharpErr) {
      // Sharp bu formatı işleyemedi - büyük ihtimalle HEIC/HEIF (iPhone fotoğrafı).
      // heic-convert ile JPEG'e çevirip tekrar deniyoruz.
      try {
        uploadBuffer = await heicConvert({ buffer: file.buffer, format: 'JPEG', quality: 0.9 });
        uploadMime = 'image/jpeg';
        ext = '.jpg';
        thumbBuf = await makeThumbBuffer(uploadBuffer);
      } catch (heicErr) {
        // İkisi de başarısız oldu (bozuk dosya, bilinmeyen format vb.) - orijinal dosyayı
        // olduğu gibi yüklemeye devam ediyoruz, en azından kayıp olmasın. Galeri bu durumda
        // thumbnail yerine orijinali göstermeyi dener (yine de tarayıcıda açılmayabilir).
        console.error(
          'Gorsel islenemedi (sharp ve heic-convert basarisiz), orijinal dosya oldugu gibi yuklenecek:',
          sharpErr.message,
          '|',
          heicErr.message
        );
      }
    }
  }

  const key = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  await putObject(key, uploadBuffer, uploadMime);

  let hasThumbnail = false;
  if (thumbBuf) {
    try {
      await putObject(`thumb-${key}.webp`, thumbBuf, 'image/webp');
      hasThumbnail = true;
    } catch (e) {
      // Thumbnail üretildi ama R2'ye yüklenemedi (ör. geçici ağ sorunu) - sorun değil,
      // galeri orijinal görseli gösterecek. Sadece logluyoruz.
      console.error('Thumbnail R2ye yuklenemedi, orijinal gorsel kullanilacak:', e.message);
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
