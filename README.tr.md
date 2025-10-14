# PeerTube Araştırma & Instance Ekleyici

PeerTube instance'larını otomatik olarak keşfeden ve kaydeden araç.

[English](README.md)

## Özellikler

- **Araştırıcı**: Mevcut PeerTube instance'larından yenilerini keşfeder
- **Instance Ekleyici**: Bulunan instance'ları joinpeertube.org'a kaydeder
- **Otomatik**: GitHub Actions ile her gün çalışır

## Nasıl Çalışır

1. **Araştırıcı** PeerTube instance'larını tarar ve yenilerini bulur
2. Yeni instance'lar `new-instances.txt` dosyasına kaydedilir
3. **Instance Ekleyici** bunları joinpeertube.org'a kaydeder

## Manuel Kullanım

### Bağımlılıkları Yükle

```bash
pnpm install
```

### Araştırıcıyı Çalıştır

```bash
# Redis olmadan (GitHub Actions için önerilen)
node peertube-researcher.js

# Redis ile (yerel önbellekleme için)
node peertube-researcher.js --use-redis
```

### Instance Ekleyiciyi Çalıştır

```bash
node peertube-instance-add.js
```

## GitHub Actions

Workflow otomatik çalışır:

- **04:00 UTC**: Araştırıcı instance'ları keşfeder
- **06:00 UTC**: Instance Ekleyici onları kaydeder

Actions sekmesinden manuel olarak da çalıştırabilirsiniz.

## Ayarlar

Dosyalardaki `config` nesnesini düzenleyin:

- `concurrent`: Paralel istek sayısı
- `timeout`: İstek zaman aşımı (ms)
- `testMode`: Sınırlı instance ile test modu

## Gereksinimler

- Node.js 20+
- pnpm 8+
- Redis (opsiyonel, yerel önbellekleme için)

## Dosyalar

- `peertube-researcher.js`: Ana keşif scripti
- `peertube-instance-add.js`: Kayıt scripti
- `new-instances.txt`: Bulunan instance'lar listesi
- `peertube-results-*.txt`: Kayıt sonuçları (sadece artifact)

## Lisans

MIT
