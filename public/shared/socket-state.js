// Thin wrapper around the Socket.IO client for connecting to the booth
// state stream and sending actions. Served locally, no CDN.
// Assumes /socket.io/socket.io.js has been loaded as a classic script
// before this module runs (it defines window.io).

let socket = null;
const listeners = new Set();
let latestState = null;

export function connectSocket() {
  if (socket) return socket;
  socket = window.io({ secure: true, transports: ['websocket', 'polling'] });
  socket.on('state', (state) => {
    latestState = state;
    for (const listener of listeners) listener(state);
  });
  return socket;
}

export function onState(listener) {
  listeners.add(listener);
  if (latestState) listener(latestState);
  return () => listeners.delete(listener);
}

export function onEvent(eventName, listener) {
  const s = connectSocket();
  s.on(eventName, listener);
  return () => s.off(eventName, listener);
}

export function sendAction(type, payload = {}) {
  const s = connectSocket();
  s.emit('action', { type, payload });
}

export function getLatestState() {
  return latestState;
}
