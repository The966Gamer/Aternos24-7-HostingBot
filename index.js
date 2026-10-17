'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080; // Swapped to 8080 to match your log layout

let bot = null;
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let movementIntervals = [];

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: []
};

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ----------------------------------------------------
// Web Dashboard Panel
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          @import url('https://googleapis.com');
          :root {
            --bg: #0f172a; --container-bg: #111827; --card-bg: #1f2937;
            --accent: #2dd4bf; --text-main: #f8fafc; --text-dim: #94a3b8;
          }
          body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
          .container { background: var(--container-bg); padding: 3rem 2rem; border-radius: 2rem; width: 420px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); border: 1px solid #1f2937; text-align: center; }
          h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 2.5rem; color: #f1f5f9; }
          .card { background: var(--card-bg); border-radius: 1rem; padding: 1.25rem 1.75rem; margin-bottom: 1rem; text-align: left; border-left: 4px solid var(--accent); }
          .label { font-size: 0.75rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
          .value { font-size: 1.25rem; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 0.5rem; }
          .dot { width: 12px; height: 12px; border-radius: 50%; background: #4ade80; display: inline-block; box-shadow: 0 0 10px #4ade80; }
          .dot.offline { background: #f87171; box-shadow: 0 0 10px #f87171; }
          .pulse { animation: pulse 2s infinite; }
          @keyframes pulse { 0% { transform: scale(0.95); } 70% { transform: scale(1); } 100% { transform: scale(0.95); } }
          .footer { margin-top: 1.5rem; font-size: 0.8125rem; color: #4b5563; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${config.name}</h1>
          <div class="card">
            <div class="label">Bot Username</div>
            <div class="value" style="color:#e2e8f0;">${config['bot-account'].username}</div>
          </div>
          <div class="card">
            <div class="label">Status</div>
            <div class="value"><span id="status-dot" class="dot pulse"></span><span id="status-text">Connecting...</span></div>
          </div>
          <div class="card">
            <div class="label">Server Link</div>
            <div class="value" style="font-size:1.1rem;color:#5eead4;">${config.server.ip}:${config.server.port}</div>
          </div>
          <div class="card">
            <div class="label">Coordinates</div>
            <div class="value" id="coords-text">Syncing...</div>
          </div>
          <div class="footer">Auto-refreshing monitoring grid</div>
        </div>
        <script>
          async function update() {
            try {
              const r = await fetch('/health');
              const d = await r.json();
              document.getElementById('status-text').innerText = d.status === 'connected' ? 'Online & Active' : 'Reconnecting...';
              document.getElementById('status-dot').className = d.status === 'connected' ? 'dot pulse' : 'dot offline pulse';
              document.getElementById('coords-text').innerText = d.coords ? Math.floor(d.coords.x) + ', ' + Math.floor(d.coords.y) + ', ' + Math.floor(d.coords.z) : 'Loading...';
            } catch (e) {}
          }
          setInterval(update, 3000);
          update();
        </script>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    coords: botState.connected && bot && bot.entity ? bot.entity.position : null
  });
});

// ----------------------------------------------------
// Core Mineflayer Mechanics Execution Loop
// ----------------------------------------------------
function initBot() {
  if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
  console.log(`[Connecting] Attempting login for: ${config['bot-account'].username}`);

  const cleanUsername = config['bot-account'].username.trim().replace(/[^a-zA-Z0-9_]/g, '');

  bot = mineflayer.createBot({
    host: config.server.ip,
    port: config.server.port || 25565,
    username: cleanUsername,
    version: config.server.version || false,
    auth: config['bot-account'].type === 'offline' ? 'offline' : 'microsoft'
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    botState.connected = true;
    console.log(`[Spawned] ${bot.username} joined successfully. Downloading chunks...`);

    // SAFETY CHECK: Ensure bot exists before executing auth commands
    if (config.utils['auto-auth'].enabled) {
      setTimeout(() => {
        if (!bot || !botState.connected) return; // Crash prevention catch
        bot.chat(`/register ${config.utils['auto-auth'].password} ${config.utils['auto-auth'].password}`);
        bot.chat(`/login ${config.utils['auto-auth'].password}`);
      }, 1500);
    }

    // Safely delay custom AI ticks to prevent packet rate kicks during login loading
    setTimeout(() => {
      if (!bot || !botState.connected) return;
      console.log('[Active] Bot chunk sync settled. Activating movements.');

      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);

      startBehaviorLoops();
    }, 4000);
  });

  bot.on('error', (err) => {
    console.error('[Error Details]:', err.message);
    handleDisconnect();
  });

  bot.on('end', (reason) => {
    console.log(`[Offline] Socket terminated. Reason: ${reason}`);
    handleDisconnect();
  });
}

// ----------------------------------------------------
// Anti-AFK Engine Behaviors
// ----------------------------------------------------
function startBehaviorLoops() {
  clearBehaviorLoops();

  // 1. Text Message Broadcasting Engine Loop
  if (config.utils['chat-messages'].enabled) {
    let msgIdx = 0;
    const chatInt = setInterval(() => {
      if (!bot || !botState.connected) return;
      const msgs = config.utils['chat-messages'].messages;
      bot.chat(msgs[msgIdx]);
      msgIdx = (msgIdx + 1) % msgs.length;
    }, config.utils['chat-messages']['repeat-delay'] * 1000);
    movementIntervals.push(chatInt);
  }

  // 2. Head Rotation Looking Engine Loop
  if (config.movement.enabled && config.movement['look-around'].enabled) {
    const lookInt = setInterval(() => {
      if (!bot || !botState.connected) return;
      const yaw = (Math.random() * 360 - 180) * (Math.PI / 180);
      const pitch = (Math.random() * 90 - 45) * (Math.PI / 180);
      bot.look(yaw, pitch, true);
    }, config.movement['look-around'].interval);
    movementIntervals.push(lookInt);
  }

  // 3. Jump Execution Trigger Loop
  if (config.movement.enabled && config.movement['random-jump'].enabled) {
    const jumpInt = setInterval(() => {
      if (!bot || !botState.connected || !bot.entity.onGround) return;
      bot.setControlState('jump', true);
      setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 500);
    }, config.movement['random-jump'].interval);
    movementIntervals.push(jumpInt);
  }

  // 4. Circle-Walking Physics Framework
  if (config.movement.enabled && config.movement['circle-walk'].enabled) {
    let angle = 0;
    const walkInt = setInterval(() => {
      if (!bot || !botState.connected) return;
      bot.setControlState('forward', true);
      angle += 0.2;
      bot.look(angle, 0, true);
    }, 150);
    movementIntervals.push(walkInt);
  }
}

function deleteConfigTimers() {
  // Safe helper to empty background triggers
  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
}

function clearBehaviorLoops() {
  movementIntervals.forEach(clearInterval);
  movementIntervals = [];
  if (bot) {
    try { bot.clearControlStates(); } catch (e) {}
  }
}

function handleDisconnect() {
  botState.connected = false;
  clearBehaviorLoops();

  if (bot) {
    bot.removeAllListeners();
    bot = null;
  }

  if (!isReconnecting) {
    isReconnecting = true;
    const delay = config.utils['auto-reconnect-delay'] || 5000;
    console.log(`[Cooldown] Reconnecting in ${delay / 1000} seconds...`);

    reconnectTimeoutId = setTimeout(() => {
      isReconnecting = false;
      initBot();
    }, delay);
  }
}

app.listen(PORT, () => {
  console.log(`[System Online] Web UI dashboard operating at port ${PORT}`);
  initBot();
});
