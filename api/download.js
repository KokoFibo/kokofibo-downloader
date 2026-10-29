import JSZip from "jszip";

export default async function handler(req, res) {
  // Hanya menerima method POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { urls } = req.body; // Menerima array URL gambar

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res
      .status(400)
      .json({ error: 'Properti "urls" wajib diisi array URL' });
  }

  try {
    const zip = new JSZip();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const response = await fetch(url);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const filename = `image_${i + 1}.jpg`;
        zip.file(filename, arrayBuffer);
      }
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    // Set header agar browser otomatis mendownload berkas zip
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=downloaded-images.zip",
    );
    return res.status(200).send(zipBuffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
