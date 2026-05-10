require('dotenv').config();

const http    = require('http');
const express = require('express');
const path    = require('path');
const { initSchema } = require('./db/schema');
const { startAgent }  = require('./agent');
const apiRouter        = require('./routes/api');
const ws               = require('./services/ws');

const PORT = process.env.PORT || 3000;
const app  = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// API
app.use('/api', apiRouter);

// Demo page — simulated agent cycle for after-hours viewing
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/demo.html'));
});

// Catch-all: serve dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

async function main() {
  // Initialize database schema
  initSchema();

  // Create HTTP server so the WebSocket server can share the same port
  const httpServer = http.createServer(app);

  // Attach WebSocket server to the HTTP server
  ws.init(httpServer);

  // Start listening
  httpServer.listen(PORT, () => {
    console.log(`[server] Neoliberal Struggle running at http://localhost:${PORT}`);
  });

  // Start the agent loop
  startAgent();
}

main().catch(err => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
