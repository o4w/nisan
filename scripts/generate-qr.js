// Yükleme sayfasına giden QR kodu tek bir PNG olarak üretir.
// Kullanım: npm run qr
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const outDir = path.join(__dirname, '..', 'output');
fs.mkdirSync(outDir, { recursive: true });

const target = `${PUBLIC_BASE_URL}/`;
const outPath = path.join(outDir, 'qr-kod.png');

QRCode.toFile(outPath, target, { width: 1000, margin: 2, color: { dark: '#2b2420', light: '#ffffffff' } }, (err) => {
  if (err) throw err;
  console.log(`QR kodu oluşturuldu: ${outPath}`);
  console.log(`Hedef adres: ${target}`);
});
