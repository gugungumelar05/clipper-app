import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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

// ---------- yt-dlp self-update on boot ----------
// Nix's yt-dlp package can lag behind YouTube's frequent changes, causing
// silent-looking failures (403 / "Sign in to confirm you're not a bot" /
// nsig extraction failed). Updating to the latest release on startup fixes
// most of these without needing to touch nixpacks.toml again.
// Railway's Railpack builder doesn't persist files written to system paths
// like /usr/local/bin between the build and runtime image layers. Files
// inside the project directory (downloaded during the build command) DO
// persist, so we look for the yt-dlp binary there first, falling back to
// the system PATH in case it's installed some other way (e.g. Nixpacks).
const LOCAL_YTDLP_PATH = path.join(__dirname, "yt-dlp");

function resolveYtDlpBinary() {
  if (fs.existsSync(LOCAL_YTDLP_PATH)) return LOCAL_YTDLP_PATH;
  return "yt-dlp"; // fall back to system PATH
}

let ytDlpReady = false;
let ytDlpVersionInfo = "belum dicek";
let ytDlpBin = "yt-dlp";

async function ensureYtDlpUpToDate() {
  ytDlpBin = resolveYtDlpBinary();
  console.log("Mencoba pakai yt-dlp dari:", ytDlpBin);

  try {
    const { stdout: beforeVersion } = await execAsync(`"${ytDlpBin}" --version`);
    console.log("yt-dlp version (sebelum update):", beforeVersion.trim());

    // -U updates yt-dlp itself to the latest release if installed via pip/binary.
    // This can fail silently on some package managers (e.g. Nix-managed binaries
    // that are read-only) - that's fine, we just log it and continue.
    try {
      const { stdout: updateOut } = await execAsync(`"${ytDlpBin}" -U`, { timeout: 60 * 1000 });
      console.log("yt-dlp self-update:", updateOut.trim());
    } catch (updateErr) {
      console.warn(
        "yt-dlp -U gagal (mungkin binary read-only), lanjut pakai versi terpasang:",
        updateErr.message
      );
    }

    const { stdout: afterVersion } = await execAsync(`"${ytDlpBin}" --version`);
    ytDlpVersionInfo = afterVersion.trim();
    ytDlpReady = true;
    console.log("yt-dlp version (siap dipakai):", ytDlpVersionInfo, "| path:", ytDlpBin);
  } catch (err) {
    ytDlpReady = false;
    ytDlpVersionInfo = "TIDAK DITEMUKAN (path: " + ytDlpBin + "): " + err.message;
    console.error(
      "yt-dlp tidak ditemukan / gagal dijalankan saat startup. Endpoint /api/download-from-url tidak akan berfungsi.",
      err.message
    );
  }
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

// Download video from a URL (YouTube, etc.) using yt-dlp, then return it like a normal upload
app.post("/api/download-from-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "URL wajib diisi" });
    }

    // Basic safety: only allow http(s) URLs
    if (!/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: "URL tidak valid" });
    }

    if (!ytDlpReady) {
      return res.status(503).json({
        error:
          "yt-dlp tidak tersedia di server ini (gagal saat startup). Cek log server / nixpacks.toml. Detail: " +
          ytDlpVersionInfo,
      });
    }

    const fileId = `${uuidv4()}.mp4`;
    const outputPath = path.join(UPLOAD_DIR, fileId);

    // yt-dlp downloads the video, merges best video+audio, outputs as mp4.
    // --extractor-args tries the android & web clients explicitly, which
    // works around several of YouTube's 2026 bot-detection / 403 issues.
    // --no-check-certificates and a desktop user-agent reduce false-positive blocks.
    const safeUrl = url.trim().replace(/"/g, "");
    const cmd = [
      `"${ytDlpBin}"`,
      `-f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best"`,
      `--merge-output-format mp4`,
      `--extractor-args "youtube:player_client=android,web"`,
      `--no-playlist`,
      `--retries 3`,
      `-o "${outputPath}"`,
      `"${safeUrl}"`,
    ].join(" ");

    console.log("Running yt-dlp:", cmd);

    let stderrOutput = "";
    try {
      const { stderr } = await execAsync(cmd, {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 5 * 60 * 1000,
      });
      stderrOutput = stderr || "";
    } catch (execErr) {
      // exec throws on non-zero exit code; the real yt-dlp error is usually in stderr.
      stderrOutput = execErr.stderr || execErr.message || "";
      throw new Error(stderrOutput || execErr.message);
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({
        error:
          "Download gagal, file tidak ditemukan setelah proses. Output yt-dlp: " +
          (stderrOutput || "(tidak ada output)").slice(0, 300),
      });
    }

    const info = await getVideoInfo(outputPath);
    res.json({
      fileId,
      originalName: safeUrl,
      ...info,
    });
  } catch (err) {
    console.error("yt-dlp error:", err.message);

    // Translate the most common yt-dlp failure signatures into messages
    // that actually tell the user (or you) what's going on, instead of a
    // generic "gagal mengunduh" every time.
    let friendlyHint = "";
    const msg = err.message || "";
    if (/command not found|ENOENT/i.test(msg)) {
      friendlyHint = " (yt-dlp tidak terinstall di server — cek nixpacks.toml)";
    } else if (/sign in to confirm|not a bot/i.test(msg)) {
      friendlyHint = " (YouTube minta verifikasi bot — coba video lain atau pakai cookies)";
    } else if (/403|forbidden/i.test(msg)) {
      friendlyHint = " (YouTube menolak akses dari server ini — bisa jadi IP server dibatasi)";
    } else if (/private|unavailable|removed/i.test(msg)) {
      friendlyHint = " (video private/tidak tersedia/dihapus)";
    }

    res.status(500).json({
      error:
        "Gagal mengunduh video dari link ini." +
        friendlyHint +
        " Detail: " +
        msg.slice(0, 300),
    });
  }
});

// Stream an uploaded/downloaded source file for preview in the <video> tag
app.get("/api/preview/:fileId", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).send("File tidak ditemukan");
  res.sendFile(filePath);
});

// Health check - now also reports yt-dlp status, useful for quick diagnosis
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", ytDlpReady, ytDlpVersionInfo, ytDlpBin })
);

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
app.listen(PORT, async () => {
  console.log(`Clipper server running on port ${PORT}`);
  await ensureYtDlpUpToDate();
});
