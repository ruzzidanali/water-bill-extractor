import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";
import { extractWaterBill } from "./extractWaterBillsLast6.js"; // ✅ your main extractor

// 📁 Path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ⚙️ Express + Middleware
const app = express();
app.use(cors());
app.use(express.json());

// 🧾 Multer setup for PDF uploads
const upload = multer({ dest: "uploads/" });

// ✅ Make debug and output folders public (for Render free plan)
app.use("/debug_text", express.static(path.join(__dirname, "debug_text")));
app.use("/output", express.static(path.join(__dirname, "output")));

// 🌐 Health check route
app.get("/", (req, res) => {
  res.send("💧 Water Bill Extraction API is running on Render 🚀");
});

// 🧩 Main PDF extraction endpoint
app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = path.resolve(req.file.path);
    console.log(`📄 Received file: ${req.file.originalname} (${filePath})`);

    // Call the extractor
    const result = await extractWaterBill(filePath);

    // Delete temp uploaded file
    fs.unlinkSync(filePath);

    console.log(`✅ Extraction complete for ${req.file.originalname}`);
    res.json(result);
  } catch (err) {
    console.error("❌ API Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🚀 Start server
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`✅ Water Bill API running at http://localhost:${PORT}`);
  console.log("📂 Debug files available at /debug_text");
  console.log("📂 JSON outputs available at /output");
});
