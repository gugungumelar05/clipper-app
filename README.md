# Clipper — Tool Potong Video Jadi Klip

Tool sederhana buat: upload video panjang → potong jadi klip pendek → crop otomatis ke rasio vertikal (9:16) buat TikTok/Reels/Shorts → tambah caption → download.

## Struktur folder
```
clipper-app/
  server/
    index.js          <- backend (Express + ffmpeg)
    package.json
    public/
      index.html       <- frontend (1 file, HTML+CSS+JS)
    uploads/           <- video asli yang diupload (sementara)
    output/            <- hasil klip
    nixpacks.toml       <- biar ffmpeg keinstall otomatis di Railway
```

## Jalankan di laptop sendiri (lokal)
1. Pastikan sudah install **Node.js** (v18+) dan **ffmpeg**.
   - Cek ffmpeg: buka terminal, ketik `ffmpeg -version`. Kalau belum ada:
     - Windows: download dari https://ffmpeg.org/download.html, lalu tambahkan ke PATH
     - Mac: `brew install ffmpeg`
     - Linux: `sudo apt install ffmpeg`
2. Masuk ke folder `server`:
   ```
   cd clipper-app/server
   npm install
   npm start
   ```
3. Buka browser ke `http://localhost:3001`

Catatan: kalau laptop dimatikan / terminal ditutup, server berhenti. Ini normal — bukan tanda error.

## Deploy gratis (biar bisa diakses dari HP juga, gak cuma laptop)

### Opsi A — Railway (disarankan, paling gampang buat app yang butuh ffmpeg)
1. Buat akun di https://railway.app (bisa login pakai GitHub)
2. Upload folder `clipper-app/server` ini ke GitHub repo baru (boleh private)
3. Di Railway: **New Project → Deploy from GitHub repo** → pilih repo kamu
4. Railway otomatis baca `nixpacks.toml` dan install ffmpeg + Node
5. Set environment variable `PORT` (biasanya otomatis), tunggu build selesai
6. Railway kasih URL publik (misal `xxxx.up.railway.app`) — itu link web kamu

Railway ada **free trial credit**, setelah itu kena biaya kecil per jam aktif (biasanya beberapa dolar/bulan kalau dipakai wajar). Cocok buat kebutuhanmu: gratis dulu pas trial, lanjut bayar murah kalau dipakai terus.

### Opsi B — Render
1. Buat akun di https://render.com
2. **New → Web Service** → connect ke GitHub repo
3. Root directory: `server`
4. Build command: `npm install`
5. Start command: `npm start`
6. Render free tier: web service akan **sleep setelah 15 menit idle**, nanti nyala lagi otomatis pas diakses (delay sekitar 30-50 detik pertama kali). Render juga generally tidak menjamin ffmpeg ada di environment gratis — kalau gagal, pindah ke Railway.

## Cara pakai
1. Buka web-nya
2. Upload video (drag atau klik)
3. Atur waktu mulai & selesai klip (dalam detik)
4. Nyalakan toggle "Crop vertikal" kalau mau format TikTok/Shorts/Reels
5. (Opsional) isi caption + posisi caption
6. Klik "Potong klip ini" → tunggu proses → download hasilnya

## Yang belum ada (rencana revisi selanjutnya)
- Auto-upload langsung ke TikTok/YouTube/Instagram/Facebook (butuh daftar API masing-masing platform dulu)
- Auto-deteksi bagian video yang "menarik" (highlight detection)
- Chat AI terintegrasi di dalam web
- Riwayat klip yang sudah dibuat (saat ini disimpan sementara di server, sebaiknya didownload segera setelah jadi)

## Catatan keamanan
- Web ini tidak punya sistem login — siapa pun yang tahu URL-nya bisa upload & lihat hasil klip orang lain kalau tahu nama filenya. Karena ini buat dipakai sendiri dulu, itu oke. Tapi kalau nanti mau dibagi ke tim atau dipakai publik, perlu ditambahkan autentikasi (revisi selanjutnya).
- File upload dan output disimpan di server — sebaiknya dihapus berkala biar tidak penuh storage.
