// Yerel disk sürücüsü: dosyalar uploads/ klasöründe, bilgiler SQLite'ta (data/album.db) tutulur.
// Kalıcı diski olan bir VPS'te (Oracle Cloud Always Free, Hetzner, DigitalOcean vb.) çalıştırırken kullanılır.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const archiver = require('archiver');
const heicConvert = require('heic-convert');
const db = require('../db');

const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const THUMB_DIR = path.join(UPLOAD_DIR, 'thumbs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

function kindFromMime(mime) {
  return mime.startsWith('video/') ? 'video' : 'image';
}

// iPhone'lar fotoğrafları varsayılan olarak HEIC/HEIF formatında üretir. Bu format web
// tarayıcılarının büyük çoğunluğunda <img> etiketiyle GÖSTERİLEMEZ - galeride "kırık
// resim" olarak görünür. Sunucudaki sharp/libvips kurulumu da bu formatın piksel verisini
// çözemiyor (codec eksik). Dosyanın mimetype/uzantı bilgisine GÜVENMİYORUZ (mobil
// tarayıcılar bunu her zaman doğru bildirmeyebiliyor) - doğrudan sharp ile işlemeyi
// DENEYİP başarısız olursa HEIC/HEIF kabul edip heic-convert ile JPEG'e çeviriyoruz.
async function normalizeHeicIfNeeded(file) {
  const srcPath = path.join(UPLOAD_DIR, file.filename);
  try {
    // Sharp bu dosyayı gerçekten işleyebiliyor mu diye test ediyoruz (thumbnail'i
    // makeThumbnail zaten üretecek, burada sadece decode edilebilirliği kontrol ediyoruz).
    await sharp(srcPath).rotate().toBuffer();
    return file.filename;
  } catch (sharpErr) {
    try {
      const inputBuffer = fs.readFileSync(srcPath);
      const jpegBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
      const newFilename = file.filename.replace(/\.[^.]+$/, '') + '.jpg';
      const newPath = path.join(UPLOAD_DIR, newFilename);
      // Dosya adı zaten ".jpg" ile bitiyor olabilir (mimetype/uzantı yanlış bildirilmiş
      // olsa bile içerik gerçekte HEIC'ti) - bu durumda newPath === srcPath olur. Önce
      // yazıp sonra "eskiyi" silersek az önce yazdığımız yeni dosyayı silmiş oluruz. Bu
      // yüzden yol aynıysa doğrudan üzerine yazıyoruz, farklıysa yaz+eskisini sil yapıyoruz.
      if (newPath === srcPath) {
        fs.writeFileSync(srcPath, jpegBuffer);
      } else {
        fs.writeFileSync(newPath, jpegBuffer);
        fs.unlinkSync(srcPath);
      }
      file.mimetype = 'image/jpeg';
      return newFilename;
    } catch (heicErr) {
      // Dönüştürme başarısız olursa orijinal dosya olduğu gibi kalır.
      console.error('Gorsel islenemedi (sharp ve heic-convert basarisiz):', sharpErr.message, '|', heicErr.message);
      return file.filename;
    }
  }
}

async function makeThumbnail(filename) {
  const src = path.join(UPLOAD_DIR, filename);
  const thumbName = `thumb-${filename.replace(/\.[^.]+$/, '')}.webp`;
  const dest = path.join(THUMB_DIR, thumbName);
  try {
    await sharp(src).rotate().resize(500, 500, { fit: 'cover' }).webp({ quality: 78 }).toFile(dest);
    return `thumbs/${thumbName}`;
  } catch (e) {
    return null; // video ya da desteklenmeyen format için thumbnail yok
  }
}

function toRecord(row) {
  return {
    id: String(row.id),
    url: `/uploads/${row.filename}`,
    thumbnail: row.thumbnail ? `/uploads/${row.thumbnail}` : `/uploads/${row.filename}`,
    kind: row.kind,
    original_name: row.original_name,
    guest_name: row.guest_name,
    message: row.message,
    approved: !!row.approved,
    created_at: row.created_at,
  };
}

// multer diskStorage bu klasöre yazar; server.js bunu kullanır
function multerDestination() {
  return UPLOAD_DIR;
}

async function saveUpload(file, meta) {
  // file: multer diskStorage çıktısı -> file.filename diskte zaten yazılmış dosyanın adı
  const kind = kindFromMime(file.mimetype);
  const filename = kind === 'image' ? await normalizeHeicIfNeeded(file) : file.filename;
  const thumbnail = kind === 'image' ? await makeThumbnail(filename) : null;

  const insert = db.prepare(`
    INSERT INTO media (filename, thumbnail, original_name, mime_type, kind, guest_name, message, approved)
    VALUES (@filename, @thumbnail, @original_name, @mime_type, @kind, @guest_name, @message, @approved)
  `);
  const info = insert.run({
    filename,
    thumbnail,
    original_name: file.originalname,
    mime_type: file.mimetype,
    kind,
    guest_name: meta.guestName || null,
    message: meta.message || null,
    approved: meta.approved ? 1 : 0,
  });
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid);
  return toRecord(row);
}

async function listApproved() {
  return db.prepare('SELECT * FROM media WHERE approved = 1 ORDER BY created_at DESC').all().map(toRecord);
}

async function listAll() {
  return db.prepare('SELECT * FROM media ORDER BY created_at DESC').all().map(toRecord);
}

async function approve(id) {
  db.prepare('UPDATE media SET approved = 1 WHERE id = ?').run(id);
}

async function hide(id) {
  db.prepare('UPDATE media SET approved = 0 WHERE id = ?').run(id);
}

async function remove(id) {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!row) return;
  const filePath = path.join(UPLOAD_DIR, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (row.thumbnail) {
    const thumbPath = path.join(UPLOAD_DIR, row.thumbnail);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }
  db.prepare('DELETE FROM media WHERE id = ?').run(id);
}

async function streamAllForZip(res, zipName) {
  const items = db.prepare('SELECT * FROM media ORDER BY created_at ASC').all();
  res.attachment(zipName);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);
  for (const item of items) {
    const filePath = path.join(UPLOAD_DIR, item.filename);
    if (fs.existsSync(filePath)) {
      const label = item.guest_name ? `${item.guest_name} - ` : '';
      archive.file(filePath, { name: `${label}${item.original_name || item.filename}` });
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
  UPLOAD_DIR,
  multerDestination,
};
