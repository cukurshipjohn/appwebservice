require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3001;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'change_this_secret';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

app.use(cors({ origin: '*' })); // buka untuk semua dulu agar QR page bisa diakses
app.use(express.json());

// ── State ────────────────────────────────────────────────
let sock = null;
let isConnected = false;
let connectionStatus = 'disconnected';
let latestQR = null; // simpan QR terbaru sebagai string
let reconnectAttempts = 0;

// ── Baileys Connection ───────────────────────────────────
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: true, // tetap print di terminal sebagai fallback
        browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 10000,
    });

    connectionStatus = 'connecting';

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr_pending';
            console.log('\n📱 QR Code tersedia! Buka browser: http://localhost:' + PORT + '/qr\n');
        }

        if (connection === 'close') {
            isConnected = false;
            latestQR = null;
            reconnectAttempts++;

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`Koneksi WA terputus (attempt ${reconnectAttempts}). Status:`, statusCode);

            if (isLoggedOut) {
                connectionStatus = 'logged_out';
                console.log('⚠️  Sesi WA logout. Hapus folder auth_info_baileys dan restart server.');
            } else {
                connectionStatus = 'disconnected';
                const delay = Math.min(3000 * reconnectAttempts, 30000); // max 30 detik
                console.log(`🔄 Mencoba reconnect dalam ${delay / 1000} detik...`);
                setTimeout(connectToWhatsApp, delay);
            }
        }

        if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            connectionStatus = 'connected';
            reconnectAttempts = 0;
            console.log('✅ WhatsApp berhasil terkoneksi!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
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

// ── ENDPOINTS ────────────────────────────────────────────

// Health check - untuk UptimeRobot
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: connectionStatus, timestamp: new Date().toISOString() });
});

// Status WhatsApp
app.get('/status', (req, res) => {
    res.json({ connected: isConnected, status: connectionStatus });
});

// QR Code - tampil di browser sebagai gambar
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white">
                <h2 style="color:#22c55e">✅ WhatsApp Sudah Terkoneksi!</h2>
                <p>Tidak perlu scan QR. Microservice aktif dan siap mengirim pesan.</p>
            </body></html>
        `);
    }

    if (!latestQR) {
        return res.send(`
            <html><head><meta http-equiv="refresh" content="3"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white">
                <h2>⏳ Menunggu QR Code...</h2>
                <p>Status: <strong style="color:#f59e0b">${connectionStatus}</strong></p>
                <p>Halaman ini otomatis refresh setiap 3 detik.</p>
            </body></html>
        `);
    }

    try {
        const qrImageUrl = await QRCode.toDataURL(latestQR, { width: 300, margin: 2 });
        res.send(`
            <html><head><meta http-equiv="refresh" content="30"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white">
                <h2 style="color:#f59e0b">📱 Scan QR Code dengan WhatsApp</h2>
                <img src="${qrImageUrl}" style="border:4px solid #f59e0b;border-radius:12px;margin:20px auto;display:block" />
                <p style="color:#9ca3af">WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Scan</p>
                <p style="color:#6b7280;font-size:12px">QR berlaku ~60 detik. Halaman auto-refresh setiap 30 detik.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send('Gagal generate QR: ' + err.message);
    }
});

// Kirim OTP via WhatsApp
app.post('/send-otp', validateSecret, async (req, res) => {
    const { phoneNumber, otpCode } = req.body;

    if (!phoneNumber || !otpCode) {
        return res.status(400).json({ message: 'phoneNumber dan otpCode diperlukan.' });
    }

    if (!isConnected) {
        return res.status(503).json({
            message: 'WhatsApp belum terkoneksi. Silakan scan QR Code terlebih dahulu.',
            qrUrl: `/qr`,
            status: connectionStatus
        });
    }

    try {
        const jid = formatPhoneForWA(phoneNumber);
        const message =
            `🔐 *Kode OTP Haircut Booking Anda:*\n\n` +
            `*${otpCode}*\n\n` +
            `⏱️ Berlaku selama *5 menit*.\n` +
            `⚠️ Jangan bagikan kode ini ke siapapun.`;

        await sock.sendMessage(jid, { text: message });
        console.log(`✅ OTP terkirim ke ${phoneNumber}`);
        return res.json({ success: true, message: 'OTP berhasil terkirim.' });
    } catch (error) {
        console.error('Error mengirim OTP:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengirim OTP. Pastikan nomor terdaftar di WhatsApp.',
        });
    }
});

// Kirim Pesan Bebas via WhatsApp (untuk Notifikasi Barber)
app.post('/send-message', validateSecret, async (req, res) => {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
        return res.status(400).json({ message: 'phoneNumber dan message diperlukan.' });
    }

    if (!isConnected) {
        return res.status(503).json({
            message: 'WhatsApp belum terkoneksi. Silakan scan QR Code terlebih dahulu.',
            qrUrl: `/qr`,
            status: connectionStatus
        });
    }

    try {
        const jid = formatPhoneForWA(phoneNumber);
        await sock.sendMessage(jid, { text: message });
        console.log(`✅ Pesan terkirim ke ${phoneNumber}`);
        return res.json({ success: true, message: 'Pesan berhasil terkirim.' });
    } catch (error) {
        console.error('Error mengirim pesan:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengirim pesan.',
        });
    }
});

// ── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Service berjalan di port ${PORT}`);
    console.log(`📡 Health: http://localhost:${PORT}/health`);
    console.log(`📱 QR Scan: http://localhost:${PORT}/qr\n`);
    connectToWhatsApp();
});
