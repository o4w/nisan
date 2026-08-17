require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const basicAuth = require('express-basic-auth');

const storage = require('./storage');

const app = express();

const PORT = process.env.PORT || 3000;
const EVENT_NAME = process.env.EVENT_NAME || 'Anı Albümümüz';
const EVENT_DATE = process.env.EVENT_DATE || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// Not: Render'ın ücretsiz planı 512MB RAM ile sınırlı. Tek bir istekte
// MAX_FILES_PER_UPLOAD × MAX_FILE_SIZE_MB kadar veri aynı anda bellekte tutulabiliyor
// (özellikle R2 sürücüsünde, dosyalar diske değil belleğe yazılıyor) - bu yüzden
// varsayılanı ihtiyatlı tutuyoruz. Daha yüksek bir limit istersen Render'da
// MAX_FILE_SIZE_MB ortam değişkenini kendin artırabilirsin.
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 25);
const MAX_FILES_PER_UPLOAD = Number(process.env.MAX_FILES_PER_UPLOAD || 10);
const REQUIRE_MODERATION = String(process.env.REQUIRE_MODERATION || 'false') === 'true';

// Render (ve genelde her PaaS) bir ters proxy arkasında çalışır; bu olmadan
// req.ip her zaman proxy'nin adresini gösterir, IP bazlı hız sınırlaması yanlış çalışır.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Statik dosyalar (style.css vb.) tarayıcıda 1 gün önbelleklensin - tekrar eden
// ziyaretlerde (galeri her açılışta stil dosyasını yeniden indirmesin) gereksiz
// sunucu yükünü ve bekleme süresini azaltır.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(express.urlencoded({ extended: true }));

// "local" sürücüde dosyalar bu sunucu tarafından /uploads altında servis edilir.
// "r2" sürücüde dosyalar doğrudan Cloudflare R2'nin genel URL'sinden servis edilir, bu satıra gerek yok.
if (storage.driver === 'local') {
  app.use('/uploads', express.static(storage.UPLOAD_DIR));
}

// ---------- Multer (dosya yükleme) ayarları ----------
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime|webm))$/i;

// "r2" sürücüde dosyayı diske hiç yazmadan bellekte (buffer) tutup doğrudan Cloudflare'e yüklüyoruz.
// "local" sürücüde ise doğrudan uploads/ klasörüne yazıyoruz (mevcut davranış).
const multerStorage =
  storage.driver === 'r2'
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => cb(null, storage.UPLOAD_DIR),
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname) || '';
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
          cb(null, unique);
        },
      });

const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_FILES_PER_UPLOAD,
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype)) return cb(null, true);
    cb(new Error('Desteklenmeyen dosya türü: ' + file.mimetype));
  },
});

// Basit IP bazlı hız sınırlama - Render'ın kısıtlı ücretsiz kaynağını (özellikle
// çok sayıda büyük dosyanın art arda yüklenmesi durumunda) korumak için. Ekstra
// npm paketi gerektirmeden, bellek içi basit bir "sliding window" ile çalışır.
const UPLOAD_RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };
const uploadHits = new Map(); // ip -> timestamp[]
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (uploadHits.get(ip) || []).filter((t) => now - t < UPLOAD_RATE_LIMIT.windowMs);
  hits.push(now);
  uploadHits.set(ip, hits);
  // Harita zamanla cok buyumesin diye arada bir tamamen suresi dolmus girdileri temizle.
  if (uploadHits.size > 500) {
    for (const [key, arr] of uploadHits) {
      if (arr.every((t) => now - t >= UPLOAD_RATE_LIMIT.windowMs)) uploadHits.delete(key);
    }
  }
  return hits.length > UPLOAD_RATE_LIMIT.max;
}

// ---------- Sayfalar ----------

// Misafir yükleme sayfası (QR kodun yönlendirdiği ana sayfa)
app.get('/', (req, res) => {
  res.render('index', { eventName: EVENT_NAME, eventDate: EVENT_DATE, maxFiles: MAX_FILES_PER_UPLOAD, maxSize: MAX_FILE_SIZE_MB });
});

// Yükleme işlemi
app.post('/upload', (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).render('upload-result', {
      success: false,
      error: 'Çok fazla yükleme denemesi yaptınız, lütfen biraz sonra tekrar deneyin.',
      eventName: EVENT_NAME,
      eventDate: EVENT_DATE,
    });
  }
  upload.array('photos', MAX_FILES_PER_UPLOAD)(req, res, async (err) => {
    if (err) {
      return res.status(400).render('upload-result', { success: false, error: err.message, eventName: EVENT_NAME, eventDate: EVENT_DATE });
    }
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).render('upload-result', { success: false, error: 'Lütfen en az bir fotoğraf veya video seçin.', eventName: EVENT_NAME, eventDate: EVENT_DATE });
    }

    const guestName = (req.body.guest_name || '').trim().slice(0, 80);
    const message = (req.body.message || '').trim().slice(0, 300);

    try {
      for (const file of files) {
        await storage.saveUpload(file, { guestName, message, approved: !REQUIRE_MODERATION });
      }
      res.render('upload-result', { success: true, count: files.length, eventName: EVENT_NAME, eventDate: EVENT_DATE, moderated: REQUIRE_MODERATION });
    } catch (uploadErr) {
      console.error('Yukleme hatasi:', uploadErr);
      res.status(500).render('upload-result', {
        success: false,
        error: 'Yükleme sırasında bir sorun oluştu, lütfen tekrar deneyin.',
        eventName: EVENT_NAME,
        eventDate: EVENT_DATE,
      });
    }
  });
});

// Herkese açık galeri
app.get('/galeri', async (req, res, next) => {
  try {
    const items = await storage.listApproved();
    res.render('gallery', { items, eventName: EVENT_NAME, eventDate: EVENT_DATE });
  } catch (e) {
    next(e);
  }
});

// Galerinin JSON hali - sayfa açıkken arka planda periyodik olarak buradan
// yeni paylaşım olup olmadığı kontrol edilir (canlı/otomatik güncelleme için).
app.get('/api/galeri', async (req, res, next) => {
  try {
    const items = await storage.listApproved();
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

// ---------- Admin (basit şifre korumalı) ----------
const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'change-me' },
  challenge: true,
  realm: 'Ani Albumu Admin',
});

app.get('/admin', adminAuth, async (req, res, next) => {
  try {
    const items = await storage.listAll();
    res.render('admin', { items, eventName: EVENT_NAME, publicBaseUrl: PUBLIC_BASE_URL });
  } catch (e) {
    next(e);
  }
});

app.post('/admin/onayla/:id', adminAuth, async (req, res, next) => {
  try {
    await storage.approve(req.params.id, req.body.resource_type);
    res.redirect('/admin');
  } catch (e) {
    next(e);
  }
});

app.post('/admin/gizle/:id', adminAuth, async (req, res, next) => {
  try {
    await storage.hide(req.params.id, req.body.resource_type);
    res.redirect('/admin');
  } catch (e) {
    next(e);
  }
});

app.post('/admin/sil/:id', adminAuth, async (req, res, next) => {
  try {
    await storage.remove(req.params.id, req.body.resource_type);
    res.redirect('/admin');
  } catch (e) {
    next(e);
  }
});

// Tüm albümü ZIP olarak indir (düğün çiftinin arşivlemesi için)
app.get('/admin/tumunu-indir', adminAuth, async (req, res, next) => {
  try {
    await storage.streamAllForZip(res, `ani-albumu-${Date.now()}.zip`);
  } catch (e) {
    next(e);
  }
});

app.listen(PORT, () => {
  console.log(`Ani albumu calisiyor: http://localhost:${PORT}`);
  console.log(`Depolama surucusu: ${storage.driver}`);
  console.log(`Misafir yukleme sayfasi (QR bunu hedefleyecek): ${PUBLIC_BASE_URL}/`);
  console.log(`Galeri: ${PUBLIC_BASE_URL}/galeri`);
  console.log(`Admin: ${PUBLIC_BASE_URL}/admin`);
});
