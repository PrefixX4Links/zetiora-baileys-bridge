import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.cwd(), 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: 'info' });
const activeSockets = new Map();
const pairingCodeRequested = new Set();

async function postToBridge(payload) {
  if (!BRIDGE_URL || !BRIDGE_SECRET) return null;
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    logger.error('Bridge POST error:', err.message);
    return null;
  }
}

async function startSession(sessionInfo) {
  const sellerId = sessionInfo.seller_id;
  const sessionDir = path.join(SESSIONS_DIR, `seller_${sellerId}`);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Ikiwa socket tayari ipo na imeunganishwa, usirudie
  const existing = activeSockets.get(sellerId);
  if (existing?.user?.id) {
    return;
  }

  logger.info(`[${sellerId}] Starting WhatsApp session (method: ${sessionInfo.pair_method || 'qr'})...`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  activeSockets.set(sellerId, sock);

  // Tumia ev.process kuhakikisha saveCreds inakamilika kabla ya connection.update
  sock.ev.process(async (events) => {
    // 1. Hifadhi funguo mara moja zikibadilika
    if (events['creds.update']) {
      await saveCreds();
    }

    // 2. Mabadiliko ya muunganisho
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // QR Code
      if (qr && sessionInfo.pair_method === 'qr') {
        logger.info(`[${sellerId}] QR Code ready.`);
        await postToBridge({
          action: 'qr',
          seller_id: sellerId,
          qr,
        });
      }

      // Imeunganishwa kikamilifu
      if (connection === 'open') {
        logger.info(`[${sellerId}] WhatsApp connected successfully!`);
        pairingCodeRequested.delete(sellerId);
        const phone = sock.user?.id?.split(':')[0] || sessionInfo.pair_phone;
        await postToBridge({
          action: 'status',
          seller_id: sellerId,
          status: 'connected',
          phone_number: phone,
        });
      }

      // Muunganisho umefungwa
      if (connection === 'close') {
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired; // Code 515

        logger.info(`[${sellerId}] Connection closed. StatusCode: ${statusCode} (restartRequired: ${isRestartRequired})`);

        if (isLoggedOut) {
          logger.warn(`[${sellerId}] Device logged out. Cleaning up.`);
          pairingCodeRequested.delete(sellerId);
          activeSockets.delete(sellerId);
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
          await postToBridge({
            action: 'status',
            seller_id: sellerId,
            status: 'disconnected',
          });
          return;
        }

        // MUHIMU: Baada ya kuingiza Pairing Code simuni, WhatsApp inatuma 515.
        // Ni lazima tu-reconnect mara moja ili WhatsApp ikamilishe muunganisho!
        if (isRestartRequired) {
          logger.info(`[${sellerId}] Pairing handshake succeeded (Code 515). Reconnecting with new credentials...`);
          setTimeout(() => startSession(sessionInfo), 500);
          return;
        }

        // Ikiwa code bado inasubiri mtu aiandike kwenye simu, usilazimishe restart ya hovyo
        if (sessionInfo.pair_method === 'code' && pairingCodeRequested.has(sellerId) && !state.creds.registered) {
          logger.info(`[${sellerId}] Waiting for seller to finish entering code on phone...`);
          return;
        }

        // Hitilafu nyingine za kawaida za mtandao: jaribu tena baada ya sekunde 5
        setTimeout(() => startSession(sessionInfo), 5000);
      }
    }

    // 3. Kupokea ujumbe kutoka kwa wateja
    if (events['messages.upsert']) {
      const { messages, type } = events['messages.upsert'];
      if (type !== 'notify') return;

      for (const m of messages) {
        if (m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue;

        const text = m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          '';

        if (!text.trim()) continue;

        const customerPhone = jid.split('@')[0];
        const pushName = m.pushName || 'Mteja';

        const replyData = await postToBridge({
          action: 'message',
          seller_id: sellerId,
          from: customerPhone,
          name: pushName,
          text,
        });

        if (replyData?.reply && activeSockets.has(sellerId)) {
          const s = activeSockets.get(sellerId);
          await s.sendMessage(jid, { text: replyData.reply });
        }
      }
    }
  });

  // 4. Omba Pairing Code ikiwa mtindo ni 'code' na haijasajiliwa bado
  if (sessionInfo.pair_method === 'code' && sessionInfo.pair_phone && !state.creds.registered) {
    if (!pairingCodeRequested.has(sellerId)) {
      setTimeout(async () => {
        try {
          const cleanPhone = String(sessionInfo.pair_phone).replace(/[^0-9]/g, '');
          logger.info(`[${sellerId}] Requesting pairing code for phone: ${cleanPhone}`);
          const code = await sock.requestPairingCode(cleanPhone);
          pairingCodeRequested.add(sellerId);
          logger.info(`[${sellerId}] Pairing code generated: ${code}`);

          await postToBridge({
            action: 'qr',
            seller_id: sellerId,
            pair_code: code,
          });
        } catch (err) {
          logger.error(`[${sellerId}] Failed to request pairing code:`, err);
        }
      }, 3000);
    }
  }
}

// Polling ya maduka yanayohitaji kuunganishwa (kila sekunde 6)
async function pollSessions() {
  const data = await postToBridge({ action: 'sessions' });
  if (data?.sessions && Array.isArray(data.sessions)) {
    for (const session of data.sessions) {
      if (['pending', 'qr'].includes(session.status)) {
        startSession(session);
      }
    }
  }
}

setInterval(pollSessions, 6000);

const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok', active: activeSockets.size }));
app.listen(PORT, () => {
  logger.info(`WhatsApp Baileys bridge server running on port ${PORT}`);
  pollSessions();
});
