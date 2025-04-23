// sse.js
// Manages Server-Sent Event (SSE) clients and broadcasts updates
const sseClients = [];

/**
 * Initialize SSE endpoints on the given Express app
 * @param {object} app - Express application
 */
function initSSE(app) {
  app.get('/updates', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
  });
}

/**
 * Broadcast an event and data payload to all connected SSE clients
 * @param {string} event - Event name
 * @param {object} data - Data to send
 */
function broadcastUpdate(event, data) {
  const payload = JSON.stringify(data);
  sseClients.forEach(res => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload}\n\n`);
  });
}

module.exports = { initSSE, broadcastUpdate };