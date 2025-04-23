// tasks.js
// Manages active tasks and provides utilities to create, list, and cancel them
const activeTasks = new Map();

/**
 * Create and register a new task
 * @param {string|number} token - Unique progress token
 * @param {string} description - Task description
 * @param {AbortController} controller - Controller to cancel the task
 */
function createTask(token, description, controller) {
  activeTasks.set(token, { token, description, status: 'running', controller });
}

/**
 * Update status of an existing task
 * @param {string|number} token - Task identifier
 * @param {string} status - New status (e.g., 'complete', 'error')
 */
function updateTaskStatus(token, status) {
  const task = activeTasks.get(token);
  if (!task) return;
  task.status = status;
}

/**
 * List all registered tasks
 * @returns {Array<{token: string|number, description: string, status: string}>}
 */
function listTasks() {
  return Array.from(activeTasks.values()).map(({ token, description, status }) => ({ token, description, status }));
}

/**
 * Cancel a running task
 * @param {string|number} token - Task identifier
 * @param {string} [reason] - Optional cancel reason
 * @returns {boolean} - True if task found and cancelled
 */
function cancelTask(token, reason) {
  const task = activeTasks.get(token);
  if (!task) return false;
  try {
    task.controller.abort(reason);
  } catch {};
  task.status = 'cancelled';
  return true;
}

module.exports = { createTask, updateTaskStatus, listTasks, cancelTask };