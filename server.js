
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*" }));

app.get("/", (req, res) => res.json({ durum: "çevrimiçi", hizmet: "SenuAhell İndirici" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/download", async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "Kick video bağlantısı gerekli." });

    let videoUrl;
    try {
        videoUrl = new URL(rawUrl);
    } catch {
        return res.status(400).json({ error: "Geçersiz bağlantı." });
    }

    if (videoUrl.protocol !== "https:" || !["kick.com", "www.kick.com"].includes(videoUrl.hostname) || !/^\/senuahell\/(clips|videos)\//.test(videoUrl.pathname)) {
        return res.status(403).json({ error: "Yalnızca SenuAhell kanalının Kick klip ve yayınları indirilebilir." });
    }

    const id = crypto.randomUUID();
    const output = path.join(os.tmpdir(), `${id}.mp4`);
    const args = ["--no-warnings", "--no-playlist", "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", output, videoUrl.href];
    const process = spawn("yt-dlp", args);
    let errorText = "";
    let finished = false;

    const timeout = setTimeout(() => {
        if (!finished) process.kill("SIGKILL");
    }, 10 * 60 * 1000);

    process.stderr.on("data", data => errorText += data.toString());

    process.on("error", () => {
        finished = true;
        clearTimeout(timeout);
        res.status(500).json({ error: "yt-dlp başlatılamadı." });
    });

    process.on("close", code => {
        finished = true;
        clearTimeout(timeout);

        if (code !== 0 || !fs.existsSync(output)) {
            if (fs.existsSync(output)) fs.unlinkSync(output);
            if (!res.headersSent) res.status(502).json({ error: "Kick videosu indirilemedi veya MP4'e dönüştürülemedi.", detail: errorText.slice(-1500) });
            return;
        }

        res.download(output, "senuahell-video.mp4", err => {
            fs.unlink(output, () => {});
            if (err && !res.headersSent) res.status(500).end();
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`SenuAhell Downloader running on port ${PORT}`));
