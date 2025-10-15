import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execSync } from "child_process";
import { createWorker } from "tesseract.js";
import { fileURLToPath } from "url";
import { createCanvas } from "canvas";
import pdfjsLibRaw from "pdfjs-dist/legacy/build/pdf.js"; // ✅ legacy build

// ✅ Safe single declaration for pdfjsLib and getDocument
const pdfjsLib = pdfjsLibRaw.default ?? pdfjsLibRaw;
const { getDocument } = pdfjsLib;
if (pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = null;
  pdfjsLib.disableWorker = true;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Worker path fix
// if (pdfjsLib.GlobalWorkerOptions) {
//   const workerPath = path
//     .resolve(__dirname, "../node_modules/pdfjs-dist/legacy/build/pdf.worker.js")
//     .replace(/\\/g, "/");
//   pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;
// }

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
   🖤 Helper: Create Black & White version (for Johor)
-------------------------------------------------- */
// async function makeBlackWhiteJohor(pngPath) {
//   const grayPath = pngPath.replace(".png", "_gray.png");
//   try {
//     await sharp(pngPath)
//       .grayscale()
//       .linear(1.3, -20)
//       .modulate({ brightness: 1.05, contrast: 1.2 })
//       .normalize()
//       .toFile(grayPath);
//     console.log(`🩶 Grayscale version generated for Johor → ${grayPath}`);
//   } catch (err) {
//     console.warn("⚠️ Failed to generate grayscale version:", err.message);
//   }
//   return grayPath;
// }

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
  const tmpPng = pdfToPNG(filePath);

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
  const png = pdfToPNG(pdfPath);
  const worker = await createWorker("eng");
  const result = await worker.recognize(png);
  await worker.terminate();
  return result.data.text;
}

/* --------------------------------------------------
   4️⃣ Convert PDF → Normalized PNG (2481x3509)
-------------------------------------------------- */
// function pdfToPNG(pdfPath) {
//   const base = path.basename(pdfPath, ".pdf");
//   const outPrefix = path.join(debugDir, base);
//   const pngPath = `${outPrefix}.png`;
//   try {
//     execSync(`pdftoppm -r 300 -singlefile -png "${pdfPath}" "${outPrefix}"`);
//     execSync(`magick "${pngPath}" -resize ${designWidth}x${designHeight}! "${pngPath}"`);
//   } catch (err) {
//     console.error("❌ PDF→PNG conversion failed:", err.message);
//   }
//   return pngPath;
// }

async function pdfToPNG(pdfPath) {
  const base = path.basename(pdfPath, ".pdf");
  const outPrefix = path.join(debugDir, base);
  const tmpPath = `${outPrefix}-1.png`;   // 👈 change here (was _tmp.png)
  const finalPath = `${outPrefix}.png`;

  try {
    execSync(`pdftoppm -r 300 -singlefile -png "${pdfPath}" "${outPrefix}"`);
    if (fs.existsSync(tmpPath)) {
      await sharp(tmpPath)
        .resize(designWidth, designHeight)
        .toFile(finalPath);
      fs.unlinkSync(tmpPath);
      console.log(`🖼️ Generated PNG → ${finalPath}`);
    } else {
      console.warn("⚠️ No PNG generated by pdftoppm, skipping resize");
    }
  } catch (err) {
    console.error("❌ PDF→PNG conversion failed:", err.message);
  }

  return finalPath;
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
function parseJohorFields(results) {
  const out = {};

  // 🧾 Deposit
  const depositRaw = results["Deposit"];
  if (depositRaw) {
    const match = depositRaw.match(/(\d+(?:[.,]\d{1,2})?)/);
    out["Deposit"] = match ? match[1].replace(",", ".") : "0.00";
  } else {
    out["Deposit"] = "0.00";
  }

  // 🧾 Tunggakan Section (handle stamps, dates, values)
  const tunggakanRaw = results["Tunggakan dan Tarikh Section"];
  if (tunggakanRaw) {
    // Match the numeric value at the end, ignoring stamp text like PVU3208/2506216
    const tunggakanMatch = tunggakanRaw.match(
      /TUNGGAKAN(?:\s+\d{2}\/\d{2}\/\d{2,4})?(?:\s+[A-Z0-9\/]+)?\s+([0-9]+(?:[.,][0-9]{1,2})?)/i
    );
    out["Tunggakan"] = tunggakanMatch
      ? tunggakanMatch[1].replace(",", ".")
      : "0.00";

    // Extract Tarikh (e.g. from "JUMLAH BIL SEMASA 15/07/2025")
    const dateMatch = tunggakanRaw.match(
      /JUMLAH\s+BIL\s+SEMASA\s+(\d{2})[\/\-]?(\d{2})[\/\-]?(\d{4})/i
    );
    if (dateMatch)
      out["Tarikh"] = `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`;
  } else {
    out["Tunggakan"] = "0.00";
  }

  // 🧾 Jumlah Bil Semasa
  const jumlahBilRaw = results["Jumlah Bil Semasa Section"];
  if (jumlahBilRaw) {
    const match = jumlahBilRaw.match(
      /JUMLAH\s+BIL\s+SEMASA[^0-9]*([0-9]+(?:[.,][0-9]{1,2})?)/i
    );
    out["Jumlah Bil Semasa"] = match ? match[1].replace(",", ".") : "";
  }

  // 🧾 Normalize No. Bil — remove all spaces and stray non-alphanumerics
  out["No. Bil"] = (results["No. Bil"] || "")
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9\-]/g, "");

  // 🧾 Normalize No. Akaun — remove extra spaces but keep dash
  out["No. Akaun"] = (results["No. Akaun"] || "")
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9\-]/g, "");


  // 🧾 Meter / Penggunaan / Tarikh Start-End
  const meterRaw = results["No Meter, Tarikh, Penggunaan(m3) Section"];
  if (meterRaw) {
    // Extract meter number (remove spaces in between)
    const meterMatch = meterRaw.match(/(SAJ[0-9A-Z\s]+)/i);
    out["No. Meter"] = meterMatch
      ? meterMatch[1].replace(/\s+/g, "")
      : "";

    // Extract correct Penggunaan (last number on same line as meter)
    const meterLine = meterRaw.split("\n").find(l => l.includes("SAJ"));
    const usageMatch = meterLine?.match(/(\d{1,4}\.\d{1,2})\s*$/);
    out["Penggunaan (m3)"] = usageMatch
      ? usageMatch[1].replace(",", ".")
      : "";

    // Extract start/end dates
    const dateMatches = meterRaw.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/g);
    if (dateMatches && dateMatches.length >= 2) {
      out["Bilangan Hari - End"] = dateMatches[0];
      out["Bilangan Hari - Start"] = dateMatches[1];
      out["Tempoh Bil"] = `${out["Bilangan Hari - Start"]} - ${out["Bilangan Hari - End"]}`;
      const d1 = new Date(out["Bilangan Hari - Start"].split("/").reverse().join("-"));
      const d2 = new Date(out["Bilangan Hari - End"].split("/").reverse().join("-"));
      out["Bilangan Hari"] = Math.abs(Math.round((d2 - d1) / 86400000)).toString();
    }
  }

  // 🧾 Jumlah Caj Air Semasa
  const cajRaw = results["Jumlah Caj Air Semasa Section"];
  if (cajRaw) {
    const match = cajRaw.match(
      /JUMLAH\s+CAJ\s+AIR\s+SEMASA[^0-9]*([0-9]+(?:[.,][0-9]{1,2})?)/i
    );
    out["Jumlah Caj Air Semasa"] = match
      ? match[1].replace(",", ".")
      : "";
  }

  // If no value found, fallback to Jumlah Bil Semasa
  if (!out["Jumlah Caj Air Semasa"])
    out["Jumlah Caj Air Semasa"] = out["Jumlah Bil Semasa"] || "0.00";

  return out;
}

/* --------------------------------------------------
   💧 Kedah Parser (SADA) — clean + ordered + formatted
-------------------------------------------------- */
function parseKedahFields(results, fileName) {
  const section =
    results[
    "Jumlah Caj Semasa, Jumlah Tunggakan dan Jumlah Perlu Dibayar Section"
    ] || "";

  // 🧾 Helper: extract numeric RM values
  const getValue = (label) => {
    const regex = new RegExp(
      label + "\\s*:\\s*RM\\s*([0-9]+(?:[.,][0-9]{1,2})?)",
      "i"
    );
    const match = section.match(regex);
    return match ? match[1].replace(",", ".") : "0.00";
  };

  // 🧾 Build clean structured output in your desired order
  return {
    "File Name": fileName,
    "Region": "Kedah",

    // ---- Ordered fields ----
    "Nombor Akaun": results["No. Akaun"] || "",
    "No. Invois": results["No. Bil"] || "",
    "Tarikh": results["Tarikh"] || "",
    "Tempoh Bil": results["Tempoh Bil"] || "",
    "Nombor Meter": results["No. Meter"] || "",
    "Penggunaan Semasa": results["Penggunaan Semasa"] || "",
    "Jumlah Caj Semasa": getValue("JUMLAH CAJ SEMASA"),
    "Jumlah Tunggakan": getValue("JUMLAH TUNGGAKAN"),
    "Jumlah Perlu Dibayar": getValue("JUMLAH PERLU DIBAYAR"),
    "Cagaran": results["Cagaran"] || "0.00"
  };
}

/* --------------------------------------------------
   💧 Negeri Sembilan Parser (SAINS) — clean + ordered + formatted
-------------------------------------------------- */
function parseNegeriSembilanFields(results) {
  const out = {};

  // 🧾 Basic fields
  out["No. Akaun"] = results["No. Akaun"] || "";
  out["No. Invois"] = results["No. Bil"] || "";

  // 🗓️ Normalize Tarikh (e.g. 09-08-2025 → 09/08/2025)
  if (results["Tarikh"]) {
    const norm = results["Tarikh"].replace(/-/g, "/").trim();
    out["Tarikh"] = norm;
  } else {
    out["Tarikh"] = "";
  }

  // 🧮 Extract tempoh bil + bilangan hari from "Bilangan Hari Section"
  const section = results["Bilangan Hari Section"] || "";
  const dateMatches = section.match(/(\d{2})[-\/](\d{2})[-\/](\d{4}).*?(\d{2})[-\/](\d{2})[-\/](\d{4})/);
  if (dateMatches) {
    const start = `${dateMatches[1]}/${dateMatches[2]}/${dateMatches[3]}`;
    const end = `${dateMatches[4]}/${dateMatches[5]}/${dateMatches[6]}`;
    const d1 = new Date(`${dateMatches[3]}-${dateMatches[2]}-${dateMatches[1]}`);
    const d2 = new Date(`${dateMatches[6]}-${dateMatches[5]}-${dateMatches[4]}`);
    const days = Math.abs(Math.round((d2 - d1) / 86400000));
    out["Tempoh Bil"] = `${start} - ${end}`;
    out["Bilangan Hari"] = days.toString();
  } else {
    out["Tempoh Bil"] = "";
    out["Bilangan Hari"] = "";
  }

  // 🔢 Clean Penggunaan
  if (results["Penggunaan"]) {
    const match = results["Penggunaan"].match(/(\d+(?:[.,]\d+)?)/);
    out["Penggunaan"] = match ? match[1].replace(",", ".") : "0";
  } else {
    out["Penggunaan"] = "0";
  }

  // 💰 Clean Deposit (remove RM)
  if (results["Deposit"]) {
    const match = results["Deposit"].match(/([0-9]+(?:[.,][0-9]{1,2})?)/);
    out["Deposit"] = match ? match[1].replace(",", ".") : "0.00";
  } else {
    out["Deposit"] = "0.00";
  }

  // 💧 Remaining fields
  out["No. Meter"] = results["No. Meter"] || "";
  out["Caj Semasa"] = results["Caj Semasa"] || "0.00";
  out["Tunggakan"] = results["Tunggakan"] || "0.00";
  out["Jumlah Perlu Dibayar"] = results["Jumlah Perlu Dibayar"] || "0.00";

  return out;
}

function standardizeOutput(data) {
  // helper to safely get a numeric string with two decimals
  const cleanNum = v => (v ? v.toString().replace(/[^\d.,-]/g, "").replace(",", ".") : "0.00");

  return {
    File_Name: data["File Name"] || data["File_Name"] || "",
    Region: data["Region"] || "",
    No_Invois:
      data["No. Invois"] ||
      data["No. Bil"] ||
      data["No_Invois"] ||
      data["No_Bil"] ||
      "",
    No_Akaun:
      data["No. Akaun"] ||
      data["Nombor Akaun"] ||
      data["Nombor_Akaun"] ||
      "",
    Tarikh: (data["Tarikh"] || "").replace(/-/g, "/").trim(),
    Tempoh_Bil:
      data["Tempoh Bil"] ||
      data["Tempoh_Bil"] ||
      "",
    Bilangan_Hari:
      data["Bilangan Hari"] ||
      data["Bilangan_Hari"] ||
      "",
    No_Meter:
      data["No. Meter"] ||
      data["Nombor Meter"] ||
      data["Nombor_Meter"] ||
      "",
    Penggunaan:
      data["Penggunaan"] ||
      data["Penggunaan (m3)"] ||
      data["Penggunaan Semasa"] ||
      "0",
    Caj_Semasa:
      data["Caj Semasa"] ||
      data["Jumlah Bil Semasa"] ||
      data["Jumlah Caj Semasa"] ||
      data["Jumlah Caj Air Semasa"] ||
      cleanNum(data["Bil Semasa"]),
    Tunggakan:
      data["Tunggakan"] ||
      data["Jumlah Tunggakan"] ||
      "0.00",
    Jumlah_Perlu_Dibayar:
      data["Jumlah Perlu Dibayar"] ||
      data["Jumlah_Perlu_Dibayar"] ||
      "0.00",
    Deposit:
      data["Deposit"] ||
      data["Cagaran"] ||
      "0.00"
  };
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
      if (
        ["Bil Semasa", "Jumlah Perlu Dibayar", "Baki Terdahulu", "Cagaran", "Penggunaan (m3)"].includes(key)
      )
        text = cleanNumeric(text);
      results[key] = text;
      console.log(`✂️ ${key}: ${results[key]}`);
    } catch (e) {
      results[key] = "";
    }
  }

  await worker.terminate();

  const overlaySvg = `<svg width="${meta.width}" height="${meta.height}">${svgRects.join(
    "\n"
  )}</svg>`;
  await sharp(imagePath)
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .toFile(imagePath.replace(".png", "_overlay.png"));

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

  // 🧭 Apply Johor-specific parsing
  if (region.toLowerCase().includes("johor")) {
    const parsed = parseJohorFields(results);
    final = {
      "File Name": fileName,
      Region: region,
      "No. Akaun": results["No. Akaun"] || "",
      "No. Bil": results["No. Bil"] || "",
      ...(parsed["Tarikh"] ? { Tarikh: parsed["Tarikh"] } : {}),
      ...(parsed["Tunggakan Tarikh"] ? { "Tunggakan Tarikh": parsed["Tunggakan Tarikh"] } : {}),
      ...(parsed["Tunggakan"] ? { Tunggakan: parsed["Tunggakan"] } : {}),
      ...(parsed["Tempoh Bil"] ? { "Tempoh Bil": parsed["Tempoh Bil"] } : {}),
      ...(parsed["Bilangan Hari"] ? { "Bilangan Hari": parsed["Bilangan Hari"] } : {}),
      ...(parsed["No. Meter"] ? { "No. Meter": parsed["No. Meter"] } : {}),
      ...(parsed["Penggunaan (m3)"] ? { "Penggunaan (m3)": parsed["Penggunaan (m3)"] } : {}),
      ...(parsed["Jumlah Bil Semasa"] ? { "Jumlah Bil Semasa": parsed["Jumlah Bil Semasa"] } : {}),
      ...(parsed["Deposit"] ? { Deposit: parsed["Deposit"] } : {}),
      ...(parsed["Jumlah Caj Air Semasa"] ? { "Jumlah Caj Air Semasa": parsed["Jumlah Caj Air Semasa"] } : {})
    };
  } else if (region.toLowerCase().includes("kedah")) {
    const parsed = parseKedahFields(results, fileName);


    // Preserve Tempoh Bil and Bilangan Hari from earlier detection
    if (final["Tempoh Bil"]) parsed["Tempoh Bil"] = final["Tempoh Bil"];
    if (final["Bilangan Hari"]) parsed["Bilangan Hari"] = final["Bilangan Hari"];

    // Merge the cleaned and ordered Kedah fields
    final = parsed;
  } else if (region.toLowerCase().includes("negeri")) {
    final = {
      ...parseNegeriSembilanFields(results),
      "File Name": fileName,
      "Region": region
    };
  }

  if (region.toLowerCase().includes("kedah")) {
    delete final["Jumlah Caj Semasa, Jumlah Tunggakan dan Jumlah Perlu Dibayar Section"];
    delete final["Address Lines Count"];
    delete final["Offset Applied (px)"];
    delete final["No. Bil"];
    delete final["No. Akaun"];
    delete final["No. Meter"];
    delete final["Penggunaan Semasa"];
  }


  const outJson = path.join(outputDir, `${path.basename(fileName, ".pdf")}_${region}.json`);
  // 🧹 Normalize No. Akaun and No. Bil globally (remove spaces and stray chars)
  if (final["No. Bil"]) {
    final["No. Bil"] = final["No. Bil"].replace(/\s+/g, "").replace(/[^A-Za-z0-9\-]/g, "");
  }
  if (final["No. Akaun"]) {
    final["No. Akaun"] = final["No. Akaun"].replace(/\s+/g, "").replace(/[^A-Za-z0-9\-]/g, "");
  }

  const standardized = standardizeOutput(final);
  // const outJson = path.join(outputDir, `${path.basename(fileName, ".pdf")}_${region}_STANDARD.json`);
  fs.writeFileSync(outJson, JSON.stringify(standardized, null, 2));
  console.log(`✅ Standardized JSON saved → ${outJson}`);


  // fs.writeFileSync(outJson, JSON.stringify(final, null, 2));
  // console.log(`🧾 JSON saved → ${outJson}`);

  // const debugBoxesPath = path.join(outputDir, `${path.basename(fileName, ".pdf")}_boxes.json`);
  // fs.writeFileSync(debugBoxesPath, JSON.stringify(results, null, 2));
  // console.log(`📦 Box OCR text saved → ${debugBoxesPath}`);
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

//     const png = pdfToPNG(pdfPath);
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
   8️⃣ Main Runner (supports both direct run and API import)
-------------------------------------------------- */
export async function extractWaterBill(filePath, originalName = "") {
  console.log(`🧾 Processing single file via API: ${filePath} ...`);
  const fileName = originalName || path.basename(filePath);
  const text = await extractPDFText(filePath);

  const region = await detectRegionHybrid(filePath, text);
  if (region === "unknown") {
    console.warn(`⚠️ Unknown region → skipping ${filePath}`);
    return { error: "Unknown region" };
  }

  // ✅ ensure await for Promise
  const png = await pdfToPNG(filePath);
  const regionChecked = await detectSelangorLayout(region, png);

  const templatePath = path.join(templatesDir, `${regionChecked}.json`);
  if (!fs.existsSync(templatePath))
    fs.writeFileSync(templatePath, JSON.stringify({}, null, 2));

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

/* --------------------------------------------------
   CLI Mode — Only runs when executed directly
-------------------------------------------------- */
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
