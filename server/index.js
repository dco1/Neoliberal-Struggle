require('dotenv').config();

const express = require('express');
const path = require('path');
const { initSchema } = require('./db/schema');
const { startAgent } = require('./agent');
const apiRouter = require('./routes/api');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// API
app.use('/api', apiRouter);

// Catch-all: serve dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

async function main() {
  // Initialize database schema
  initSchema();

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`[server] Neoliberal Struggle running at http://localhost:${PORT}`);
  });

  // Start the agent loop
  startAgent();
}

main().catch(err => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
