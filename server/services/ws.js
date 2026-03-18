// server/services/ws.js
// WebSocket broadcast service.
// Attach to the HTTP server once at startup via init(httpServer).
// Any module can call broadcast(event, data) to push a message to all
// connected clients. The client reconnects automatically on drop.

const { WebSocketServer } = require('ws');

let wss = null;

// ─── Init ──────────────────────────────────────────────────────────────────

// Call once from server/index.js after the HTTP server is created.
function init(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[ws] Client connected (${ip})`);

    ws.on('close', () => {
      console.log(`[ws] Client disconnected (${ip})`);
    });

    ws.on('error', (err) => {
      console.warn(`[ws] Client error (${ip}):`, err.message);
    });

    // Send a hello so the client knows the socket is live
    send(ws, 'connected', { message: 'WebSocket connected' });
  });

  console.log('[ws] WebSocket server attached to HTTP server');
}

// ─── Broadcast ─────────────────────────────────────────────────────────────

// Broadcast a typed event to every connected client.
// event  — string label, e.g. 'cycle_complete', 'log_entry', 'summary'
// data   — any JSON-serialisable payload
function broadcast(event, data = {}) {
  if (!wss) return;

  const payload = JSON.stringify({ event, data, ts: Date.now() });
  let sent = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
      sent++;
    }
  });

  // Log broadcast (omit high-frequency log_entry to avoid noise)
  if (event !== 'log_entry') {
    console.log(`[ws] broadcast '${event}' → ${sent} client(s)`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Send a message to a single client.
function send(ws, event, data = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event, data, ts: Date.now() }));
}

// Return connected client count (useful for debug logging).
function clientCount() {
  return wss ? wss.clients.size : 0;
}

module.exports = { init, broadcast, clientCount };
