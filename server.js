import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { extractWaterBill } from "./extractWaterBillsLast6.js"; // ✅ updated

const app = express();
const upload = multer({ dest: "uploads/" });

app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = path.resolve(req.file.path);
    console.log(`📄 Received file: ${req.file.originalname} (${filePath})`);

    const result = await extractWaterBill(filePath, req.file.originalname);

    // remove temp file after extraction
    fs.unlinkSync(filePath);

    res.json(result);
  } catch (err) {
    console.error("❌ API Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("💧 Water Bill Extraction API v6 is running 🚀"));

app.listen(5008, () =>
  console.log("✅ Water Bill API running at http://localhost:5008")
);
