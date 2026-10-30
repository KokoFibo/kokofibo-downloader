import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import JSZip from "jszip";

const TARGET_URL = process.argv[2];
const OUTPUT_FOLDER = "./downloaded-images";
const CREATE_ZIP = true;

if (!targetUrl) {
  console.error("URL target tidak ditemukan.");
  process.exit(1);
}

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    });

    const page = await browser.newPage();

    // Set User Agent agar tidak diblokir situs target
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    );

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Ekstrak URL Gambar
    const imageUrls = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      return imgs
        .map((img) => img.src)
        .filter((src) => src && src.startsWith("http"));
    });

    // Cetak log khusus untuk ditangkap oleh server.js
    imageUrls.forEach((url) => {
      console.log(`FOUND_URL: ${url}`);
    });

    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error("Error Puppeteer:", error.message);
    process.exit(1);
  }
})();

async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          const scrollHeight = document.body ? document.body.scrollHeight : 0;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight || totalHeight > 6000) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });
  } catch (err) {
    // Ignore navigation errors during scroll
  }
}

async function runScraper() {
  console.log(`🚀 Meluncurkan browser Puppeteer untuk target: ${TARGET_URL}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
  });

  const page = await browser.newPage();

  // Menyamarkan Puppeteer agar terdeteksi sebagai browser Chrome sungguhan
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  await page.setViewport({ width: 1440, height: 900 });

  try {
    console.log(`🌐 Mengunjungi URL website...`);
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

    await new Promise((r) => setTimeout(r, 2000));

    console.log(`📜 Auto-scroll untuk memuat seluruh gambar...`);
    await autoScroll(page);
    await new Promise((r) => setTimeout(r, 1000));

    console.log(
      `🔍 Ekstraksi seluruh elemen gambar (termasuk path relatif)...`,
    );

    // Ekstraksi URL di dalam browser context dan konversi ke Absolute URL
    const imageUrls = await page.evaluate((baseUrl) => {
      const urls = new Set();

      function addValidUrl(rawUrl) {
        if (!rawUrl || rawUrl.startsWith("data:")) return;
        try {
          // Mengubah path relatif (e.g. /images/a.jpg) menjadi URL penuh
          const absoluteUrl = new URL(rawUrl, baseUrl).href;
          if (absoluteUrl.startsWith("http")) {
            urls.add(absoluteUrl);
          }
        } catch (e) {}
      }

      // 1. Tag <img> (src, data-src, srcset)
      document.querySelectorAll("img, source").forEach((el) => {
        addValidUrl(el.getAttribute("src"));
        addValidUrl(el.getAttribute("data-src"));
        addValidUrl(el.getAttribute("data-lazy-src"));

        const srcset =
          el.getAttribute("srcset") || el.getAttribute("data-srcset");
        if (srcset) {
          srcset.split(",").forEach((part) => {
            const clean = part.trim().split(" ")[0];
            addValidUrl(clean);
          });
        }
      });

      // 2. CSS Background Image
      document.querySelectorAll("*").forEach((el) => {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg.startsWith("url(")) {
          const cleanUrl = bg
            .replace(/^url\(['"]?/, "")
            .replace(/['"]?\)$/, "");
          addValidUrl(cleanUrl);
        }
      });

      return Array.from(urls);
    }, TARGET_URL);

    // Tampilkan log daftar URL yang diekstrak ke stdout agar ditangkap oleh server.js
    imageUrls.forEach((url) => console.log(`FOUND_URL: ${url}`));
    console.log(`✨ Ditemukan ${imageUrls.length} gambar unik!`);

    if (imageUrls.length === 0) {
      console.log("⚠️ Tidak ada gambar yang ditemukan.");
      await browser.close();
      return;
    }

    await fs.mkdir(OUTPUT_FOLDER, { recursive: true });
    const zip = CREATE_ZIP ? new JSZip() : null;

    let count = 0;
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
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

        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0",
          },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        await fs.writeFile(filePath, buffer);
        if (zip) zip.file(filename, buffer);

        count++;
      } catch (err) {
        // Log penanganan error internal
      }
    }

    if (CREATE_ZIP && count > 0) {
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      await fs.writeFile("downloaded-images.zip", zipBuffer);
    }

    console.log(`🎉 Selesai! Berhasil mengunduh ${count} gambar.`);
  } catch (err) {
    console.error(`❌ Terjadi kesalahan:`, err.message);
  } finally {
    await browser.close();
  }
}

runScraper();
