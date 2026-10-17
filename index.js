'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

let bot = null;
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let chatIntervalId = null;
let isReconnecting = false;
let lastHealth = 20;

let botState = {
  connected: false,
  startTime: Date.now(),
  reconnectAttempts: 0
};

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
          <div class="footer">Defensive Combat AFK Dashboard</div>
        </div>
        <script>
          async function update() {
            try {
              const r = await fetch('/health');
              const d = await r.json();
              document.getElementById('status-text').innerText = d.status === 'connected' ? 'Online & Guarding' : 'Reconnecting...';
              document.getElementById('status-dot').className = d.status === 'connected' ? 'dot pulse' : 'dot offline pulse';
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
  res.json({ status: botState.connected ? 'connected' : 'disconnected' });
});

// ----------------------------------------------------
// Core Mineflayer Handshake & Retaliation Modules
// ----------------------------------------------------
function initBot() {
  if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
  console.log(`[Connecting] Initializing reactive combat guard for: ${config['bot-account'].username}`);

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
    botState.reconnectAttempts = 0;
    bot.clearControlStates();
    
    if (bot.entity) lastHealth = bot.health;
    console.log(`[Spawned] ${bot.username} standing guard. Movement restricted until attacked.`);

    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);

    // Handle authentication hooks safely
    if (config.utils['auto-auth'].enabled) {
      setTimeout(() => {
        if (!bot || !botState.connected) return;
        bot.chat(`/register ${config.utils['auto-auth'].password} ${config.utils['auto-auth'].password}`);
        bot.chat(`/login ${config.utils['auto-auth'].password}`);
      }, 2000);
    }

    // Server-keeping anti-AFK chat broadcasts
    if (config.utils['chat-messages'].enabled) {
      if (chatIntervalId) clearInterval(chatIntervalId);
      let msgIdx = 0;
      chatIntervalId = setInterval(() => {
        if (!bot || !botState.connected) return;
        const msgs = config.utils['chat-messages'].messages;
        bot.chat(msgs[msgIdx]);
        msgIdx = (msgIdx + 1) % msgs.length;
      }, config.utils['chat-messages']['repeat-delay'] * 1000);
    }
  });

  // COMBAT TRIGGER MODULE
  bot.on('health', () => {
    if (!bot || !bot.entity) return;

    // Trigger action only if health drops from taking hits [1]
    if (bot.health < lastHealth) {
      console.log(`[Alert] Damage taken! Current Health: ${bot.health}. Engaging counter-strike...`);
      retaliate();
    }
    lastHealth = bot.health;
  });

  bot.on('error', (err) => {
    console.error('[Exception Engine]:', err.message);
    handleDisconnect();
  });

  bot.on('end', (reason) => {
    console.log(`[Connection Dropped]: ${reason}`);
    handleDisconnect();
  });
}

// ----------------------------------------------------
// Targeted Combat Self-Defense Framework
// ----------------------------------------------------
function retaliate() {
  if (!bot || !botState.connected) return;

  // Search a 12-block target radius for what hit it [1]
  const target = bot.nearestEntity((entity) => {
    return (entity.type === 'mob' || entity.type === 'player') && entity.position.distanceTo(bot.entity.position)  retaliate(), 600);
  } else {
    // Pathfind dash to close distance if they distance themselves [1]
    console.log(`[Closing Gap] Moving toward target at: ${Math.floor(target.position.x)}, ${Math.floor(target.position.z)}`);
    
    const goal = new GoalBlock(Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z));
    bot.pathfinder.setGoal(goal);

    // Halt movement and freeze again after 2.5s max
    setTimeout(() => {
      if (bot && botState.connected) {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        retaliate();
      }
    }, 2500);
  }
}

function handleDisconnect() {
  botState.connected = false;
  if (chatIntervalId) {
    clearInterval(chatIntervalId);
    chatIntervalId = null;
  }

  if (bot) {
    bot.pathfinder.setGoal(null);
    bot.removeAllListeners();
    bot = null;
  }

  if (!isReconnecting) {
    isReconnecting = true;
    botState.reconnectAttempts++;
    
    const configDelay = config.utils['auto-reconnect-delay'] || 5000;
    const maxDelay = config.utils['max-reconnect-delay'] || 120000;
    const currentDelay = Math.min(configDelay * botState.reconnectAttempts, maxDelay);

    console.log(`[Offline] Retrying connection loop in ${currentDelay / 1000} seconds...`);

    reconnectTimeoutId = setTimeout(() => {
      isReconnecting = false;
      initBot();
    }, currentDelay);
  }
}

app.listen(PORT, () => {
  console.log(`[System Online] Dashboard active on port ${PORT}`);
  initBot();
});
