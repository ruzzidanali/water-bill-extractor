import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { createCanvas, loadImage } from "canvas"; // 🆕 Added
import * as pdfjsLibRaw from "pdfjs-dist/legacy/build/pdf.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pdfjsLib = pdfjsLibRaw.default ?? pdfjsLibRaw;

// ✅ Worker path fix
if (pdfjsLib.GlobalWorkerOptions) {
  const workerPath = path
    .resolve(__dirname, "../node_modules/pdfjs-dist/legacy/build/pdf.worker.js")
    .replace(/\\/g, "/");
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;
}

// 📂 Folder setup
const billsDir = path.join(__dirname, "04 Water Bills");
const outputDir = path.join(__dirname, "output");
const debugDir = path.join(__dirname, "debug_text");
const cropsDir = path.join(debugDir, "crops");
const templatesDir = path.join(__dirname, "templates");
for (const d of [outputDir, debugDir, cropsDir, templatesDir])
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// 🧾 Design dimensions
const designWidth = 2481;
const designHeight = 3509;

/* --------------------------------------------------
   1️⃣ Region Detection (with OCR fallback for Johor)
-------------------------------------------------- */
async function detectRegionHybrid(filePath, text) {
  const t = text.toLowerCase().replace(/\s+/g, " ");

  if (/air\s*selangor/.test(t)) return "Selangor";
  if (/syarikat\s*air\s*melaka/.test(t) || /\bsamb\b/.test(t)) return "Melaka";
  if (/syarikat\s*air\s*negeri\s*sembilan/.test(t) || /\bsains\b/.test(t))
    return "Negeri-Sembilan";
  if (/syarikat\s*air\s*darul\s*aman/.test(t) || /\bsada\b/.test(t))
    return "Kedah";
  if (
    t.includes("ranhill saj") ||
    t.includes("ranhill sdn") ||
    t.includes("saj sdn") ||
    t.includes("ranhill") ||
    t.includes("saj") ||
    t.includes("johor") ||
    t.includes("darul ta'zim")
  ) {
    return "Johor";
  }

  console.log("🔎 Normal text scan failed → OCR header check for Johor...");
  const base = path.basename(filePath, ".pdf");
  const tmpHeader = path.join(debugDir, `${base}_header.png`);
  const tmpPng = await pdfToPNG(filePath);

  try {
    const meta = await sharp(tmpPng).metadata();
    const cropHeight = Math.min(400, Math.round(meta.height * 0.25));
    await sharp(tmpPng)
      .extract({ left: 0, top: 0, width: meta.width, height: cropHeight })
      .toFile(tmpHeader);

    const worker = await createWorker("eng");
    const res = await worker.recognize(tmpHeader);
    await worker.terminate();

    const ocrText = res.data.text.toLowerCase();
    if (
      ocrText.includes("ranhill") ||
      ocrText.includes("saj") ||
      ocrText.includes("johor") ||
      ocrText.includes("darul ta'zim")
    ) {
      console.log("📄 Header OCR detected Ranhill → Johor");
      return "Johor";
    }
  } catch (err) {
    console.warn("⚠️ Johor OCR fallback failed:", err.message);
  }

  return "unknown";
}

/* --------------------------------------------------
   2️⃣ Extract text from PDF (fallback to OCR)
-------------------------------------------------- */
async function extractPDFText(filePath) {
  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(i => i.str).join(" ") + "\n";
    }
    if (text.trim().length < 100) text = await runOCRText(filePath);
    return text;
  } catch {
    return await runOCRText(filePath);
  }
}

/* --------------------------------------------------
   3️⃣ OCR fallback
-------------------------------------------------- */
async function runOCRText(pdfPath) {
  const png = await pdfToPNG(pdfPath);
  const worker = await createWorker("eng");
  const result = await worker.recognize(png);
  await worker.terminate();
  return result.data.text;
}

/* --------------------------------------------------
   4️⃣ Convert PDF → Normalized PNG (2481x3509)
-------------------------------------------------- */
async function pdfToPNG(pdfPath) {
  const base = path.basename(pdfPath, ".pdf");
  const outPrefix = path.join(debugDir, base);
  const rawPngPath = `${outPrefix}_raw.png`;
  const resizedPngPath = `${outPrefix}.png`;

  try {
    execSync(
      `pdftoppm -r 300 -singlefile -png "${pdfPath.replace(/\\/g, "/")}" "${outPrefix.replace(/\\/g, "/")}_raw"`
    );

    const meta = await sharp(rawPngPath).metadata();
    console.log("🧾 Render PDF image dimensions:", meta.width, "x", meta.height);

    await sharp(rawPngPath)
      .resize(designWidth, designHeight, { fit: "fill" })
      .toFile(resizedPngPath);

    fs.unlinkSync(rawPngPath);
    return resizedPngPath;
  } catch (err) {
    console.error("❌ PDF→PNG conversion failed:", err.message);
    return "";
  }
}

/* --------------------------------------------------
   5️⃣ Cleaners
-------------------------------------------------- */
function cleanNumeric(v) {
  if (!v) return "";
  return v.replace(/rm\s*/gi, "").replace(/[^\d.,]/g, "").replace(/,+/g, "").trim();
}
function cleanAddress(text) {
  if (!text) return "";
  let lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const stopWords = ["selangor", "kuala lumpur", "putrajaya", "labuan"];
  const lowerLines = lines.map(l => l.toLowerCase());
  const idx = lowerLines.findLastIndex(l => stopWords.some(c => l.includes(c)));
  if (idx !== -1) lines = lines.slice(0, idx + 1);
  return lines.join("\n");
}
function countAddressLines(t) {
  if (!t) return 6;
  const lines = t.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  console.log(`📜 Address OCR lines (${lines.length}):`, lines);
  return lines.length;
}

/* --------------------------------------------------
   6️⃣ Detect Selangor Layout (Baharu / Baharu + Lama)
-------------------------------------------------- */
async function detectSelangorLayout(region, imagePath) {
  if (region !== "Selangor") return region;
  console.log("🔍 Detecting Selangor layout (Baharu / Baharu + Lama)...");

  const sampleBox = { left: 1600, top: 250, width: 800, height: 250 };
  const worker = await createWorker("eng");
  const tempCrop = path.join(debugDir, "layout_temp.png");
  await sharp(imagePath).extract(sampleBox).toFile(tempCrop);
  const res = await worker.recognize(tempCrop);
  await worker.terminate();

  const ocr = res.data.text.toLowerCase();
  console.log("🔎 OCR detected header:", JSON.stringify(ocr));

  if (ocr.includes("baharu") && ocr.includes("lama")) {
    console.log("📄 Detected dual account (Baharu + Lama) → Selangor2.json");
    return "Selangor2";
  }
  if (ocr.includes("baharu")) {
    console.log("📄 Detected normal account (Baharu only) → Selangor.json");
    return "Selangor";
  }
  console.log("⚠️ Defaulting → Selangor.json");
  return "Selangor";
}

/* --------------------------------------------------
   🧭 Johor Post-Processing Parser (Final Enhanced)
-------------------------------------------------- */
function parseJohorFields(r) {
  const result = {};
  // Example: Johor bills often have combined “Tunggakan dan Tarikh Section”
  const tSection = r["Tunggakan dan Tarikh Section"] || "";
  const dateMatch = tSection.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const tunggakanMatch = tSection.match(/(\d+[.,]\d{2})/);

  if (dateMatch) result["Tunggakan Tarikh"] = dateMatch[1];
  if (tunggakanMatch) result["Tunggakan"] = tunggakanMatch[1];

  // Extract tempoh bil from combined section
  const tempoh = tSection.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (tempoh) {
    result["Tempoh Bil"] = `${tempoh[1]} - ${tempoh[2]}`;
    const d1 = new Date(tempoh[1].split("/").reverse().join("-"));
    const d2 = new Date(tempoh[2].split("/").reverse().join("-"));
    result["Bilangan Hari"] = Math.abs(Math.round((d2 - d1) / 86400000)).toString();
  }

  // Caj and deposit parsing
  if (r["Jumlah Bil Semasa Section"])
    result["Jumlah Bil Semasa"] = r["Jumlah Bil Semasa Section"].match(/(\d+[.,]\d{2})/)?.[1] || "";

  result["Jumlah Caj Air Semasa"] = r["Jumlah Caj Air Semasa Section"]?.match(/(\d+[.,]\d{2})/)?.[1] || "";
  result["Deposit"] = r["Deposit"]?.match(/(\d+[.,]\d{2})/)?.[1] || "";

  // No. Meter, Penggunaan
  result["No. Meter"] = r["No Meter, Tarikh, Penggunaan(m3) Section"]?.match(/[A-Z0-9]{5,}/)?.[0] || "";
  result["Penggunaan (m3)"] = r["No Meter, Tarikh, Penggunaan(m3) Section"]?.match(/(\d+)/)?.[1] || "";

  // Tarikh (main billing date)
  result["Tarikh"] = r["Tarikh"] || "";

  return result;
}

/* --------------------------------------------------
   💧 Kedah Parser (SADA) — clean + ordered + formatted
-------------------------------------------------- */
function parseKedahFields(r, fileName) {
  const cleaned = {
    "File Name": fileName,
    Region: "Kedah",
    "No. Akaun": r["No. Akaun"] || "",
    "No. Bil": r["No. Bil"] || "",
    Tarikh: r["Tarikh"] || "",
    "No. Meter": r["No. Meter"] || "",
    "Penggunaan Semasa": r["Penggunaan Semasa"] || "",
    "Jumlah Caj Semasa": r["Jumlah Caj Semasa, Jumlah Tunggakan dan Jumlah Perlu Dibayar Section"]?.match(/(\d+[.,]\d{2})/)?.[1] || "",
    "Jumlah Tunggakan": r["Jumlah Caj Semasa, Jumlah Tunggakan dan Jumlah Perlu Dibayar Section"]?.match(/Tunggakan\s*:\s*(\d+[.,]\d{2})/)?.[1] || "",
    "Jumlah Perlu Dibayar": r["Jumlah Caj Semasa, Jumlah Tunggakan dan Jumlah Perlu Dibayar Section"]?.match(/Perlu Dibayar\s*:\s*(\d+[.,]\d{2})/)?.[1] || "",
    Cagaran: r["Cagaran"] || ""
  };
  return cleaned;
}

/* --------------------------------------------------
   💧 Negeri Sembilan Parser (SAINS) — clean + ordered + formatted
-------------------------------------------------- */
function parseNegeriSembilanFields(r) {
  const parsed = {
    "No. Akaun": r["No. Akaun"] || "",
    "No. Bil": r["No. Bil"] || "",
    Tarikh: r["Tarikh"] || "",
    "No. Meter": r["No. Meter"] || "",
    Penggunaan: r["Penggunaan"] || "",
    "Caj Semasa": r["Caj Semasa"] || "",
    Tunggakan: r["Tunggakan"] || "",
    Deposit: r["Deposit"] || "",
    "Jumlah Perlu Dibayar": r["Jumlah Perlu Dibayar"] || ""
  };
  return parsed;
}

/* --------------------------------------------------
   🧩 Standardized Output
-------------------------------------------------- */
function standardizeOutput(obj) {
  const map = {
    "No. Invois": "No_Invois",
    "No. Akaun": "No_Akaun",
    "Tarikh": "Tarikh",
    "Tempoh Bil": "Tempoh_Bil",
    "Bilangan Hari": "Bilangan_Hari",
    "No. Meter": "No_Meter",
    "Penggunaan (m3)": "Penggunaan",
    "Caj Semasa": "Caj_Semasa",
    "Jumlah Perlu Dibayar": "Jumlah_Perlu_Dibayar",
    "Tunggakan": "Tunggakan",
    "Deposit": "Deposit"
  };
  const out = {};
  for (const [k, v] of Object.entries(map)) out[v] = obj[k] || "";
  out.File_Name = obj["File Name"] || "";
  out.Region = obj["Region"] || "";
  return out;
}



/* --------------------------------------------------
   7️⃣ Process Template OCR (updated to include Johor parser)
-------------------------------------------------- */
async function processTemplateOCR(imagePath, template, fileName, region) {
  const meta = await sharp(imagePath).metadata();
  const scaleX = meta.width / designWidth;
  const scaleY = meta.height / designHeight;
  const worker = await createWorker("eng");
  const results = {};

  // 🏠 Address handling
  let addressText = "";
  if (template["Address"]) {
    const b = template["Address"];
    const s = {
      left: Math.round(b.x * scaleX),
      top: Math.round(b.y * scaleY),
      width: Math.round(b.w * scaleX),
      height: Math.round(b.h * scaleY)
    };
    const addrCrop = path.join(cropsDir, "Address.png");
    await sharp(imagePath).extract(s).toFile(addrCrop);
    const r = await worker.recognize(addrCrop);
    addressText = cleanAddress(r.data.text.trim());
    results["Address"] = addressText;
  }

  const addressLines = countAddressLines(addressText);
  const offsetY = -(6 - addressLines) * 50;

  const moveKeys = [
    "No. Meter",
    "Bilangan Hari - Start",
    "Bilangan Hari - End",
    "Baki Terdahulu",
    "Bil Semasa",
    "Jumlah Perlu Dibayar",
    "Penggunaan (m3)"
  ];

  const svgRects = [];
  for (const [key, box] of Object.entries(template)) {
    if (key === "Address") continue;
    const applyOffset = moveKeys.includes(key) ? offsetY : 0;
    const s = {
      left: Math.round(box.x * scaleX),
      top: Math.round((box.y + applyOffset) * scaleY),
      width: Math.round(box.w * scaleX),
      height: Math.round(box.h * scaleY)
    };
    svgRects.push(
      `<rect x="${s.left}" y="${s.top}" width="${s.width}" height="${s.height}" fill="none" stroke="red" stroke-width="3"/>`
    );

    const crop = path.join(cropsDir, `${key.replace(/\s+/g, "_")}.png`);
    try {
      await sharp(imagePath).extract(s).toFile(crop);
      const r = await worker.recognize(crop);
      let text = r.data.text.trim();
      if (["Bil Semasa", "Jumlah Perlu Dibayar", "Baki Terdahulu", "Cagaran", "Penggunaan (m3)"].includes(key))
        text = cleanNumeric(text);
      results[key] = text;
      console.log(`✂️ ${key}: ${results[key]}`);
    } catch {
      results[key] = "";
    }
  }

  await worker.terminate();

  // 🖍️ Draw overlay boxes using Canvas (Render-compatible)
  const baseImage = await loadImage(imagePath);
  const canvas = createCanvas(meta.width, meta.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(baseImage, 0, 0, meta.width, meta.height);
  ctx.strokeStyle = "red";
  ctx.lineWidth = 3;
  svgRects.forEach(rect => {
    const match = rect.match(/x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/);
    if (match) {
      const [, x, y, w, h] = match.map(Number);
      ctx.strokeRect(x, y, w, h);
    }
  });
  const outOverlay = imagePath.replace(".png", "_overlay.png");
  const out = fs.createWriteStream(outOverlay);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  out.on("finish", () => console.log(`🖼️ Saved debug overlay → ${outOverlay}`));

  /* -------------- Billing Date logic -------------- */
  const norm = d => {
    const m = d?.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (!m) return null;
    const [, dd, mm, yy] = m;
    const yyyy = yy.length === 2 ? "20" + yy : yy;
    return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
  };
  const start = norm(results["Bilangan Hari - End"]);
  const end = norm(results["Bilangan Hari - Start"]);
  let bilDays = "", tempohBil = "";
  if (start && end) {
    const d1 = new Date(start.split("/").reverse().join("-"));
    const d2 = new Date(end.split("/").reverse().join("-"));
    bilDays = Math.abs(Math.round((d2 - d1) / 86400000)).toString();
    tempohBil = `${start} - ${end}`;
  }
  delete results["Bilangan Hari - Start"];
  delete results["Bilangan Hari - End"];

  let final = {
    "File Name": fileName,
    Region: region,
    "Address Lines Count": addressLines,
    "Offset Applied (px)": offsetY,
    ...results,
    ...(tempohBil ? { "Tempoh Bil": tempohBil } : {}),
    ...(bilDays ? { "Bilangan Hari": bilDays } : {})
  };

  // 🧭 Apply region-specific parsing
  if (region.toLowerCase().includes("johor")) {
    const parsed = parseJohorFields(results);
    final = { ...final, ...parsed };
  } else if (region.toLowerCase().includes("kedah")) {
    const parsed = parseKedahFields(results, fileName);
    if (final["Tempoh Bil"]) parsed["Tempoh Bil"] = final["Tempoh Bil"];
    if (final["Bilangan Hari"]) parsed["Bilangan Hari"] = final["Bilangan Hari"];
    final = parsed;
  } else if (region.toLowerCase().includes("negeri")) {
    final = { ...parseNegeriSembilanFields(results), "File Name": fileName, Region: region };
  }

  // Cleanups for Kedah
  if (region.toLowerCase().includes("kedah")) {
    delete final["Jumlah Caj Semasa, Jumlah Tunggakan dan Jumlah Perlu Dibayar Section"];
    delete final["Address Lines Count"];
    delete final["Offset Applied (px)"];
  }

  // Normalize account/bill numbers
  if (final["No. Bil"])
    final["No. Bil"] = final["No. Bil"].replace(/\s+/g, "").replace(/[^A-Za-z0-9\-]/g, "");
  if (final["No. Akaun"])
    final["No. Akaun"] = final["No. Akaun"].replace(/\s+/g, "").replace(/[^A-Za-z0-9\-]/g, "");

  const standardized = standardizeOutput(final);
  const outJson = path.join(outputDir, `${path.basename(fileName, ".pdf")}_${region}.json`);
  fs.writeFileSync(outJson, JSON.stringify(standardized, null, 2));
  console.log(`✅ Standardized JSON saved → ${outJson}`);
}

/* --------------------------------------------------
   8️⃣ Main Runner
-------------------------------------------------- */
// (async () => {
//   const pdfs = fs.readdirSync(billsDir).filter(f => f.endsWith(".pdf"));
//   console.log(`📦 Found ${pdfs.length} bills in ${billsDir}\n`);

//   for (const file of pdfs) {
//     console.log(`🧾 Processing: ${file} ...`);
//     const pdfPath = path.join(billsDir, file);
//     const text = await extractPDFText(pdfPath);

//     // const debugTextPath = path.join(outputDir, `${path.basename(file, ".pdf")}_fulltext.json`);
//     // fs.writeFileSync(debugTextPath, JSON.stringify({ File: file, FullText: text }, null, 2));
//     // console.log(`🪶 Full OCR text saved → ${debugTextPath}`);

//     const region = await detectRegionHybrid(pdfPath, text);
//     if (region === "unknown") {
//       console.warn(`⚠️ Unknown region → skipping ${file}`);
//       continue;
//     }

//     const png = await pdfToPNG(pdfPath);
//     let imageToUse = png;
//     // if (region === "Johor") {
//     //   imageToUse = await makeBlackWhiteJohor(png);
//     // }

//     const regionChecked = await detectSelangorLayout(region, imageToUse);

//     const templatePath = path.join(templatesDir, `${regionChecked}.json`);
//     if (!fs.existsSync(templatePath))
//       fs.writeFileSync(templatePath, JSON.stringify({}, null, 2));

//     const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
//     await processTemplateOCR(imageToUse, template, file, regionChecked);
//     console.log(`✅ Completed ${file}\n`);
//   }

//   console.log("🎉 All water bills processed successfully!");
// })();

/* --------------------------------------------------
   🧩 Main Extractor (for API)
-------------------------------------------------- */
export async function extractWaterBill(filePath, originalName = "") {
  console.log(`🧾 Processing single file via API: ${filePath} ...`);
  const fileName = originalName || path.basename(filePath);
  const text = await extractPDFText(filePath);
  const region = await detectRegionHybrid(filePath, text);
  if (region === "unknown") return { error: "Unknown region" };

  const png = await pdfToPNG(filePath);
  const regionChecked = await detectSelangorLayout(region, png);
  const templatePath = path.join(templatesDir, `${regionChecked}.json`);
  if (!fs.existsSync(templatePath)) fs.writeFileSync(templatePath, "{}");

  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  await processTemplateOCR(png, template, fileName, regionChecked);

  const outJson = path.join(outputDir, `${path.basename(fileName, ".pdf")}_${regionChecked}.json`);
  if (fs.existsSync(outJson)) {
    const data = JSON.parse(fs.readFileSync(outJson, "utf8"));
    console.log(`✅ Extraction complete → returning standardized JSON for ${fileName}`);
    return data;
  } else {
    console.warn(`⚠️ Output JSON not found for ${fileName}`);
    return { error: "No output generated" };
  }
}

// ✅ CLI mode: only runs if executed directly (not imported by server.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const pdfs = fs.readdirSync(billsDir).filter(f => f.endsWith(".pdf"));
    console.log(`📦 Found ${pdfs.length} bills in ${billsDir}\n`);

    for (const file of pdfs) {
      console.log(`🧾 Processing: ${file} ...`);
      const pdfPath = path.join(billsDir, file);
      await extractWaterBill(pdfPath);
    }

    console.log("🎉 All water bills processed successfully!");
  })();
}
