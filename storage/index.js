// Depolama sürücüsü seçici. .env içindeki STORAGE_DRIVER'a göre local ya da r2 (Cloudflare) uygulamasını yükler.
// server.js sadece bu modülün export ettiği ortak arayüzü (saveUpload, listApproved, listAll, approve, hide, remove, streamAllForZip) kullanır.
const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();

const impl = driver === 'r2' ? require('./r2') : require('./local');

module.exports = { ...impl, driver };
