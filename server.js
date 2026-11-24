const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const jobs = new Map();
const rateLimits = new Map();
const MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(20, Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "5", 10) || 5));
const MAX_DOWNLOADS_PER_IP = Math.max(1, Math.min(5, Number.parseInt(process.env.MAX_DOWNLOADS_PER_IP || "2", 10) || 2));
const DOWNLOAD_RATE_LIMIT = Math.max(1, Math.min(20, Number.parseInt(process.env.DOWNLOAD_RATE_LIMIT || "5", 10) || 5));
const DOWNLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;
const STATUS_RATE_LIMIT = 120;
const STATUS_RATE_WINDOW_MS = 60 * 1000;
const allowedOrigins = new Set(["https://senuahell.pages.dev", ...(process.env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean)]);

app.set("trust proxy", 1);
app.use(cors({ origin(origin, callback) { if (!origin || allowedOrigins.has(origin)) return callback(null, true); return callback(new Error("Bu kaynaktan erişime izin verilmiyor.")); }, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Accept", "X-Download-Token"], maxAge: 86400 }));
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store"); next(); });

function getClientIp(req) { return req.ip || req.socket.remoteAddress || "unknown"; }
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now >= entry.resetAt) { entry = { count: 0, resetAt: now + windowMs }; rateLimits.set(key, entry); }
    entry.count++;
    return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}
function requireRateLimit(type, limit, windowMs) {
    return (req, res, next) => {
        const result = rateLimit(`${type}:${getClientIp(req)}`, limit, windowMs);
        res.setHeader("RateLimit-Limit", String(limit));
        res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - rateLimits.get(`${type}:${getClientIp(req)}`).count)));
        if (!result.allowed) { res.setHeader("Retry-After", String(result.retryAfter)); return res.status(429).json({ error: "Çok fazla istek gönderdin. Lütfen biraz sonra tekrar dene." }); }
        next();
    };
}
function validKickUrl(raw) {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && ["kick.com", "www.kick.com"].includes(u.hostname) && (/^\/senuahell\/(clips|videos)\//.test(u.pathname) || /^\/video\/[0-9a-f-]{36}$/i.test(u.pathname));
    } catch { return false; }
}
function ownsJob(req, res, next) {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "İndirme görevi bulunamadı." });
    const supplied = req.get("X-Download-Token") || "";
    const expected = job.accessToken;
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return res.status(404).json({ error: "İndirme görevi bulunamadı." });
    req.downloadJob = job;
    next();
}

app.get("/", (req, res) => res.json({ durum: "çevrimiçi", hizmet: "SenuaHell İndirici", sürüm: 4, maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS }));
app.get("/health", (req, res) => res.json({ status: "ok", version: 4, maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS }));

app.post("/download", requireRateLimit("start", DOWNLOAD_RATE_LIMIT, DOWNLOAD_RATE_WINDOW_MS), (req, res) => {
    const rawUrl = req.body && req.body.url;
    const rawTitle = req.body && typeof req.body.title === "string" ? req.body.title : "Kick-klibi";
    const safeTitle = rawTitle.normalize("NFKC").replace(/[\\/:*?"<>|\x00-\x1F]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 140) || "Kick-klibi";
    if (!rawUrl || typeof rawUrl !== "string") return res.status(400).json({ error: "Kick bağlantısı gerekli." });
    if (!validKickUrl(rawUrl)) return res.status(403).json({ error: "Yalnızca SenuaHell kanalının Kick klip ve yayınları desteklenir." });
    const clientIp = getClientIp(req);
    if (jobs.size >= 1000) return res.status(503).json({ error: "İndirme sunucusu şu anda yoğun. Lütfen biraz sonra tekrar dene." });
    if ([...jobs.values()].filter(job => job.status === "processing").length >= MAX_CONCURRENT_DOWNLOADS) return res.status(429).json({ error: `Şu anda en fazla ${MAX_CONCURRENT_DOWNLOADS} indirme aynı anda hazırlanabilir. Biraz sonra tekrar dene.` });
    if ([...jobs.values()].filter(job => job.ip === clientIp && job.status === "processing").length >= MAX_DOWNLOADS_PER_IP) return res.status(429).json({ error: `Aynı anda en fazla ${MAX_DOWNLOADS_PER_IP} indirme başlatabilirsin.` });

    const id = crypto.randomUUID();
    const accessToken = crypto.randomBytes(32).toString("base64url");
    const output = path.join(os.tmpdir(), `${id}.mp4`);
    const job = { status: "processing", progress: 0, output, filename: `${safeTitle}.mp4`, createdAt: Date.now(), error: null, child: null, cancelled: false, accessToken, ip: clientIp };
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
        } else {
            job.status = "error";
            job.error = "Video indirilemedi. Kick bağlantısını kontrol et ve tekrar dene.";
            console.error(`[DOWNLOAD] ${id} başarısız: ${errorText.slice(-1500) || `yt-dlp çıkış kodu: ${code}`}`);
            if (fs.existsSync(output)) fs.unlinkSync(output);
        }
    });
    res.status(202).json({ jobId: id, accessToken, status: job.status, progress: job.progress });
});

app.delete("/download/:id", requireRateLimit("status", STATUS_RATE_LIMIT, STATUS_RATE_WINDOW_MS), ownsJob, (req, res) => {
    const job = req.downloadJob;
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
    }
    return res.json({ status: job.status, cancelled: job.cancelled });
});

app.get("/download/:id", requireRateLimit("status", STATUS_RATE_LIMIT, STATUS_RATE_WINDOW_MS), ownsJob, (req, res) => {
    const job = req.downloadJob;
    res.json({ status: job.status, progress: job.progress, error: job.error });
});

app.get("/download/:id/file", requireRateLimit("file", 10, STATUS_RATE_WINDOW_MS), ownsJob, (req, res) => {
    const job = req.downloadJob;
    if (job.status !== "ready" || !fs.existsSync(job.output)) return res.status(409).json({ error: "Video henüz hazır değil." });
    res.download(job.output, job.filename || "Kick-klibi.mp4", error => { if (error) console.error(`[DOWNLOAD] ${req.params.id} dosya gönderimi:`, error); });
});

setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) if (now - job.createdAt > 60 * 60 * 1000) {
        if (fs.existsSync(job.output)) fs.unlinkSync(job.output);
        jobs.delete(id);
    }
    for (const [key, entry] of rateLimits) if (now >= entry.resetAt) rateLimits.delete(key);
}, 10 * 60 * 1000).unref();

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.message === "Bu kaynaktan erişime izin verilmiyor.") return res.status(403).json({ error: "Bu kaynaktan erişime izin verilmiyor." });
    console.error("[SERVER ERROR]", error.message);
    return res.status(500).json({ error: "Sunucuda beklenmeyen bir hata oluştu." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`SenuaHell Downloader v4 running on port ${PORT}`));
