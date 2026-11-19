const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const jobs = new Map();
const MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(20, Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "5", 10) || 5));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => { console.log(`[REQUEST] ${req.method} ${req.originalUrl}`); next(); });

app.get("/", (req, res) => res.json({ durum: "çevrimiçi", hizmet: "SenuAhell İndirici", sürüm: 3, maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS }));
app.get("/health", (req, res) => res.json({ status: "ok", version: 3, maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS }));

function validKickUrl(raw) {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && ["kick.com", "www.kick.com"].includes(u.hostname) && (/^\/senuahell\/(clips|videos)\//.test(u.pathname) || /^\/video\/[0-9a-f-]{36}$/i.test(u.pathname));
    } catch { return false; }
}

app.post("/download", (req, res) => {
    const rawUrl = req.body && req.body.url;
    const rawTitle = req.body && typeof req.body.title === "string" ? req.body.title : "Kick-klibi";
    const safeTitle = rawTitle.normalize("NFKC").replace(/[\\/:*?"<>|\x00-\x1F]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 140) || "Kick-klibi";
    if (!rawUrl) return res.status(400).json({ error: "Kick bağlantısı gerekli." });
    if (!validKickUrl(rawUrl)) return res.status(403).json({ error: "Yalnızca SenuAhell kanalının Kick klip ve yayınları desteklenir." });
    if ([...jobs.values()].filter(job => job.status === "processing").length >= MAX_CONCURRENT_DOWNLOADS) return res.status(429).json({ error: `Şu anda en fazla ${MAX_CONCURRENT_DOWNLOADS} indirme aynı anda hazırlanabilir. Biraz sonra tekrar dene.` });

    const id = crypto.randomUUID();
    const output = path.join(os.tmpdir(), `${id}.mp4`);
    const job = { status: "processing", progress: 0, output, filename: `${safeTitle}.mp4`, createdAt: Date.now(), error: null, child: null, cancelled: false };
    jobs.set(id, job);
    const child = spawn("yt-dlp", ["--no-warnings", "--no-playlist", "--newline", "--progress", "--progress-template", "download:__PROGRESS__%(progress._percent)s", "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", output, rawUrl], { detached: process.platform !== "win32" });
    job.child = child;
    let errorText = "";
    let buffer = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);

    function readProgress(data) {
        const text = data.toString();
        buffer = (buffer + text).slice(-10000);
        const matches = [...buffer.matchAll(/(?:__PROGRESS__|\[download\])\s*(\d+(?:\.\d+)?)%/g)];
        if (matches.length) job.progress = Math.max(job.progress, Math.min(99, Math.floor(Number(matches[matches.length - 1][1]))));
        console.log(`[YT-DLP ${id}] ${text.trim()}`);
    }

    child.stdout.on("data", readProgress);
    child.stderr.on("data", data => { errorText = (errorText + data.toString()).slice(-5000); readProgress(data); });
    child.on("error", error => { clearTimeout(timeout); job.child = null; if (job.cancelled) { job.status = "cancelled"; return; } job.status = "error"; job.error = "İndirme işlemi başlatılamadı: " + error.message; });
    child.on("close", code => {
        clearTimeout(timeout);
        job.child = null;
        if (job.cancelled) {
            job.status = "cancelled";
            if (fs.existsSync(output)) fs.unlinkSync(output);
            return;
        }
        if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) {
            job.status = "ready";
            job.progress = 100;
            console.log(`[DOWNLOAD] ${id} hazır (${fs.statSync(output).size} byte).`);
        } else {
            job.status = "error";
            job.error = errorText.slice(-1500) || "Video indirilemedi. Kick bağlantısını kontrol et.";
            console.error(`[DOWNLOAD] ${id} başarısız: ${job.error}`);
            if (fs.existsSync(output)) fs.unlinkSync(output);
        }
    });
    res.status(202).json({ jobId: id, status: job.status, progress: job.progress });
});

app.delete("/download/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "İndirme görevi bulunamadı." });
    if (job.status === "processing") {
        job.cancelled = true;
        job.status = "cancelled";
        const child = job.child;
        if (child && child.exitCode === null && child.signalCode === null) {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
                else child.kill("SIGTERM");
            } catch (error) { if (error.code !== "ESRCH") console.error(`[CANCEL] ${req.params.id}:`, error.message); }
            const killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    try {
                        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
                        else child.kill("SIGKILL");
                    } catch (error) { if (error.code !== "ESRCH") console.error(`[CANCEL-KILL] ${req.params.id}:`, error.message); }
                }
            }, 2500);
            killTimer.unref();
        }
        try { if (fs.existsSync(job.output)) fs.unlinkSync(job.output); } catch (error) { console.error(`[CANCEL-FILE] ${req.params.id}:`, error.message); }
        console.log(`[CANCEL] ${req.params.id} iptal edildi.`);
    }
    return res.json({ status: job.status, cancelled: job.cancelled });
});

app.get("/download/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "İndirme görevi bulunamadı." });
    res.json({ status: job.status, progress: job.progress, error: job.error });
});

app.get("/download/:id/file", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "İndirme görevi bulunamadı." });
    if (job.status !== "ready" || !fs.existsSync(job.output)) return res.status(409).json({ error: "Video henüz hazır değil." });
    res.download(job.output, job.filename || "Kick-klibi.mp4", error => { if (error) console.error(`[DOWNLOAD] ${req.params.id} dosya gönderimi:`, error); });
});

setInterval(() => {
    for (const [id, job] of jobs) if (Date.now() - job.createdAt > 60 * 60 * 1000) {
        if (fs.existsSync(job.output)) fs.unlinkSync(job.output);
        jobs.delete(id);
    }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`SenuAhell Downloader v2 running on port ${PORT}`));
