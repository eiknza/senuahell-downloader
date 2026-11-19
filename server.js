
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*" }));

app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.originalUrl}`);
    next();
});

app.get("/", (req, res) => res.json({ durum: "çevrimiçi", hizmet: "SenuAhell İndirici" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/debug", (req, res) => {
    const check = spawn("yt-dlp", ["--version"]);
    let output = "";
    check.stdout.on("data", data => output += data.toString());
    check.on("error", error => res.status(500).json({ yt_dlp: "çalışmıyor", error: error.message }));
    check.on("close", code => {
        if (!res.headersSent) res.json({ yt_dlp: code === 0 ? "hazır" : "hata", version: output.trim() });
    });
});

app.get("/download", (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "Kick bağlantısı gerekli." });

    let videoUrl;
    try {
        videoUrl = new URL(rawUrl);
    } catch {
        return res.status(400).json({ error: "Geçersiz bağlantı." });
    }

    if (videoUrl.protocol !== "https:" || !["kick.com", "www.kick.com"].includes(videoUrl.hostname) || !/^\/senuahell\/(clips|videos)\//.test(videoUrl.pathname)) {
        return res.status(403).json({ error: "Yalnızca SenuAhell kanalının Kick klip ve yayınları desteklenir." });
    }

    const id = crypto.randomUUID();
    const output = path.join(os.tmpdir(), `${id}.mp4`);
    console.log(`[DOWNLOAD] Başladı: ${videoUrl.href}`);

    const process = spawn("yt-dlp", ["--no-warnings", "--no-playlist", "--newline", "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", output, videoUrl.href]);
    let errorText = "";
    let finished = false;

    const timeout = setTimeout(() => {
        if (!finished) {
            console.error("[DOWNLOAD] 10 dakika zaman aşımı.");
            process.kill("SIGKILL");
        }
    }, 10 * 60 * 1000);

    process.stdout.on("data", data => console.log(`[YT-DLP] ${data.toString().trim()}`));
    process.stderr.on("data", data => {
        errorText += data.toString();
        console.error(`[YT-DLP ERROR] ${data.toString().trim()}`);
    });

    process.on("error", error => {
        finished = true;
        clearTimeout(timeout);
        console.error("[DOWNLOAD] İşlem başlatılamadı:", error);
        if (!res.headersSent) res.status(500).json({ error: "yt-dlp başlatılamadı." });
    });

    process.on("close", code => {
        finished = true;
        clearTimeout(timeout);
        console.log(`[DOWNLOAD] İşlem bitti. Kod: ${code}`);

        if (code !== 0 || !fs.existsSync(output)) {
            if (fs.existsSync(output)) fs.unlinkSync(output);
            if (!res.headersSent) res.status(502).json({ error: "Video indirilemedi.", detail: errorText.slice(-2000) });
            return;
        }

        res.download(output, "senuahell-video.mp4", error => {
            fs.unlink(output, () => {});
            if (error) console.error("[DOWNLOAD] Dosya gönderilemedi:", error);
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`SenuAhell Downloader running on port ${PORT}`));
