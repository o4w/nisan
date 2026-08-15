// Masaya konacak, misafirlerin okutacağı QR kartlarını A4 sayfalar halinde PDF olarak üretir.
// Kullanım: npm run cards
// İsteğe bağlı: TABLE_CARD_COUNT=50 node scripts/generate-table-cards.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EVENT_NAME = process.env.EVENT_NAME || 'Anı Albümümüz';
const CARD_COUNT = Number(process.env.TABLE_CARD_COUNT || 50);

const outDir = path.join(__dirname, '..', 'output');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'masa-kartlari.pdf');

const PAGE = { width: 595.28, height: 841.89 }; // A4 (pt)
const MARGIN = 28;
const COLS = 2;
const ROWS = 3;
const CARD_W = (PAGE.width - MARGIN * 2) / COLS;
const CARD_H = (PAGE.height - MARGIN * 2) / ROWS;

async function main() {
  const target = `${PUBLIC_BASE_URL}/`;
  const qrDataUrl = await QRCode.toDataURL(target, { margin: 1, width: 500 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.pipe(fs.createWriteStream(outPath));

  // Standart Helvetica fontu Türkçe karakterleri (ş, ğ, ı, İ, ç, ö, ü) doğru basmaz.
  // Bu yüzden Türkçe karakterleri destekleyen DejaVu Sans fontunu gömüyoruz.
  const fontDir = path.join(__dirname, '..', 'assets', 'fonts');
  doc.registerFont('Body', path.join(fontDir, 'DejaVuSans.ttf'));
  doc.registerFont('Body-Bold', path.join(fontDir, 'DejaVuSans-Bold.ttf'));

  const perPage = COLS * ROWS;
  const totalPages = Math.ceil(CARD_COUNT / perPage);

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();

    for (let i = 0; i < perPage; i++) {
      const cardIndex = page * perPage + i;
      if (cardIndex >= CARD_COUNT) break;

      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = MARGIN + col * CARD_W;
      const y = MARGIN + row * CARD_H;

      // Kesim çizgisi
      doc.rect(x, y, CARD_W, CARD_H).lineWidth(0.5).dash(3, { space: 3 }).strokeColor('#cccccc').stroke();
      doc.undash();

      const padding = 24;
      const innerW = CARD_W - padding * 2;

      // Başlık
      doc
        .fillColor('#2b2420')
        .font('Body-Bold')
        .fontSize(13)
        .text(EVENT_NAME, x + padding, y + 16, { width: innerW, align: 'center' });

      // QR kod
      const qrSize = Math.min(innerW, CARD_H - 130);
      const qrX = x + (CARD_W - qrSize) / 2;
      const qrY = y + 66;
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

      // Alt metin
      doc
        .fillColor('#8a7c70')
        .font('Body')
        .fontSize(10)
        .text('Fotoğraf ve videolarınızı paylaşmak için\nkameranızla QR kodu okutun', x + padding, qrY + qrSize + 10, {
          width: innerW,
          align: 'center',
        });
    }
  }

  doc.end();
  console.log(`${CARD_COUNT} adet masa kartı oluşturuldu (${totalPages} sayfa): ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
