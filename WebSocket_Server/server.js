const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map(); // roomCode -> Set of sockets and metadata

function broadcastToRoom(roomCode, message, exceptSocket = null) {
  const r = rooms.get(roomCode);
  if (!r) return;
  const str = JSON.stringify(message);
  for (const meta of r.sockets) {
    if (meta.socket !== exceptSocket && meta.socket.readyState === WebSocket.OPEN) {
      meta.socket.send(str);
    }
  }
}

function makeRoomIfMissing(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { sockets: new Set() });
  }
}

wss.on('connection', (ws) => {
  ws.meta = { room: null, player_id: null, player_name: null };

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === 'join') {
      const room = ('' + (data.room_code || '')).toUpperCase();
      if (!room || room.length !== 4) {
        ws.send(JSON.stringify({ type: 'error', message: 'Code invalide' }));
        return;
      }
      makeRoomIfMissing(room);
      const player_id = data.player_id || (Math.random() * 1e9).toFixed(0);
      const player_name = data.player_name || 'anonymous';

      // store meta with socket reference
      const meta = { socket: ws, player_id, player_name };
      ws.meta.room = room;
      ws.meta.player_id = player_id;
      ws.meta.player_name = player_name;

      rooms.get(room).sockets.add(meta);

      // send joined confirmation with player list
      const players = Array.from(rooms.get(room).sockets).map(m => ({ id: m.player_id, name: m.player_name }));
      ws.send(JSON.stringify({ type: 'joined', players }));

      broadcastToRoom(room, { type: 'player_joined', player: { id: player_id, name: player_name } }, ws);
      return;
    }

    const room = ws.meta.room;
    if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Not joined to any room' })); return; }

    if (data.type === 'chat') {
      broadcastToRoom(room, { type: 'chat', player_name: ws.meta.player_name, message: data.message });
    }

    if (data.type === 'input') {
      // echo input to room (game server or host would consume in a real setup)
      broadcastToRoom(room, { type: 'input', player_id: ws.meta.player_id, state: data.state }, ws);
    }

    if (data.type === 'use_item') {
      broadcastToRoom(room, { type: 'use_item', player_id: ws.meta.player_id, item: data.item });
    }

    if (data.type === 'start') {
      broadcastToRoom(room, { type: 'start' });
    }
  });

  ws.on('close', () => {
    const meta = ws.meta;
    if (meta && meta.room) {
      const r = rooms.get(meta.room);
      if (r) {
        // remove any meta entries whose socket is this ws
        const newSet = new Set(Array.from(r.sockets).filter(m => m.socket !== ws));
        r.sockets = newSet;
        broadcastToRoom(meta.room, { type: 'player_left', player_id: meta.player_id });
        if (r.sockets.size === 0) rooms.delete(meta.room);
      }
    }
  });
});

// Make sure stored meta objects contain socket references for easy management
// (ws.meta stored for each socket when joining)

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`WebSocket server listening on ${PORT}`));
