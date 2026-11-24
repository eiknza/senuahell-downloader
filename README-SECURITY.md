# SenuaHell Downloader - güvenlik yapılandırması

## Render ortam değişkenleri

- `ALLOWED_ORIGINS`: Ek site alan adları. Birden fazla adresi virgülle ayırın. Örnek: `https://www.ornekalanadi.com,https://ornekalanadi.com`. `https://senuahell.pages.dev` varsayılan olarak izinlidir.
- `MAX_CONCURRENT_DOWNLOADS`: Sunucudaki toplam eşzamanlı indirme sınırı (varsayılan 5, üst sınır 20).
- `MAX_DOWNLOADS_PER_IP`: IP başına eşzamanlı indirme sınırı (varsayılan 2, üst sınır 5).
- `DOWNLOAD_RATE_LIMIT`: IP başına 10 dakikada başlatılabilecek indirme sayısı (varsayılan 5, üst sınır 20).

## Güvenlik davranışı

- Her indirme için kriptografik rastgele bir erişim anahtarı üretilir.
- Durum sorgulama, iptal ve dosya indirme istekleri `X-Download-Token` başlığıyla doğrulanır.
- İndirme başlatma ve durum/dosya istekleri IP bazlı sınırlandırılır.
- Tarayıcı CORS erişimi yalnızca varsayılan Pages adresine ve `ALLOWED_ORIGINS` listesine verilir.
- İndirme dosyaları ve görev kayıtları bir saat sonra temizlenir.

## Deploy

Downloader servisini Render'a yeniden deploy edin. Özel alan adı kullanıyorsanız Render servisinin Environment bölümüne `ALLOWED_ORIGINS` ekleyin. Örnek adresleri gerçek sitenizin `https://` ile başlayan tam adresleriyle değiştirin.

Bu sınırlamalar süreç belleğinde tutulur. Birden fazla Render instance'ı kullanılıyorsa IP hız sınırları instance başına uygulanır; dağıtık/global sınır için Redis gibi ortak bir depo gerekir.
