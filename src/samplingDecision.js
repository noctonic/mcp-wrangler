// samplingDecision.js
// In-memory registry for MCP sampling decision requests
const EventEmitter = require('events');
const emitter = new EventEmitter();

/**
 * Register a one-time listener for a sampling request
 * @param {string} id - Request identifier
 * @param {function} resolve - Resolve callback
 * @param {function} reject - Reject callback
 */
function once(id, resolve, reject) {
  const handler = (approved) => {
    emitter.removeListener(id, handler);
    if (approved) resolve(true);
    else reject(false);
  };
  emitter.once(id, handler);
}

/**
 * Resolve a sampling request by emitting decision
 * @param {string} id
 * @param {boolean} approved
 * @returns {boolean} - True if listener existed
 */
function resolve(id, approved) {
  const has = emitter.listenerCount(id) > 0;
  if (has) emitter.emit(id, approved);
  return has;
}

module.exports = { once, resolve };