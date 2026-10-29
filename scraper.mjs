import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import JSZip from "jszip";

// Konfigurasi Target & Output
const TARGET_URL = process.argv[2] || "https://unsplash.com"; // URL default jika tidak diisi
const OUTPUT_FOLDER = "./downloaded-images";
const CREATE_ZIP = true; // Set to true jika ingin output berupa file ZIP juga

/**
 * Fungsi untuk melakukan scroll otomatis hingga ke dasar halaman
 * agar gambar lazy-loading termuat sempurna.
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        // Berhenti scroll jika sudah mencapai dasar atau batas max scroll
        if (totalHeight >= scrollHeight || totalHeight > 5000) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

async function runScraper() {
  console.log(`🚀 Meluncurkan browser Puppeteer...`);
  const browser = await puppeteer.launch({
    headless: "new", // Berjalan di background
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Set User-Agent & Viewport seperti browser desktop sungguhan
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log(`🌐 Mengunjungi URL: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

    console.log(
      `📜 Melakukan auto-scroll untuk memuat gambar (lazy-loading)...`,
    );
    await autoScroll(page);

    console.log(`🔍 Mengambil seluruh URL gambar dari DOM...`);
    const imageUrls = await page.evaluate(() => {
      const urls = new Set();

      // 1. Ambil dari tag <img> (src & srcset)
      document.querySelectorAll("img").forEach((img) => {
        if (img.src && img.src.startsWith("http")) urls.add(img.src);
        if (img.dataset.src && img.dataset.src.startsWith("http"))
          urls.add(img.dataset.src);
      });

      // 2. Ambil dari CSS background-image
      document.querySelectorAll("*").forEach((el) => {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg.startsWith("url(")) {
          const cleanUrl = bg
            .replace(/^url\(['"]?/, "")
            .replace(/['"]?\)$/, "");
          if (cleanUrl.startsWith("http")) urls.add(cleanUrl);
        }
      });

      return Array.from(urls);
    });

    console.log(`✨ Ditemukan ${imageUrls.length} gambar unik!`);

    if (imageUrls.length === 0) {
      console.log("⚠️ Tidak ada gambar yang berhasil ditemukan.");
      await browser.close();
      return;
    }

    // Buat folder output lokal
    await fs.mkdir(OUTPUT_FOLDER, { recursive: true });
    const zip = CREATE_ZIP ? new JSZip() : null;

    console.log(`⬇️ Memulai proses unduh ke folder '${OUTPUT_FOLDER}'...`);

    let count = 0;
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
        // Ambil nama file asli atau generate nama urut
        const urlObj = new URL(url);
        let ext = path.extname(urlObj.pathname).split("?")[0] || ".jpg";
        if (
          ![".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(
            ext.toLowerCase(),
          )
        ) {
          ext = ".jpg";
        }
        const filename = `image_${String(i + 1).padStart(3, "0")}${ext}`;
        const filePath = path.join(OUTPUT_FOLDER, filename);

        // Fetch gambar lewat Puppeteer Page Context agar membawa Session/Cookie jika ada
        const imageBuffer = await page.evaluate(async (imgUrl) => {
          const res = await fetch(imgUrl);
          if (!res.ok) throw new Error(`HTTP error ${res.status}`);
          const buffer = await res.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        }, url);

        const uint8Array = new Uint8Array(imageBuffer);

        // Simpan ke folder lokal
        await fs.writeFile(filePath, uint8Array);

        // Masukkan ke zip jika diaktifkan
        if (zip) {
          zip.file(filename, uint8Array);
        }

        count++;
        console.log(`  [${count}/${imageUrls.length}] ✅ Saved: ${filename}`);
      } catch (err) {
        console.log(`  ❌ Gagal mengunduh gambar #${i + 1}: ${err.message}`);
      }
    }

    // Generate File ZIP jika diaktifkan
    if (CREATE_ZIP && count > 0) {
      console.log(`📦 Mengompresi file ke 'downloaded-images.zip'...`);
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      await fs.writeFile("downloaded-images.zip", zipBuffer);
      console.log(`🎉 Berhasil membuat berkas downloaded-images.zip!`);
    }

    console.log(`\n🎉 Selesai! Berhasil mengunduh ${count} gambar.`);
  } catch (err) {
    console.error(`❌ Terjadi kesalahan utama:`, err.message);
  } finally {
    await browser.close();
  }
}

runScraper();
