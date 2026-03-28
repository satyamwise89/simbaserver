const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const serverDir = __dirname;
const siteDir = path.resolve(__dirname, "..");
const privateDir = path.join(serverDir, ".private");
const configPath = path.join(privateDir, "telegram-config.json");
const rateLimitPath = path.join(privateDir, "contact-rate-limit.json");
const chatStorePath = path.join(privateDir, "chat-data.json");

function readConfig() {
    if (!fs.existsSync(configPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(configPath, "utf8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

const config = readConfig();
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: false
}));

function cleanText(value, maxLength = 500) {
    return String(value || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[^\P{C}\n\t]/gu, "")
        .trim()
        .slice(0, maxLength);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizePhoneLink(value) {
    return String(value || "").replace(/[^+\d]/g, "");
}

function maskIp(ipAddress) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ipAddress)) {
        const parts = ipAddress.split(".");
        parts[3] = "xxx";
        return parts.join(".");
    }

    if (ipAddress.includes(":")) {
        return ipAddress.replace(/:[0-9a-f]{0,4}$/i, ":xxxx");
    }

    return "Unavailable";
}

function readRateLimitData() {
    if (!fs.existsSync(rateLimitPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(rateLimitPath, "utf8");
        return raw.trim() ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeRateLimitData(data) {
    if (!fs.existsSync(privateDir)) {
        fs.mkdirSync(privateDir, { recursive: true });
    }

    fs.writeFileSync(rateLimitPath, JSON.stringify(data, null, 2), "utf8");
}

function ensurePrivateDir() {
    if (!fs.existsSync(privateDir)) {
        fs.mkdirSync(privateDir, { recursive: true });
    }
}

function readChatStore() {
    ensurePrivateDir();

    if (!fs.existsSync(chatStorePath)) {
        return { sessions: {}, telegram: { lastUpdateId: 0, activeSessions: {}, authorizedChatIds: [], pendingAuth: {} } };
    }

    try {
        const raw = fs.readFileSync(chatStorePath, "utf8");
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        return {
            sessions: parsed.sessions || {},
            telegram: parsed.telegram || { lastUpdateId: 0, activeSessions: {}, authorizedChatIds: [], pendingAuth: {} }
        };
    } catch {
        return { sessions: {}, telegram: { lastUpdateId: 0, activeSessions: {}, authorizedChatIds: [], pendingAuth: {} } };
    }
}

function writeChatStore(data) {
    ensurePrivateDir();
    fs.writeFileSync(chatStorePath, JSON.stringify(data, null, 2), "utf8");
}

function createChatSessionId() {
    return `SM-${Math.random().toString(36).slice(2, 6).toUpperCase()}${Date.now().toString().slice(-4)}`;
}

function formatChatMessages(messages = []) {
    return messages.map((message) => ({
        id: message.id,
        sender: message.sender,
        text: message.text,
        ts: message.ts
    }));
}

function getOrCreateChatSession(clientId, pageContext = "") {
    const store = readChatStore();
    let sessionEntry = Object.values(store.sessions).find((session) => session.clientId === clientId);

    if (!sessionEntry) {
        const sessionId = createChatSessionId();
        sessionEntry = {
            sessionId,
            clientId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pageContext,
            status: "open",
            messages: []
        };
        store.sessions[sessionId] = sessionEntry;
        writeChatStore(store);
    } else if (pageContext) {
        sessionEntry.pageContext = pageContext;
        sessionEntry.updatedAt = Date.now();
        store.sessions[sessionEntry.sessionId] = sessionEntry;
        writeChatStore(store);
    }

    return sessionEntry;
}

function appendChatMessage(sessionId, sender, text) {
    const store = readChatStore();
    const session = store.sessions[sessionId];
    if (!session) {
        return null;
    }

    session.messages.push({
        id: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sender,
        text,
        ts: Date.now()
    });
    session.updatedAt = Date.now();
    store.sessions[sessionId] = session;
    writeChatStore(store);
    return session;
}

async function telegramApi(method, params) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || config.botToken;
    if (!botToken) {
        throw new Error("Telegram configuration missing.");
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(params)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(`Telegram API ${method} failed.`);
    }

    return data;
}

function createTelegramMessage({ name, email, phone, productInterest, message, pageContext, ipAddress, userAgent }) {
    const timeStamp = `${new Date().toUTCString()} UTC`;
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone || "Not provided");
    const safeInterest = escapeHtml(productInterest || "General enquiry");
    const priorityTag = safeInterest.toLowerCase().includes("bulk") ? "HIGH PRIORITY" : "NEW LEAD";

    return [
        "<b>SIMBA AGRO CHEMICALS | NEW INQUIRY</b>",
        "",
        `<b>PRIORITY</b>  <code>${priorityTag}</code>`,
        `<b>PRODUCT</b>  <code>${safeInterest}</code>`,
        "",
        "------------------------------",
        "<b>CLIENT DETAILS</b>",
        `- <b>Name</b>  ${escapeHtml(name)}`,
        `- <b>Email</b>  ${safeEmail}`,
        `- <b>Phone</b>  ${safePhone}`,
        "",
        "------------------------------",
        "<b>MESSAGE</b>",
        escapeHtml(message).replace(/\n/g, "<br>"),
        "",
        "------------------------------",
        "<b>SOURCE DETAILS</b>",
        `- <b>Page</b>  ${escapeHtml(pageContext || "Direct visit")}`,
        `- <b>Time</b>  ${escapeHtml(timeStamp)}`,
        `- <b>IP</b>  ${escapeHtml(maskIp(ipAddress))}`,
        `- <b>Device</b>  ${escapeHtml(userAgent || "Unavailable")}`,
        "",
        "------------------------------",
        "<i>Sent from Simba Agro Chemicals website contact form</i>"
    ].join("\n");
}

async function sendTelegramMessage(text) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || config.botToken;
    const chatId = process.env.TELEGRAM_CHAT_ID || config.chatId;

    if (!botToken || !chatId) {
        throw new Error("Telegram configuration missing.");
    }

    const payload = {
        chat_id: String(chatId),
        text,
        parse_mode: "HTML",
        disable_web_page_preview: "true"
    };

    await telegramApi("sendMessage", payload);
}

async function sendTelegramMessageTo(chatId, text) {
    if (!chatId) {
        throw new Error("Telegram chat id missing.");
    }

    await telegramApi("sendMessage", {
        chat_id: String(chatId),
        text,
        parse_mode: "HTML",
        disable_web_page_preview: "true"
    });
}

function getAdminPassword() {
    return process.env.ADMIN_ACCESS_PASSWORD || config.adminAccessPassword || "";
}

async function sendToAuthorizedAdmins(text) {
    const store = readChatStore();
    const authorized = Array.isArray(store.telegram.authorizedChatIds) ? store.telegram.authorizedChatIds : [];
    const fallbackChatId = process.env.TELEGRAM_CHAT_ID || config.chatId;
    const recipients = authorized.length ? authorized : (fallbackChatId ? [String(fallbackChatId)] : []);

    for (const recipient of recipients) {
        await sendTelegramMessageTo(recipient, text);
    }
}

async function sendSupportNotification(sessionId, pageContext, text) {
    const safePage = escapeHtml(pageContext || "Website chat");
    const safeText = escapeHtml(text).replace(/\n/g, "<br>");
    await sendToAuthorizedAdmins([
        "<b>SIMBA AGRO CHEMICALS | LIVE CHAT</b>",
        "",
        `<b>SESSION</b>  <code>${sessionId}</code>`,
        `<b>PAGE</b>  ${safePage}`,
        "",
        "<b>VISITOR MESSAGE</b>",
        safeText,
        "",
        `<i>Quick reply:</i> <code>/open ${sessionId}</code>`,
        "<i>Then send normal messages. Use</i> <code>/close</code> <i>to exit reply mode.</i>"
    ].join("\n"));
}

function parseAdminReply(text) {
    const match = String(text || "").match(/^\/reply\s+([A-Za-z0-9-]+)\s+([\s\S]+)/i);
    if (!match) {
        return null;
    }

    return {
        sessionId: match[1].trim(),
        message: match[2].trim()
    };
}

function parseOpenSession(text) {
    const match = String(text || "").match(/^\/open\s+([A-Za-z0-9-]+)/i);
    return match ? match[1].trim() : null;
}

function isCloseCommand(text) {
    return /^\/close\b/i.test(String(text || ""));
}

async function processTelegramUpdates() {
    if (!(process.env.TELEGRAM_BOT_TOKEN || config.botToken)) {
        return;
    }

    const store = readChatStore();
    const offset = Number(store.telegram?.lastUpdateId || 0) + 1;
    store.telegram.activeSessions = store.telegram.activeSessions || {};
    store.telegram.authorizedChatIds = store.telegram.authorizedChatIds || [];
    store.telegram.pendingAuth = store.telegram.pendingAuth || {};

    let result;
    try {
        result = await telegramApi("getUpdates", {
            offset: String(offset),
            timeout: "0",
            allowed_updates: JSON.stringify(["message"])
        });
    } catch {
        return;
    }

    if (!Array.isArray(result.result) || result.result.length === 0) {
        return;
    }

    for (const update of result.result) {
        store.telegram.lastUpdateId = update.update_id;
        const message = update.message;
        if (!message) {
            continue;
        }

        const chatId = String(message.chat?.id || "");
        const text = String(message.text || "").trim();
        const isAuthorized = store.telegram.authorizedChatIds.includes(chatId);

        if (/^\/start\b/i.test(text)) {
            store.telegram.pendingAuth[chatId] = true;
            await sendTelegramMessageTo(chatId, "Admin access password bhejiye.");
            continue;
        }

        if (!isAuthorized) {
            if (store.telegram.pendingAuth[chatId] && text === getAdminPassword()) {
                store.telegram.authorizedChatIds.push(chatId);
                store.telegram.pendingAuth[chatId] = false;
                await sendTelegramMessageTo(chatId, "Admin access granted. Ab aapko Simba website inquiries aur live chat requests milengi.");
            } else if (store.telegram.pendingAuth[chatId]) {
                await sendTelegramMessageTo(chatId, "Password incorrect hai. Dubara sahi password bhejiye.");
            }
            continue;
        }

        const openSessionId = parseOpenSession(text);
        if (openSessionId) {
            if (!store.sessions[openSessionId]) {
                await sendTelegramMessageTo(chatId, `Session <code>${escapeHtml(openSessionId)}</code> was not found.`);
                continue;
            }

            store.telegram.activeSessions[chatId] = openSessionId;
            await sendTelegramMessageTo(chatId, [
                `Reply mode opened for <code>${escapeHtml(openSessionId)}</code>.`,
                "Now send normal messages and they will be delivered to that website visitor.",
                "Send <code>/close</code> when you want to exit reply mode."
            ].join("\n"));
            continue;
        }

        if (isCloseCommand(text)) {
            const previousSession = store.telegram.activeSessions[chatId] || "";
            delete store.telegram.activeSessions[chatId];
            await sendTelegramMessageTo(chatId, previousSession
                ? `Reply mode closed for <code>${escapeHtml(previousSession)}</code>.`
                : "No active reply mode was open.");
            continue;
        }

        const parsed = parseAdminReply(text);
        if (parsed) {
            const session = store.sessions[parsed.sessionId];
            if (!session) {
                await sendTelegramMessageTo(chatId, `Session <code>${escapeHtml(parsed.sessionId)}</code> was not found.`);
                continue;
            }

            session.messages.push({
                id: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                sender: "admin",
                text: parsed.message,
                ts: Date.now()
            });
            session.updatedAt = Date.now();
            store.sessions[parsed.sessionId] = session;
            await sendTelegramMessageTo(chatId, `Reply sent to session <code>${escapeHtml(parsed.sessionId)}</code>.`);
            continue;
        }

        const activeSessionId = store.telegram.activeSessions[chatId] || "";
        if (!activeSessionId || !store.sessions[activeSessionId]) {
            continue;
        }

        const activeSession = store.sessions[activeSessionId];
        activeSession.messages.push({
            id: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            sender: "admin",
            text,
            ts: Date.now()
        });
        activeSession.updatedAt = Date.now();
        store.sessions[activeSessionId] = activeSession;
    }

    writeChatStore(store);
}

app.post("/api/contact/submit", async (req, res) => {
    const honeypot = cleanText(req.body.company, 120);
    if (honeypot) {
        return res.status(400).json({ ok: false, message: "Spam check failed." });
    }

    const name = cleanText(req.body.name, 120);
    const email = cleanText(req.body.email, 180);
    const phone = cleanText(req.body.phone, 60);
    const productInterest = cleanText(req.body.product_interest, 120);
    const message = cleanText(req.body.message, 2000);
    const pageContext = cleanText(req.body.page_context, 160);

    if (!name || name.length < 2) {
        return res.status(422).json({ ok: false, message: "Please enter a valid name." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(422).json({ ok: false, message: "Please enter a valid email address." });
    }

    if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) {
        return res.status(422).json({ ok: false, message: "Please enter a valid phone number." });
    }

    if (message.length < 12) {
        return res.status(422).json({ ok: false, message: "Please enter a more detailed message so the team can help properly." });
    }

    const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
    const now = Math.floor(Date.now() / 1000);
    const ipKey = `${ipAddress}`.trim().toLowerCase();
    const rateLimitWindow = Number(config.rateLimitWindow || 900);
    const rateLimitAttempts = Number(config.rateLimitAttempts || 3);

    const rateData = readRateLimitData();
    const filteredRateData = {};
    for (const [key, value] of Object.entries(rateData)) {
        const timestamps = Array.isArray(value.timestamps)
            ? value.timestamps.filter((timestamp) => (now - Number(timestamp)) < rateLimitWindow)
            : [];

        if (timestamps.length) {
            filteredRateData[key] = { timestamps };
        }
    }

    const currentTimestamps = filteredRateData[ipKey]?.timestamps || [];
    if (currentTimestamps.length >= rateLimitAttempts) {
        return res.status(429).json({ ok: false, message: "Too many enquiries received from this network. Please try again shortly." });
    }

    currentTimestamps.push(now);
    filteredRateData[ipKey] = { timestamps: currentTimestamps };
    writeRateLimitData(filteredRateData);

    try {
        await sendTelegramMessage(createTelegramMessage({
            name,
            email,
            phone,
            productInterest,
            message,
            pageContext,
            ipAddress,
            userAgent: cleanText(req.get("user-agent"), 220)
        }));
    } catch (error) {
        return res.status(502).json({ ok: false, message: "Unable to send your enquiry right now. Please try again in a moment." });
    }

    return res.json({
        ok: true,
        message: "Thank you. Your enquiry has been sent to the Simba Agro Chemicals team."
    });
});

app.post("/api/chat/session", (req, res) => {
    const clientId = cleanText(req.body.client_id, 80);
    const pageContext = cleanText(req.body.page_context, 160);

    if (!clientId) {
        return res.status(422).json({ ok: false, message: "Client id missing." });
    }

    const session = getOrCreateChatSession(clientId, pageContext);
    return res.json({
        ok: true,
        session_id: session.sessionId,
        messages: formatChatMessages(session.messages)
    });
});

app.get("/api/chat/messages", (req, res) => {
    const clientId = cleanText(req.query.client_id, 80);
    if (!clientId) {
        return res.status(422).json({ ok: false, message: "Client id missing." });
    }

    const session = getOrCreateChatSession(clientId);
    return res.json({
        ok: true,
        session_id: session.sessionId,
        messages: formatChatMessages(session.messages)
    });
});

app.post("/api/chat/message", async (req, res) => {
    const clientId = cleanText(req.body.client_id, 80);
    const pageContext = cleanText(req.body.page_context, 160);
    const text = cleanText(req.body.message, 1200);

    if (!clientId || !text) {
        return res.status(422).json({ ok: false, message: "Message data missing." });
    }

    if (text.length < 2) {
        return res.status(422).json({ ok: false, message: "Please enter a longer message." });
    }

    const session = getOrCreateChatSession(clientId, pageContext);
    appendChatMessage(session.sessionId, "user", text);

    try {
        await sendSupportNotification(session.sessionId, pageContext, text);
    } catch {
        return res.status(502).json({ ok: false, message: "Unable to send your chat message right now." });
    }

    const updatedSession = getOrCreateChatSession(clientId, pageContext);
    return res.json({
        ok: true,
        session_id: updatedSession.sessionId,
        messages: formatChatMessages(updatedSession.messages)
    });
});

if (process.env.SERVE_STATIC === "true") {
    app.use(express.static(siteDir, {
        extensions: ["html"]
    }));

    app.get("/", (req, res) => {
        res.sendFile(path.join(siteDir, "index.html"));
    });
}

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        service: "simba-server"
    });
});

function schedulePeerPing({ url, initialDelayMs, intervalMs }) {
    const sendPing = async () => {
        try {
            const response = await fetch(url, { method: "GET", cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Ping failed with status ${response.status}`);
            }
        } catch {
            // Silent fail to avoid noisy logs in production.
        }
    };

    setTimeout(() => {
        sendPing();
        setInterval(sendPing, intervalMs);
    }, initialDelayMs);
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
    console.log(`Simba server running on http://127.0.0.1:${port}`);
});

schedulePeerPing({
    url: "https://rahaseedserver.onrender.com/api/health",
    initialDelayMs: 60 * 1000,
    intervalMs: 3 * 60 * 1000
});

setInterval(() => {
    processTelegramUpdates().catch(() => {});
}, 5000);
