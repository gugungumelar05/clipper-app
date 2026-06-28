import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "output");

[UPLOAD_DIR, OUTPUT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
app.use(cors());
app.use(express.json());
app.use("/output", express.static(OUTPUT_DIR));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Multer setup for video upload ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB max
  fileFilter: (req, file, cb) => {
    const allowed = [".mp4", ".mov", ".mkv", ".avi", ".webm"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("Format video tidak didukung"));
  },
});

// ---------- Helper: get video metadata (duration, resolution) ----------
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find((s) => s.codec_type === "video");
      resolve({
        duration: metadata.format.duration,
        width: videoStream?.width,
        height: videoStream?.height,
      });
    });
  });
}

// ---------- Routes ----------

// Upload video, return file id + metadata
app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Tidak ada file yang diupload" });
    const info = await getVideoInfo(req.file.path);
    res.json({
      fileId: req.file.filename,
      originalName: req.file.originalname,
      ...info,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Gagal membaca video: " + err.message });
  }
});

// Create a clip: cut by start/end, optional vertical crop, optional caption text
app.post("/api/clip", async (req, res) => {
  try {
    const {
      fileId,
      startTime, // seconds
      endTime, // seconds
      vertical, // boolean: crop to 9:16
      caption, // string or null
      captionPosition = "bottom", // "top" | "bottom" | "center"
    } = req.body;

    if (!fileId || startTime === undefined || endTime === undefined) {
      return res.status(400).json({ error: "fileId, startTime, dan endTime wajib diisi" });
    }

    const inputPath = path.join(UPLOAD_DIR, fileId);
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "File tidak ditemukan, mungkin sudah dihapus dari server" });
    }

    const duration = Number(endTime) - Number(startTime);
    if (duration <= 0) {
      return res.status(400).json({ error: "endTime harus lebih besar dari startTime" });
    }

    const outputName = `clip-${uuidv4()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    let command = ffmpeg(inputPath)
      .setStartTime(Number(startTime))
      .setDuration(duration);

    // Build video filters
    const filters = [];

    if (vertical) {
      // Crop/scale to 1080x1920 (9:16), center-cropped, blurred background fill
      filters.push(
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg]",
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]",
        "[bg]gblur=sigma=20[bgblur]",
        "[bgblur][fg]overlay=(W-w)/2:(H-h)/2[merged]"
      );
    }

    if (caption && caption.trim().length > 0) {
      const safeText = caption.replace(/'/g, "\\'").replace(/:/g, "\\:");
      const yExpr =
        captionPosition === "top" ? "h*0.08" : captionPosition === "center" ? "(h-text_h)/2" : "h*0.82";
      const drawTextFilter = `drawtext=text='${safeText}':fontsize=48:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${yExpr}`;

      if (vertical) {
        filters.push(`[merged]${drawTextFilter}[final]`);
      } else {
        filters.push(`[0:v]${drawTextFilter}[final]`);
      }
    }

    if (filters.length > 0) {
      command = command.complexFilter(filters);
      const lastFilter = filters[filters.length - 1];
      const outputLabelMatch = lastFilter.match(/\[(\w+)\]$/);
      const outputLabel = outputLabelMatch ? outputLabelMatch[1] : null;
      if (outputLabel) {
        command = command.outputOptions(["-map", `[${outputLabel}]`, "-map", "0:a?"]);
      }
    }

    command
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-preset", "fast", "-crf", "23"])
      .on("start", (cmd) => console.log("FFmpeg command:", cmd))
      .on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        if (!res.headersSent) res.status(500).json({ error: "Gagal memproses video: " + err.message });
      })
      .on("end", () => {
        if (!res.headersSent) {
          res.json({
            success: true,
            clipUrl: `/output/${outputName}`,
            fileName: outputName,
          });
        }
      })
      .save(outputPath);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Cleanup endpoint: delete an uploaded source file once done
app.delete("/api/upload/:fileId", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.fileId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return res.json({ deleted: true });
  }
  res.status(404).json({ deleted: false });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Clipper server running on port ${PORT}`));
