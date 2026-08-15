# QR Kodlu Dijital Anı Albümü

Lumoment/Storpix/Anıdepola gibi sitelerin sunduğu "QR kod okutunca misafirler fotoğraf/video yükler, hepsi tek bir ortak galeride toplanır" sisteminin kendi kendine barındırabileceğin (self-hosted), sıfırdan kodlanmış hâli. Kendi düğünün/etkinliğin için bunu kurup çalıştırabilirsin.

## Nasıl çalışıyor? (mimari özet)

Bu tarz sistemlerin hepsi aslında aynı 4 parçadan oluşur:

1. **Bir "yükleme" web sayfası** — mobil tarayıcıda açılan, kamera/galeriden fotoğraf-video seçip gönderebildiğin basit bir form. Giriş/kayıt gerektirmez.
2. **Bir sunucu (API)** — gelen dosyaları alır, diske (veya bulut depolamaya) kaydeder, kim yüklediğine dair küçük bir not (isim, mesaj, tarih) veritabanına yazar.
3. **Bir "galeri" sayfası** — veritabanındaki kayıtlara bakıp yüklenen tüm medyayı bir ızgara (grid) hâlinde herkese açık gösterir.
4. **Bir QR kod** — aslında sadece 1 numaralı sayfanın URL'sini kodlayan bir resim. Masaya bastırılan kart, telefonla okutulduğunda doğrudan o adrese gider. QR'ın "sihri" yok; tamamen normal bir link.

Buna ek olarak bu projede şunlar da var: şifreli bir **admin paneli** (fotoğrafları gizleme/onaylama ve tüm albümü tek ZIP olarak indirme) ve masaya basılacak **QR kartlarını otomatik PDF üreten** bir script — Lumoment'in "50 masa kartı" dediği şeyin karşılığı.

```
Misafirin telefonu → QR okutur → /  (yükleme sayfası)
                                   │  POST /upload (dosya + isim + mesaj)
                                   ▼
                              sunucu (Express)
                                   │
                                   ▼
                          storage/ modülü  ←── STORAGE_DRIVER .env değişkeniyle seçilir
                     ┌─────────────┴─────────────┐
                     ▼                             ▼
            "local" sürücü                   "r2" sürücü
      uploads/ klasörü + SQLite         Cloudflare R2 + Cloudflare D1
      (VPS/kendi sunucun için)        (Render/Railway gibi disksiz platformlar için)
                     │                             │
                     └──────────────┬──────────────┘
                                     ▼
                    /galeri  (herkese açık ızgara)
                    /admin   (şifreli: onayla / gizle / sil / ZIP indir)
```

Sunucu kodu hangi depolamayı kullandığını bilmez; `storage/index.js` sadece `.env`'deki `STORAGE_DRIVER` değerine göre `storage/local.js` ya da `storage/r2.js`'i yükler, ikisi de aynı fonksiyonları (saveUpload, listApproved, listAll, approve, hide, remove, streamAllForZip) sunar. Bu sayede aynı proje hem "kendi VPS'im var" hem "tamamen ücretsiz platformlarda barındırmak istiyorum" senaryosuna kod değiştirmeden (sadece `.env` ile) uyuyor.

## Teknoloji seçimleri ve nedenleri

- **Node.js + Express** — basit, hafif, tek dosyada tüm route'ları yönetebiliyorsun.
- **Multer** — dosya yükleme middleware'i, boyut/tip sınırlaması koyabiliyorsun.
- **sharp** — yüklenen fotoğraflardan küçük thumbnail üretip galeriyi hızlı yükletiyor (her iki depolama sürücüsünde de sunucu tarafında çalışır).
- **qrcode + pdfkit** — QR kod ve yazdırılabilir masa kartı PDF'i üretimi.
- **express-basic-auth** — admin sayfası için basit kullanıcı adı/şifre koruması.
- **"local" depolama sürücüsü — SQLite (better-sqlite3) + `uploads/` klasörü** — ayrı bir veritabanı sunucusu kurmana gerek yok, tek dosya. Kalıcı diski olan bir VPS'te kullan.
- **"r2" depolama sürücüsü — Cloudflare R2 (`@aws-sdk/client-s3` ile, S3 uyumlu) + Cloudflare D1 (HTTP API)** — disksiz/geçici dosya sistemi olan ücretsiz platformlarda (Render, Railway...) dosyaların ve albüm bilgilerinin kalıcı kalmasını sağlar; sunucu her yeniden başladığında hiçbir şey kaybolmaz çünkü hiçbir şey sunucunun kendi diskinde tutulmuyor.

## Kurulum (local'de deneme)

Node.js 18+ gerekir.

```bash
npm install
cp .env.example .env
```

`.env` dosyasını aç, en azından şunları değiştir:

- `EVENT_NAME` → "Ayşe & Mehmet'in Düğünü" gibi kendi başlığın
- `ADMIN_USER` / `ADMIN_PASS` → admin paneline girecek şifre (mutlaka değiştir!)
- `PUBLIC_BASE_URL` → local'de test ederken `http://localhost:3000` kalabilir; yayına aldığında gerçek domainin olacak (aşağıya bak)

Sonra çalıştır:

```bash
npm start
```

- Yükleme sayfası: http://localhost:3000/
- Galeri: http://localhost:3000/galeri
- Admin: http://localhost:3000/admin (kullanıcı adı/şifre `.env`'den)

Telefonundan aynı Wi-Fi üzerinden denemek istersen `http://localhost:3000` yerine bilgisayarının yerel IP'sini kullan (örn. `http://192.168.1.20:3000`) ve `.env`'deki `PUBLIC_BASE_URL`'i de ona göre güncelle.

## QR kod ve masa kartlarını üretmek

`PUBLIC_BASE_URL`'i yayına aldığın gerçek adres olarak ayarladıktan sonra:

```bash
# Tek bir QR kod PNG'si (output/qr-kod.png)
npm run qr

# Masalara basılacak, kesim çizgili A4 kart sayfaları (output/masa-kartlari.pdf)
# Varsayılan 50 kart üretir (Lumoment'in paketiyle aynı sayı), istersen değiştir:
TABLE_CARD_COUNT=80 npm run cards
```

`output/masa-kartlari.pdf` dosyasını olduğu gibi bir matbaaya/yazıcıya verip A4 kağıtlara bastırabilir, kesim çizgilerinden keserek masalara koyabilirsin.

## Moderasyon (isteğe bağlı)

`.env` içinde `REQUIRE_MODERATION=true` yaparsan, yüklenen fotoğraflar otomatik galeriye düşmez; önce `/admin` panelinden "Onayla" demen gerekir. Bu, uygunsuz/yanlış içerik yüklenme riskine karşı bir güvenlik önlemi. Küçük, güvendiğin bir davetli listesi için `false` bırakman yeterli.

## Nereye deploy edeyim?

Hangi seçeneği seçtiğine göre `.env`'deki `STORAGE_DRIVER`'ı ayarla: kendi sunucunda `local`, Render/Railway gibi ücretsiz platformlarda `r2`.

### Seçenek A — Kendi VPS'in (`STORAGE_DRIVER=local`) — gerçek anlamda ücretsiz istiyorsan: Oracle Cloud "Always Free"

Oracle Cloud'un **Always Free** katmanı (30 günlük deneme değil, süresiz ücretsiz) her zaman açık kalabilen bir sunucu (VM) ve 200 GB'a kadar kalıcı disk veriyor — bu proje ile birebir uyumlu, çünkü kod zaten dosyaları yerel diske kaydediyor. Aşağıdaki adımlar tamamen sıfırdan, hesap açmadan HTTPS'e kadar.

**1) Hesap aç**

[cloud.oracle.com](https://cloud.oracle.com) üzerinden "Start for free" ile kayıt ol. Kimlik doğrulama için geçerli bir kredi/banka kartı istenir (Always Free kaynaklar için hiç ücretlendirilmezsin, kart sadece dolandırıcılık kontrolü içindir). Kayıt sırasında bir **Home Region** seçmen istenecek — bunu **sonradan değiştiremezsin**, bu yüzden Türkiye'ye yakın ve Always Free kapasitesi olan bir bölge seç (örn. bir Avrupa bölgesi); şekil (shape) seçim ekranında yanında "Always Free" etiketi olmayan bir bölgeyi seçersen ücretsiz VM oluşturamazsın.

**2) VM instance oluştur**

Konsolda **Compute > Instances > Create Instance**'a git:

- **Name:** `ani-albumu` gibi bir isim ver.
- **Image and shape > Edit:** İşletim sistemi olarak Ubuntu'nun en güncel LTS sürümünü seç (örn. "Canonical Ubuntu 24.04"). Shape kısmında "Change shape" ile:
  - **VM.Standard.A1.Flex** (Ampere/ARM) — daha güçlü (2 OCPU / 12 GB RAM'e kadar Always Free), ama bazı bölgelerde anlık kapasite dolu çıkabilir ("Out of host capacity" hatası). Böyle bir hatayla karşılaşırsan birkaç dakika/saat sonra tekrar dene, ya da
  - **VM.Standard.E2.1.Micro** (AMD/x86) — daha mütevazı (1 OCPU / 1 GB RAM) ama kapasite sorunu neredeyse hiç yaşanmaz, bu ölçekteki bir albüm uygulaması için fazlasıyla yeterli.
  - ARM shape'i seçtiysen imajın da "aarch64" (ARM) sürümü olduğundan emin ol; Oracle bunu genelde otomatik eşleştirir.
- **Networking:** "Create new virtual cloud network" seçili kalsın (varsayılan bir VCN + public subnet otomatik oluşturur). **"Assign a public IPv4 address"** seçeneğinin **açık** olduğundan emin ol — bu olmadan sunucuna internetten ulaşamazsın.
- **Add SSH keys:** "Generate a key pair for me" seç, **"Save private key"** ile `.key` dosyasını bilgisayarına indir (bu dosya sadece bir kere gösterilir, kaybedersen sunucuya bir daha giremezsin). Zaten bir SSH anahtarın varsa "Upload public key file" ile kendi `id_rsa.pub`'ını da yükleyebilirsin.
- **Boot volume:** "Specify a custom boot volume size" ile istersen 200 GB'a kadar çıkarabilirsin (fotoğraf/video için daha ferah olur); varsayılan da (genelde 50 GB) bir düğün albümü için fazlasıyla yeterlidir.
- **Create**'e bas. Instance birkaç dakikada "Running" durumuna geçer; sayfadaki **Public IP Address**'i not al.

**3) SSH ile bağlan**

```bash
chmod 400 /indirdigin/yol/ssh-key.key
ssh -i /indirdigin/yol/ssh-key.key ubuntu@SUNUCU_PUBLIC_IP
```

**4) Portları aç (iki katman var: Oracle'ın bulut güvenlik duvarı + sunucunun kendi güvenlik duvarı — ikisini de yapman gerekiyor)**

Önce Oracle tarafı: Konsolda oluşan VCN'e gidip **Security Lists** (ya da yeni arayüzde Network Security Groups) üzerinden 80 (HTTP) ve 443 (HTTPS) portları için "Add Ingress Rule" ile `0.0.0.0/0` kaynağından TCP izni ekle (22/SSH zaten varsayılan olarak açık gelir).

Sonra sunucu tarafı — Oracle'ın hazır Ubuntu imajı varsayılan olarak bu portları iptables ile kapalı tutar (bilinen bir Oracle Cloud tuhaflığı), bu yüzden SSH'tan bağlandıktan sonra:

```bash
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo apt install -y iptables-persistent   # kurulu değilse; kurulum sırasında "Save current rules?" sorusuna Evet de
sudo netfilter-persistent save
```

**5) Node.js ve derleme araçlarını kur**

Bu proje `better-sqlite3` ve `sharp` gibi derlenmesi gereken (native) paketler kullanıyor, o yüzden `build-essential` ve `python3` da lazım:

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 git
node -v   # 18 ya da üzeri olmalı
```

**6) Projeyi sunucuya taşı ve kur**

En kolayı: bu zip'i kendi bilgisayarında bir GitHub reposuna atıp sunucuda `git clone` ile çekmek. Repo kullanmak istemiyorsan `scp` ile de kopyalayabilirsin:

```bash
# kendi bilgisayarından:
scp -i /indirdigin/yol/ssh-key.key -r qr-ani-albumu ubuntu@SUNUCU_PUBLIC_IP:~/
```

Sunucuda:

```bash
cd ~/qr-ani-albumu
npm install --production
cp .env.example .env
nano .env   # STORAGE_DRIVER=local kalsın; EVENT_NAME, ADMIN_USER, ADMIN_PASS'i doldur,
            # PUBLIC_BASE_URL'i bir sonraki adımdaki domainle güncelle
```

**7) pm2 ile sürekli çalışır hâle getir**

```bash
sudo npm install -g pm2
pm2 start server.js --name ani-albumu
pm2 save
pm2 startup   # ekrana yazdırdığı komutu kopyalayıp çalıştır (sunucu yeniden başlayınca da otomatik ayağa kalksın diye)
```

**8) Domain + HTTPS**

Bir domainin yoksa: ucuz bir domain satın alabilir (yıllık ~$10) ya da tamamen ücretsiz [duckdns.org](https://www.duckdns.org) gibi bir servisten `senin-adin.duckdns.org` gibi bir adres alabilirsin — Let's Encrypt bu tür adreslere de gerçek, tarayıcının güvendiği sertifika verir.

Domainin A kaydını sunucunun Public IP'sine yönlendirdikten sonra (DNS'in yayılması birkaç dakika-birkaç saat sürebilir):

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/ani-albumu
```

İçine şunu yaz (`SENIN_DOMAININ` yerine gerçek domainini yaz):

```nginx
server {
    listen 80;
    server_name SENIN_DOMAININ;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 60M;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ani-albumu /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d SENIN_DOMAININ   # ücretsiz HTTPS sertifikasını otomatik kurar ve Nginx'i günceller
```

HTTPS burada asıl önemli olan yer admin panelidir: `/admin` şifreni (Basic Auth) düz HTTP üzerinden gönderirse, aynı Wi-Fi'daki biri onu kolayca yakalayabilir — bu yüzden domain + certbot adımını atlamamanı öneririz.

**9) Son kontrol**

`.env`'deki `PUBLIC_BASE_URL`'i `https://SENIN_DOMAININ` yap, `pm2 restart ani-albumu` ile yeniden başlat. Tarayıcından `https://SENIN_DOMAININ` adresine gidip yükleme sayfasının açıldığını doğrula, sonra kendi bilgisayarında (sunucuda değil) `.env`'deki `PUBLIC_BASE_URL`'i aynı adrese ayarlayıp `npm run qr` ve `npm run cards` ile QR kodunu ve masa kartlarını üret.

Aynı adımlar Hetzner/DigitalOcean/Contabo gibi aylık ~4-6$'lık ücretli bir VPS'te de (2-8 arası değişen adımlar) birebir çalışır — Oracle sadece "tamamen ücretsiz" istersen bir seçenek, kapasite bulma konusunda biraz sabır gerektirebilir.

### Seçenek B — Render / Railway (ücretsiz, `STORAGE_DRIVER=r2`) — Cloudflare R2 + D1 ile

Render'ın free planında disk kalıcı değildir; sunucu her yeniden başladığında `uploads/` klasörü ve içindeki SQLite dosyası silinir. Bu yüzden `r2` sürücüsü dosyaları Cloudflare R2'ye, albüm bilgilerini (isim/mesaj/onay durumu) Cloudflare D1'e yazar — ikisi de Cloudflare'in kendi ücretsiz katmanında kalıcı olarak durur, sunucu (Render) tamamen "durum tutmayan" (stateless) hâle gelir.

**1) Cloudflare tarafını hazırla** (tek seferlik, [dash.cloudflare.com](https://dash.cloudflare.com)'dan):

- **R2 bucket oluştur:** R2 > Create bucket, örn. `ani-albumu` adında. Bucket ayarlarından **Settings > Public Development URL**'i "Allow Access" ile aç — sana `https://pub-xxxxxxxx.r2.dev` gibi bir adres verecek, bunu not al (bu, misafirlerin fotoğrafları doğrudan görebileceği adres).
- **R2 API anahtarları:** R2 ana sayfasında "Manage R2 API Tokens" > Create API Token; en azından seçtiğin bucket için Read+Write izni ver. Sana bir Access Key ID ve Secret Access Key verecek — bunları not al (sadece bir kere gösterilir).
- **D1 veritabanı oluştur:** Workers & Pages > D1 > Create database, örn. `ani-albumu-db`. Oluşunca sana bir Database ID verecek, not al. (Tablo şemasını uygulama kendisi ilk çalıştığında otomatik oluşturuyor, elle bir şey yapmana gerek yok.)
- **Genel API token:** My Profile (sağ üstteki hesap ikonu) > API Tokens > Create Token > "Edit Cloudflare Workers" şablonunu temel alıp en azından hesabın için **D1 Edit** izni olan bir token oluştur. Bu, R2 API anahtarlarından **farklı** bir şeydir.
- **Hesap ID'n:** Dashboard'da herhangi bir domain/site sayfasının sağ alt köşesinde "Account ID" yazar, onu da not al.

**2) `.env` değerlerini doldur:**

```
STORAGE_DRIVER=r2
CF_ACCOUNT_ID=...
CF_API_TOKEN=...              # D1 Edit izinli genel token
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=ani-albumu
R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
CF_D1_DATABASE_ID=...
```

**3) Render'a deploy et:**

1. Projeyi bir GitHub reposuna it (Render, repo'dan otomatik deploy ediyor).
2. Render'da "New > Web Service", reponu seç, **free** planı seç. Build command: `npm install`, start command: `npm start`.
3. Render'ın "Environment" sekmesinden yukarıdaki `.env` değerlerinin hepsini tek tek gir (özellikle `STORAGE_DRIVER=r2` ve tüm `CF_*`/`R2_*` değişkenleri) — `PUBLIC_BASE_URL`'i Render'ın sana verdiği `https://xxxxx.onrender.com` adresi (ya da bağladığın kendi domainin) yap.
4. Deploy tamamlanınca `npm run qr` / `npm run cards`'ı **kendi bilgisayarında**, `.env`'deki `PUBLIC_BASE_URL`'i gerçek Render adresine ayarlayıp çalıştır (bu iki script sunucuya değil, senin bilgisayarına PDF/PNG üretir).

**Bilmen gereken tek dezavantaj:** Render'ın free planı 15 dakika trafik almayınca uyur; bir sonraki istek geldiğinde tekrar ayağa kalkması ~30-50 saniye sürer. Yani düğün günü bir süre kimse QR okutmazsa, ilk okutan misafirin sayfası biraz geç açılabilir — sonraki misafirler için normal hızda çalışır. Sürekli aktif kalması gereken kritik bir kullanım değilse (bir günlük etkinlik için gayet makul) bu sorun olmaz.

### Seçenek C — Sadece etkinlik günü için (en basit, kalıcılık garantisi olmadan)

Evdeki bir bilgisayarda `npm start` ile çalıştırıp `ngrok` gibi bir tünel aracıyla (`ngrok http 3000`) geçici bir genel adres üretebilirsin. Kurulumu dakikalar sürer ama ngrok'un ücretsiz adresi her açılışta değişir ve bilgisayar kapanınca sistem durur — bu yüzden sadece deneme/prova için önerilir, gerçek etkinlik günü için değil.

## Yedekleme

Etkinlik bittikten sonra `/admin` sayfasındaki **"Tüm albümü ZIP olarak indir"** butonuyla tüm fotoğraf ve videoları tek dosya hâlinde indirip bilgisayarına/bulut depona yedekle. `r2` sürücüsünü kullanıyorsan dosyalar zaten Cloudflare'de kalıcı duruyor (Render'ı kapatsan bile kaybolmaz), ama yine de elinde ayrı bir kopya olması için bu adımı düğün sonrası bir kez yapmanı öneririz. `local` sürücüde ise sunucuyu bir süre sonra kapatmayı planlıyorsan bu adım şart.

## Güvenlik notları

- `ADMIN_PASS`'i mutlaka değiştir; varsayılan değerle yayına almayın.
- Prod ortamda mutlaka HTTPS kullan (Seçenek A'daki certbot adımı).
- `MAX_FILE_SIZE_MB` ve `MAX_FILES_PER_UPLOAD` değerlerini sunucunun disk kapasitesine göre ayarla.
- Bu proje kasıtlı olarak misafirlerden hesap açmasını istemiyor (sürtünmeyi azaltmak için) — yani teorik olarak linki bilen herkes yükleme yapabilir. Moderasyonu (`REQUIRE_MODERATION=true`) açık tutmak istismarı engeller.

## Genişletme fikirleri

- Video dosyaları için de otomatik küçük önizleme (thumbnail) üretimi — `ffmpeg` ile ilk kareyi almak gerekir.
- Yüz tanıma / otomatik gruplama yok; istenirse üçüncü parti bir API eklenebilir.
- Çoklu etkinlik desteği (her etkinlik için ayrı albüm/QR) — `media` tablosuna bir `event_id` kolonu ekleyip route'ları buna göre filtrelemek yeterli.
- E-posta/SMS ile "albüme yeni fotoğraf eklendi" bildirimi.

## Klasör yapısı

```
qr-ani-albumu/
├── server.js              # Express sunucusu, tüm route'lar (depolamadan habersiz)
├── db.js                  # SQLite bağlantısı ve tablo şeması (sadece "local" sürücü kullanır)
├── storage/
│   ├── index.js           # STORAGE_DRIVER'a göre local.js ya da r2.js'i seçer
│   ├── local.js            # Yerel disk + SQLite (VPS/Oracle Cloud için)
│   └── r2.js                # Cloudflare R2 + Cloudflare D1 (Render/Railway için)
├── views/                 # EJS sayfa şablonları (yükleme, galeri, admin)
├── public/style.css       # Tüm sayfalarda kullanılan ortak stil
├── scripts/
│   ├── generate-qr.js            # Tek QR kod PNG üretir
│   └── generate-table-cards.js   # Masa kartları PDF'i üretir
├── assets/fonts/          # PDF'lerde Türkçe karakterler için gömülü font
├── uploads/                # Yüklenen fotoğraf/videolar ("local" sürücüde, çalışırken oluşur)
├── data/                    # SQLite veritabanı dosyası ("local" sürücüde, çalışırken oluşur)
└── output/                  # Üretilen QR/PDF dosyaları
```
