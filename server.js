const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const net = require('net');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// PostgreSQL ulanish
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'minecraft_db',
  user: 'postgres',
  password: 'admin',
});

pool.connect((err) => {
  if (err) {
    console.error('PostgreSQL ga ulanishda xatolik:', err.message);
  } else {
    console.log('✅ PostgreSQL ga muvaffaqiyatli ulandi!');
  }
});

// ========== RCON ==========
const RCON_HOST = 'localhost';
const RCON_PORT = 25575;
const RCON_PASSWORD = 'thornrcon123';

let onlinePlayers = 0;

function rconConnect() {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    let reqId = Math.floor(Math.random() * 10000);

    client.connect(RCON_PORT, RCON_HOST, () => {
      // Auth paketi yuborish
      const authPacket = buildRconPacket(reqId, 3, RCON_PASSWORD);
      client.write(authPacket);
    });

    client.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 12) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) break;

        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.slice(12, length + 2).toString('utf8').replace(/\0/g, '');
        buffer = buffer.slice(length + 4);

        if (!authenticated) {
          if (id === -1) {
            client.destroy();
            reject(new Error('RCON auth xato'));
          } else {
            authenticated = true;
            resolve({ client, send: (cmd) => sendCommand(client, reqId, cmd) });
          }
        } else {
          client.emit('rcon_response', body);
        }
      }
    });

    client.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      client.destroy();
      reject(new Error('RCON timeout'));
    }, 5000);
  });
}

function buildRconPacket(id, type, body) {
  const bodyBuf = Buffer.from(body + '\0\0', 'utf8');
  const packet = Buffer.alloc(4 + 4 + 4 + bodyBuf.length);
  packet.writeInt32LE(4 + 4 + bodyBuf.length, 0); // length
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuf.copy(packet, 12);
  return packet;
}

function sendCommand(client, reqId, cmd) {
  return new Promise((resolve) => {
    const packet = buildRconPacket(reqId, 2, cmd);
    client.write(packet);
    client.once('rcon_response', (res) => resolve(res));
    setTimeout(() => resolve(''), 3000);
  });
}

async function updateOnlinePlayers() {
  try {
    const { client, send } = await rconConnect();
    const response = await send('list');
    client.destroy();

    // "There are X of a max of Y players online" formatidan X ni olish
    const match = response.match(/There are (\d+)/);
    if (match) {
      onlinePlayers = parseInt(match[1]);
      console.log(`✅ Online o'yinchilar: ${onlinePlayers}`);
    }
  } catch (err) {
    console.log(`⚠️ RCON ulanmadi: ${err.message}`);
    onlinePlayers = 0;
  }
}

// Har 30 soniyada yangilab turish
updateOnlinePlayers();
setInterval(updateOnlinePlayers, 30000);

// ========== SANA FORMATLOVCHI ==========
function formatDate(timestamp) {
  if (!timestamp) return 'Noma\'lum';
  // AuthMe millisekund saqlaydi
  const ms = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
  if (isNaN(ms) || ms <= 0) return 'Noma\'lum';
  const date = new Date(ms);
  if (date.getFullYear() < 2000 || date.getFullYear() > 2100) return 'Noma\'lum';
  return date.toLocaleDateString('uz-UZ', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ========== API ENDPOINTLAR ==========

// Statistika
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as total FROM authme');
    res.json({
      registered: parseInt(result.rows[0].total),
      online: onlinePlayers
    });
  } catch (err) {
    console.error('Stats xatolik:', err.message);
    res.json({ registered: 0, online: 0 });
  }
});

// O'yinchi qidirish
app.get('/api/player/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const result = await pool.query(
      'SELECT username, regdate, lastlogin, ip FROM authme WHERE username ILIKE $1',
      [username]
    );
    if (result.rows.length === 0) {
      return res.json({ found: false });
    }
    const player = result.rows[0];
    res.json({
      found: true,
      player: {
        ...player,
        regdate_formatted: formatDate(player.regdate),
        lastlogin_formatted: formatDate(player.lastlogin)
      }
    });
  } catch (err) {
    console.error('Player xatolik:', err.message);
    res.json({ found: false });
  }
});

// So'nggi o'yinchilar
app.get('/api/players/recent', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, regdate FROM authme ORDER BY regdate DESC LIMIT 10'
    );
    const players = result.rows.map(p => ({
      ...p,
      regdate_formatted: formatDate(p.regdate)
    }));
    res.json(players);
  } catch (err) {
    console.error('Recent players xatolik:', err.message);
    res.json([]);
  }
});

// Online o'yinchilar ro'yxati (RCON orqali)
app.get('/api/players/online', async (req, res) => {
  try {
    const { client, send } = await rconConnect();
    const response = await send('list');
    client.destroy();
    res.json({ response, online: onlinePlayers });
  } catch (err) {
    res.json({ response: 'RCON ulanmadi', online: 0 });
  }
});

// Bosh sahifa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server ishga tushdi: http://localhost:${PORT}`);
});