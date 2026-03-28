require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3001;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'change_this_secret';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── State ────────────────────────────────────────────────
// sessions: Map<sessionId, SessionData>
// SessionData: { sock, status, qr, reconnectAttempts, phone }
const sessions = new Map();

// Helper to get or init session data
function getSessionData(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            sock: null,
            status: 'disconnected',
            qr: null,
            reconnectAttempts: 0,
            phone: null
        });
    }
    return sessions.get(sessionId);
}

// ── Hapus session folder ─────────────────────────────────
function clearAuthSession(sessionId) {
    const authDir = path.join(__dirname, 'sessions', sessionId);
    if (fs.existsSync(authDir)) {
        fs.readdirSync(authDir).forEach(file => {
            try { fs.unlinkSync(path.join(authDir, file)); } catch (_) {}
        });
        try { fs.rmdirSync(authDir); } catch(_) {}
        console.log(`🗑️  Session auth info untuk ${sessionId} berhasil dibersihkan.`);
    }
}

// ── Baileys Connection ───────────────────────────────────
async function connectToWhatsApp(sessionId = 'default') {
    const sessionData = getSessionData(sessionId);
    if (sessionData.status === 'connecting' || sessionData.status === 'connected') {
        return; // Already connecting or connected
    }

    // ⚠️ Set status SYNCHRONOUSLY sebelum await pertama
    // → Mencegah race condition di mana autoConnectSavedSessions
    //   memanggil fungsi ini lagi sebelum try-block di bawah sempat jalan
    sessionData.status = 'connecting';

    try {

    const authDir = path.join(__dirname, 'sessions', sessionId);
    // Ensure dir exists
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        // printQRInTerminal sudah deprecated oleh Baileys, QR ditangani manual via endpoint
        browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60_000,
        keepAliveInteroutMs: 25_000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined
    });

    sessionData.sock = sock;
    // Status sudah di set ke 'connecting' di atas (pre-async)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.qr = qr;
            sessionData.status = 'qr_pending';
            console.log(`\n📱 [${sessionId}] QR Code tersedia!`);
        }

        if (connection === 'close') {
            sessionData.sock = null;
            sessionData.qr = null;
            sessionData.phone = null;
            sessionData.reconnectAttempts++;

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`[${sessionId}] Koneksi WA terputus (attempt ${sessionData.reconnectAttempts}). Status:`, statusCode);

            if (isLoggedOut) {
                sessionData.status = 'logged_out';
                console.log(`⚠️  [${sessionId}] Sesi WA logout. Membersihkan sesi...`);
                clearAuthSession(sessionId);
            } else {
                sessionData.status = 'disconnected';
                const delay = Math.min(3000 * sessionData.reconnectAttempts, 30000); // max 30 detik
                console.log(`🔄 [${sessionId}] Mencoba reconnect dalam ${delay / 1000} detik...`);
                setTimeout(() => connectToWhatsApp(sessionId), delay);
            }
        }

        if (connection === 'open') {
            sessionData.qr = null;
            sessionData.status = 'connected';
            sessionData.reconnectAttempts = 0;
            if (sock.user) {
                // Get phone number from user id
                sessionData.phone = jidNormalizedUser(sock.user.id).split('@')[0];
            }
            console.log(`✅ [${sessionId}] WhatsApp berhasil terkoneksi! (${sessionData.phone})`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        // Error thrown from connectToWhatsApp itself (e.g. timeout during pre-key upload)
        // We never want this to crash the process — just schedule a reconnect
        console.error(`❌ [${sessionId}] connectToWhatsApp gagal:`, err.message || err);
        const sessionData = getSessionData(sessionId);
        sessionData.sock = null;
        sessionData.status = 'disconnected';
        const delay = Math.min(5000 * (sessionData.reconnectAttempts + 1), 30000);
        console.log(`🔄 [${sessionId}] Retry dalam ${delay / 1000} detik setelah error...`);
        setTimeout(() => connectToWhatsApp(sessionId), delay);
    }
}

// ── Middleware: Validasi Internal Secret ─────────────────
function validateSecret(req, res, next) {
    const secret = req.headers['x-internal-secret'];
    if (secret !== INTERNAL_SECRET) {
        return res.status(403).json({ message: 'Unauthorized.' });
    }
    next();
}

// ── Format Nomor WA ──────────────────────────────────────
function formatPhoneForWA(phoneNumber) {
    let cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
    if (!cleaned.startsWith('6') && cleaned.length <= 12) cleaned = '62' + cleaned;
    return cleaned + '@s.whatsapp.net';
}

// ── ENDPOINTS MULTI-TENANT ───────────────────────────────

// 1. Create Session
app.post('/session/create', validateSecret, async (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    const sessionData = getSessionData(session_id);
    if (sessionData.status === 'connected') {
        return res.json({ success: true, status: 'connected', message: 'Already connected' });
    }

    // Initialize connection async
    connectToWhatsApp(session_id);
    
    res.json({ success: true, message: 'Session initialization started', session_id });
});

// 2. Get Status
app.get('/session/status/:session_id', validateSecret, (req, res) => {
    const session_id = req.params.session_id;
    if (!sessions.has(session_id)) {
        return res.json({ status: 'disconnected', phone: null });
    }
    const data = sessions.get(session_id);
    res.json({ status: data.status, phone: data.phone });
});

// 3. Get QR
app.get('/session/qr/:session_id', validateSecret, async (req, res) => {
    const session_id = req.params.session_id;
    if (!sessions.has(session_id)) {
        return res.status(404).json({ error: 'Session not found or not initialized' });
    }
    
    const data = sessions.get(session_id);
    if (data.status === 'connected') {
        return res.json({ status: 'connected', phone: data.phone });
    }

    if (!data.qr) {
        return res.json({ status: data.status, qr: null });
    }

    try {
        const qrBase64 = await QRCode.toDataURL(data.qr, { width: 300, margin: 2 });
        res.json({ status: 'qr_pending', qr: qrBase64 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR', details: err.message });
    }
});

// 4. Logout / Disconnect
app.delete('/session/logout/:session_id', validateSecret, async (req, res) => {
    const session_id = req.params.session_id;
    if (!sessions.has(session_id)) {
        return res.json({ success: true, message: 'Session not found, considered logged out' });
    }

    const data = sessions.get(session_id);
    if (data.sock) {
        try { await data.sock.logout(); } catch (_) {}
        try { data.sock.end(); } catch (_) {}
    }
    
    data.sock = null;
    data.qr = null;
    data.phone = null;
    data.status = 'disconnected';

    clearAuthSession(session_id);
    sessions.delete(session_id);

    res.json({ success: true, message: 'Session logged out and cleared', session_id });
});


// ── ENDPOINTS SEND MESSAGE ───────────────────────────────

// Helper to get active sock
function getActiveSock(sessionIdTarget) {
    if (sessionIdTarget && sessions.has(sessionIdTarget)) {
        const targetSession = sessions.get(sessionIdTarget);
        if (targetSession.status === 'connected' && targetSession.sock) {
            return targetSession.sock; // Use tenant session
        }
    }
    
    // Fallback to default
    const defaultSession = sessions.get('default');
    if (defaultSession && defaultSession.status === 'connected' && defaultSession.sock) {
        return defaultSession.sock;
    }

    return null;
}

// Kirim Pesan Bebas via WhatsApp
app.post('/send-message', validateSecret, async (req, res) => {
    const { session_id, phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
        return res.status(400).json({ message: 'phoneNumber dan message diperlukan.' });
    }

    const sock = getActiveSock(session_id);

    if (!sock) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp belum terkoneksi (baik tenant maupun default).',
        });
    }

    try {
        const jid = formatPhoneForWA(phoneNumber);
        
        // Wrap Baileys sendMessage with a 5-second timeout
        const sendMessagePromise = sock.sendMessage(jid, { text: message });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout mengirim pesan WhatsApp (Socket Half-Open)')), 5000)
        );
        
        await Promise.race([sendMessagePromise, timeoutPromise]);
        
        console.log(`✅ Pesan terkirim ke ${phoneNumber} (via ${session_id || 'default'})`);
        return res.json({ success: true, message: 'Pesan berhasil terkirim.' });
    } catch (error) {
        console.error('Error mengirim pesan:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengirim pesan.',
            error: error.message
        });
    }
});

// Kirim OTP via WhatsApp
app.post('/send-otp', validateSecret, async (req, res) => {
    const { session_id, phoneNumber, otpCode } = req.body;

    if (!phoneNumber || !otpCode) {
        return res.status(400).json({ message: 'phoneNumber dan otpCode diperlukan.' });
    }

    const sock = getActiveSock(session_id);

    if (!sock) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp belum terkoneksi.',
        });
    }

    try {
        const jid = formatPhoneForWA(phoneNumber);
        const message =
            `🔐 *Kode OTP Haircut Booking Anda:*\n\n` +
            `*${otpCode}*\n\n` +
            `⏱️ Berlaku selama *5 menit*.\n` +
            `⚠️ Jangan bagikan kode ini ke siapapun.`;

        const sendMessagePromise = sock.sendMessage(jid, { text: message });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout mengirim pesan WhatsApp (Socket Half-Open)')), 5000)
        );
        
        await Promise.race([sendMessagePromise, timeoutPromise]);
        
        console.log(`✅ OTP terkirim ke ${phoneNumber}`);
        return res.json({ success: true, message: 'OTP berhasil terkirim.' });
    } catch (error) {
        console.error('Error mengirim OTP:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengirim OTP.',
            error: error.message
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    const defaultData = getSessionData('default');
    res.json({ 
        status: 'ok', 
        default_status: defaultData.status,
        active_sessions: Array.from(sessions.keys()).filter(k => sessions.get(k).status === 'connected').length,
        timestamp: new Date().toISOString() 
    });
});

// ── RECOVERY OLD SESSIONS ────────────────────────────────
function autoConnectSavedSessions() {
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) return;
    
    const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
                   .filter(dirent => dirent.isDirectory())
                   .map(dirent => dirent.name);
    
    for (const sid of dirs) {
        // Skip 'default' — sudah di-connect secara eksplisit di app.listen
        if (sid === 'default') continue;
        // Only connect if there are creds.json inside
        if (fs.existsSync(path.join(sessionsDir, sid, 'creds.json'))) {
            console.log(`\ud83d\udd04 Auto-connecting saved session: ${sid}`);
            connectToWhatsApp(sid);
        }
    }
}

// ── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Multitenant WhatsApp Service berjalan di port ${PORT}`);
    
    // Convert old single auth_info_baileys to multi-tenant 'default' if it exists and 'sessions/default' doesn't
    const oldAuthPath = path.join(__dirname, 'auth_info_baileys');
    const newDefaultPath = path.join(__dirname, 'sessions', 'default');
    if (fs.existsSync(oldAuthPath)) {
        if (!fs.existsSync(newDefaultPath)) {
            console.log('📦 Migrating old auth_info_baileys to sessions/default...');
            fs.mkdirSync(path.join(__dirname, 'sessions'), { recursive: true });
            fs.renameSync(oldAuthPath, newDefaultPath);
        } else {
            // cleanup old path if already migrated
            fs.rmSync(oldAuthPath, { recursive: true, force: true });
        }
    }

    // Connect default
    connectToWhatsApp('default');
    
    // Reconnect other saved sessions
    autoConnectSavedSessions();
});

// ── Global Safety Net ────────────────────────────────────
// Prevents ANY unhandled promise rejection from crashing the process.
// Baileys sometimes throws transient errors (408 Timed Out, Bad MAC, etc.)
// that are internal to the socket lifecycle. These should NEVER kill the server.
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️  [Global] Unhandled Promise Rejection (tidak fatal):', reason?.message || reason);
    // Do NOT rethrow — just log. The corresponding session's 'connection.update' handler
    // will see connection === 'close' and schedule its own reconnect.
});

process.on('uncaughtException', (err) => {
    console.error('🔴 [Global] Uncaught Exception:', err.message || err);
    // For truly unexpected errors we still exit, but at least we logged it.
    // Comment this line out if you want the server to survive ALL errors.
    // process.exit(1);
});
