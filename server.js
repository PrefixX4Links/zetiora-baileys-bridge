import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';

const logger = pino({ level: 'info' });

if (!BRIDGE_URL || !BRIDGE_SECRET) {
  logger.error('CRITICAL: BRIDGE_URL or BRIDGE_SECRET is missing!');
}

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory sessions tracking
// sellerId -> { sock, status, codeSent, pairPhone, starting }
const activeSockets = new Map();

// Helper to communicate with Zetiora Cloud Edge Function
async function callBridge(body) {
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET,
      },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    logger.error({ err: err.message, action: body.action }, 'Bridge call failed');
    return null;
  }
}

// Start or reconnect a WhatsApp session for a seller
async function startSession(sessionInfo) {
  const { seller_id, pair_method, pair_phone } = sessionInfo;

  if (activeSockets.has(seller_id)) {
    const existing = activeSockets.get(seller_id);
    if (existing.sock) return; // Tayari ipo hewani
  }

  const sessionFolder = path.join(SESSIONS_DIR, seller_id);
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sessionState = {
    sock: null,
    status: 'starting',
    codeSent: false,
    pairPhone: pair_phone || null,
  };
  activeSockets.set(seller_id, sessionState);

  // Browser lazima iwe macOS Desktop inayotambuliwa na WhatsApp bila shaka
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sessionState.sock = sock;

  // Pairing code request (ikitakiwa)
  if (pair_method === 'code' && pair_phone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        if (!sessionState.codeSent && !sock.authState.creds.registered) {
          sessionState.codeSent = true;
          const cleanPhone = String(pair_phone).replace(/[^0-9]/g, '');
          logger.info(`Requesting WhatsApp pairing code for +${cleanPhone}...`);
          
          const code = await sock.requestPairingCode(cleanPhone);
          logger.info(`Pairing code received: ${code}`);

          await callBridge({
            action: 'qr',
            seller_id,
            pair_code: code,
          });
        }
      } catch (err) {
        logger.error({ err: err.message }, 'Failed to request pairing code');
        sessionState.codeSent = false;
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code method
    if (qr && pair_method !== 'code') {
      await callBridge({
        action: 'qr',
        seller_id,
        qr,
      });
    }

    if (connection === 'open') {
      logger.info(`Seller ${seller_id} WhatsApp connected successfully!`);
      sessionState.status = 'connected';
      sessionState.codeSent = false;

      const userJid = sock.user?.id || '';
      const phone = userJid.split(':')[0] || userJid.split('@')[0];

      await callBridge({
        action: 'status',
        seller_id,
        status: 'connected',
        phone_number: phone,
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`Connection closed for seller ${seller_id}. Status code: ${statusCode}`);

      activeSockets.delete(seller_id);

      if (!shouldReconnect) {
        logger.info(`Session logged out for ${seller_id}. Cleaning up files.`);
        try {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
        } catch (_) {}
        await callBridge({ action: 'status', seller_id, status: 'disconnected' });
      } else {
        // Ikiwa pairing code ilikuwa tayari imetoka, usijirudie kutoa mpya mara moja
        if (!sessionState.codeSent) {
          setTimeout(() => startSession(sessionInfo), 5000);
        }
      }
    }
  });

  // Handle incoming customer messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      logger.info(`Message from ${jid}: "${text}"`);

      const resp = await callBridge({
        action: 'message',
        seller_id,
        from: jid,
        text,
      });

      if (resp?.reply) {
        await sock.sendMessage(jid, { text: resp.reply });
      }

      if (Array.isArray(resp?.images) && resp.images.length > 0) {
        for (const imgUrl of resp.images) {
          try {
            await sock.sendMessage(jid, { image: { url: imgUrl } });
          } catch (e) {
            logger.error(`Failed to send image: ${imgUrl}`);
          }
        }
      }
    }
  });
}

// Polling loop: Angalia kila baada ya sekunde 6 kama kuna duka linalotaka kuunganisha
async function syncSessions() {
  const res = await callBridge({ action: 'sessions' });
  if (res?.sessions && Array.isArray(res.sessions)) {
    for (const s of res.sessions) {
      if (s.status === 'pending' || s.status === 'qr') {
        startSession(s);
      } else if (s.status === 'connected' && !activeSockets.has(s.seller_id)) {
        // Reconnect established session from disk
        startSession(s);
      }
    }
  }
}

setInterval(syncSessions, 6000);
syncSessions();

// Health check endpoint ya Railway
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    active_sellers: activeSockets.size,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Zetiora Baileys Bridge listening on port ${PORT}`);
});
