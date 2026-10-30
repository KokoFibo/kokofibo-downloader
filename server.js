import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import JSZip from "jszip";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const OUTPUT_FOLDER = path.join(__dirname, "downloaded-images");

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

let isPuppeteerSession = false;

// Gunakan cors middleware
app.use(
  cors({
    origin: "*", // Atau 'https://downloader.kokofibo.com'
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
    ],
  }),
);

// Function untuk membersihkan folder cache
async function clearDownloadFolder() {
  try {
    await fs.rm(OUTPUT_FOLDER, { recursive: true, force: true });
    await fs.mkdir(OUTPUT_FOLDER, { recursive: true });
    console.log("🧹 Folder cache berhasil dibersihkan.");
  } catch (err) {
    console.error("⚠️ Gagal membersihkan folder:", err.message);
  }
}

// Extract URL dari Teks / Markdown Katalog
function extractUrlsFromText(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s<"'`\)\\]+)/gi;
  const matches = text.match(urlRegex) || [];
  return Array.from(new Set(matches))
    .map((url) => url.replace(/[,\.\)]+$/, ""))
    .filter((url) => !url.endsWith(".mjs") && !url.endsWith(".js"));
}

// Extract URL dari Log stdout Puppeteer
function extractUrlsFromStdout(stdout) {
  if (!stdout) return [];
  const lines = stdout.split("\n");
  const urls = [];

  for (const line of lines) {
    if (line.includes("FOUND_URL:")) {
      const cleanUrl = line.replace("FOUND_URL:", "").trim();
      if (cleanUrl) urls.push(cleanUrl);
    }
  }

  if (urls.length === 0) return extractUrlsFromText(stdout);
  return Array.from(new Set(urls));
}

// Tentukan ekstensi berdasarkan MIME Type
function getExtensionFromMime(mimeType) {
  if (!mimeType) return ".jpg";
  if (mimeType.includes("image/webp")) return ".webp";
  if (mimeType.includes("image/png")) return ".png";
  if (mimeType.includes("image/gif")) return ".gif";
  if (mimeType.includes("image/svg")) return ".svg";
  return ".jpg";
}

// 1. Endpoint API Scrape
// 1. Endpoint API Scrape
app.post("/api/scrape-links", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim())
    return res.status(400).json({ error: "Input tidak boleh kosong." });

  await clearDownloadFolder();

  const trimmedInput = url.trim();
  const isSingleUrl = /^https?:\/\/[^\s]+$/i.test(trimmedInput);

  if (!isSingleUrl) {
    // Mode Teks Katalog / Markdown (Bukan Puppeteer)
    isPuppeteerSession = false;
    const detectedUrls = extractUrlsFromText(trimmedInput);
    if (detectedUrls.length === 0) {
      return res
        .status(400)
        .json({ error: "Tidak ditemukan URL gambar di dalam teks." });
    }
    console.log(`✨ Ditemukan ${detectedUrls.length} URL dari Teks Markdown.`);
    return res.json({
      success: true,
      imageUrls: detectedUrls,
      isPuppeteer: false,
    });
  } else {
    // Mode Scrape Website (Menggunakan Puppeteer)
    isPuppeteerSession = true;
    console.log(`🌐 Meluncurkan Puppeteer untuk: ${trimmedInput}`);

    // Tambahkan timeout 60000ms (60 detik) dan maxBuffer 10MB
    exec(
      `node scraper.mjs "${trimmedInput}"`,
      { timeout: 120000, maxBuffer: 1024 * 1024 * 50 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`❌ Exec Error:`, error.message);
          if (stderr) console.error(`❌ Exec Stderr:`, stderr);
          return res
            .status(500)
            .json({ error: "Gagal melakukan scraping pada website." });
        }
        const detectedUrls = extractUrlsFromStdout(stdout);
        res.json({ success: true, imageUrls: detectedUrls, isPuppeteer: true });
      },
    );
  }
});

// Helper Pengunduh Gambar Utama (Server Side Fetch)
async function fetchImageBuffer(imgUrl, index, localFiles, requestedName) {
  // A. Jika mode Puppeteer aktif dan file lokal tersedia
  if (isPuppeteerSession && localFiles.length > 0) {
    const paddedIdx = String(index + 1).padStart(3, "0");
    const matchedLocalFile = localFiles.find((file) =>
      file.startsWith(`image_${paddedIdx}`),
    );

    if (matchedLocalFile) {
      try {
        const filePath = path.join(OUTPUT_FOLDER, matchedLocalFile);
        const buffer = await fs.readFile(filePath);
        return { buffer, filename: matchedLocalFile };
      } catch (e) {}
    }
  }

  // B. Jika Online Direct Fetch (Unsplash / Text Links)
  // Bersihkan parameter query Unsplash jika memicu error
  let cleanFetchUrl = imgUrl;
  if (imgUrl.includes("images.unsplash.com")) {
    cleanFetchUrl = imgUrl.split("?")[0]; // Ambil URL gambar murni Unsplash
  }

  const response = await fetch(cleanFetchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Gagal mengambil gambar dari URL. Status HTTP ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type");
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));

  const ext = getExtensionFromMime(contentType);
  let baseName = requestedName
    ? requestedName.replace(/\.[^/.]+$/, "")
    : `image_${index + 1}`;
  const filename = `${baseName}${ext}`;

  return { buffer, filename };
}

// 2. Endpoint Single Download
app.post("/api/download-single", async (req, res) => {
  const { url, name, index } = req.body;
  if (!url) return res.status(400).json({ error: "URL gambar wajib diisi." });

  try {
    let localFiles = [];
    try {
      localFiles = await fs.readdir(OUTPUT_FOLDER);
    } catch (e) {}

    const { buffer, filename } = await fetchImageBuffer(
      url,
      index || 0,
      localFiles,
      name,
    );

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error(`❌ Single Download Error (${url}):`, error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 3. Endpoint ZIP Download
app.post("/api/download-zip", async (req, res) => {
  const { images } = req.body;

  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Tidak ada gambar yang dipilih." });
  }

  try {
    const zip = new JSZip();
    let successCount = 0;

    let localFiles = [];
    try {
      localFiles = await fs.readdir(OUTPUT_FOLDER);
    } catch (e) {}

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const { buffer, filename } = await fetchImageBuffer(
          img.url,
          img.index ?? i,
          localFiles,
          img.name,
        );
        zip.file(filename, buffer);
        successCount++;
      } catch (err) {
        console.error(`❌ Gagal memuat ${img.url}:`, err.message);
      }
    }

    if (successCount === 0) {
      return res
        .status(500)
        .json({ error: "Seluruh gambar gagal dikemas ke berkas ZIP." });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="downloaded-images.zip"',
    );
    return res.send(zipBuffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 Kokofibo Universal AI Image Downloader aktif di http://localhost:${PORT}`,
  );
});
