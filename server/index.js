import 'dotenv/config';
import { fishCatalog } from '../public/assets/fish/catalog.js';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true } });
const PORT = Number(process.env.PORT || 3000);
const WORLD = { width: 2600, height: 1800 };
const fish = new Map();
const pellets = new Map();
const creatures = new Map();
const shells = new Map();
const leaderboard = new Map();
const fishCatalogById = new Map(fishCatalog.map((item) => [item.id, item]));
let db = null;
let firebaseAuth = null;
let saveChain = Promise.resolve();

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    const serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    firebaseAuth = admin.auth();
    const snapshot = await db.collection('leaderboard').orderBy('bestScore', 'desc').limit(100).get();
    snapshot.forEach((doc) => leaderboard.set(doc.id, doc.data()));
    console.log('Leaderboard connected to Firestore.');
  }
} catch (error) {
  console.error('Firebase setup failed; using local leaderboard storage:', error.message);
}

if (!db) {
  const dataDir = path.join(here, 'data');
  await mkdir(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'leaderboard.json'), 'utf8'));
    for (const entry of saved) leaderboard.set(entry.uid, entry);
  } catch { /* first run */ }
}

const colors = ['#ff7b54', '#52c7a5', '#f6c85f', '#8c7bff', '#ff74a7', '#53a8ff', '#b9df69'];
function random(min, max) { return min + Math.random() * (max - min); }
function movementSpeed(player) { return Math.max(1.8, 4.8 - player.r * 0.012); }
function safeName(value) { return String(value || 'Thủy thủ').trim().slice(0, 18) || 'Thủy thủ'; }
function weekKey(date = new Date()) {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - day + 1);
  return monday.toISOString().slice(0, 10);
}
function createPellet() {
  const id = `p-${Math.random().toString(36).slice(2)}`;
  pellets.set(id, { id, x: random(30, WORLD.width - 30), y: random(30, WORLD.height - 30), r: random(4, 8), color: colors[Math.floor(Math.random() * colors.length)] });
}
for (let i = 0; i < 420; i++) createPellet();

const creatureTypes = {
  minnow: { name: 'Cá nhỏ', sprites: ['goldfish', 'blue_tang', 'pink_fish', 'clownfish_orange', 'butterflyfish', 'ice_blue_fish'], r: 13, hostile: false, speed: 1.5, damage: 0, score: 30, coins: 3 },
  jellyfish: { name: 'Cá mao tiên', sprite: 'lionfish', r: 26, hostile: true, speed: 2.2, damage: 10, score: 55, coins: 6 },
  shark: { name: 'Cá mập', sprite: 'anglerfish_boss', r: 40, hostile: true, speed: 2.8, damage: 18, score: 100, coins: 12 },
  octopus: { name: 'Bạch tuộc khổng lồ', sprite: 'octopus_boss', r: 82, hostile: true, boss: true, speed: 3.2, damage: 32, attackCooldown: 1350, score: 400, coins: 40 },
};
const difficulty = { sharkIntervalMs: 40000, maxExtraSharks: 4, bossWarningMs: 85000, bossSpawnMs: 90000, bossLifetimeMs: 45000 };
function spawnCreature(type, options = {}) {
  const definition = creatureTypes[type];
  const { sprites, ...attributes } = definition;
  const sprite = sprites ? sprites[Math.floor(Math.random() * sprites.length)] : definition.sprite;
  const creature = { id: `c-${Math.random().toString(36).slice(2)}`, type, ...attributes, sprite, x: options.x ?? random(40, WORLD.width - 40), y: options.y ?? random(40, WORLD.height - 40), targetX: random(40, WORLD.width - 40), targetY: random(40, WORLD.height - 40), targetSocketId: options.targetSocketId || null, expiresAt: options.lifetimeMs ? Date.now() + options.lifetimeMs : null, wanderAt: 0, lastAttackAt: 0 };
  creatures.set(creature.id, creature);
}
function spawnShell() {
  const shell = { id: `s-${Math.random().toString(36).slice(2)}`, x: random(40, WORLD.width - 40), y: random(40, WORLD.height - 40), r: 16 };
  shells.set(shell.id, shell);
}
for (let i = 0; i < 18; i++) spawnCreature('minnow');
for (let i = 0; i < 5; i++) spawnCreature('jellyfish');
for (let i = 0; i < 3; i++) spawnCreature('shark');
for (let i = 0; i < 14; i++) spawnShell();

async function persistPlayer(player) {
  const current = leaderboard.get(player.uid) || { uid: player.uid, name: player.name, bestScore: 0, totalScore: 0, games: 0, xp: 0, level: 1, updatedAt: Date.now() };
  const score = Math.floor(player.score);
  const finishedAt = Date.now();
  const activeWeek = weekKey(new Date(finishedAt));
  const next = { ...current, name: player.name, bestScore: Math.max(current.bestScore, score), totalScore: current.totalScore + score, games: current.games + 1, xp: current.xp + score, weekScore: current.weekKey === activeWeek ? (current.weekScore || 0) + score : score, weekKey: activeWeek, coins: (player.coins ?? current.coins ?? 0) + Math.floor(score / 10), pearls: player.pearls ?? current.pearls ?? 0, skin: player.skin, unlockedSkins: player.unlockedSkins || ['default'], recentMatches: [{ score, coins: Math.floor(score / 10), finishedAt }, ...(current.recentMatches || [])].slice(0, 20), updatedAt: finishedAt };
  next.level = Math.floor(next.xp / 500) + 1;
  leaderboard.set(player.uid, next);
  saveChain = saveChain.then(async () => {
    if (db) {
      const match = { uid: player.uid, name: player.name, score, coinsEarned: Math.floor(score / 10), skin: player.skin, finishedAt: Date.now() };
      const batch = db.batch();
      const matchRef = db.collection('matches').doc();
      batch.set(db.collection('leaderboard').doc(player.uid), next, { merge: true });
      batch.set(db.collection('users').doc(player.uid), { uid: player.uid, name: player.name, skin: player.skin, unlockedSkins: next.unlockedSkins, coins: next.coins, pearls: next.pearls, xp: next.xp, level: next.level, bestScore: next.bestScore, totalScore: next.totalScore, games: next.games, weekScore: next.weekScore, weekKey: next.weekKey, recentMatches: next.recentMatches, updatedAt: next.updatedAt }, { merge: true });
      batch.set(db.collection('scores').doc(matchRef.id), { ...match, matchId: matchRef.id });
      batch.set(matchRef, { ...match, matchId: matchRef.id });
      await batch.commit();
    }
    else await writeFile(path.join(here, 'data', 'leaderboard.json'), JSON.stringify([...leaderboard.values()], null, 2));
  }).catch((error) => console.error('Leaderboard save failed:', error.message));
  await saveChain;
  player.coins = next.coins;
  player.unlockedSkins = next.unlockedSkins;
  return next;
}
async function savePlayerProfile(player) {
  const current = leaderboard.get(player.uid) || { uid: player.uid, name: player.name, bestScore: 0, totalScore: 0, games: 0, xp: 0, level: 1, coins: 120, pearls: 0, unlockedSkins: ['default'] };
  const next = { ...current, name: player.name, coins: player.coins, pearls: player.pearls ?? 0, skin: player.skin, unlockedSkins: player.unlockedSkins, updatedAt: Date.now() };
  leaderboard.set(player.uid, next);
  saveChain = saveChain.then(async () => {
    if (db) {
      const batch = db.batch();
      batch.set(db.collection('leaderboard').doc(player.uid), next, { merge: true });
      batch.set(db.collection('users').doc(player.uid), { uid: player.uid, name: player.name, skin: player.skin, unlockedSkins: player.unlockedSkins, coins: player.coins, pearls: next.pearls, updatedAt: next.updatedAt }, { merge: true });
      await batch.commit();
    } else await writeFile(path.join(here, 'data', 'leaderboard.json'), JSON.stringify([...leaderboard.values()], null, 2));
  }).catch((error) => console.error('Profile save failed:', error.message));
  await saveChain;
}
function profilePayload(player) {
  const record = leaderboard.get(player.uid) || {};
  return { coins: player.coins, pearls: player.pearls ?? 0, unlockedSkins: player.unlockedSkins || ['default'], skin: player.skin, xp: record.xp || 0, level: record.level || 1, bestScore: record.bestScore || 0, games: record.games || 0, recentMatches: record.recentMatches || [] };
}
function sendProfile(socket, player) { socket.emit('profileData', profilePayload(player)); }
async function eliminatePlayer(player, by) {
  if (player.dead) return;
  player.dead = true; fish.delete(player.socketId);
  const socket = io.sockets.sockets.get(player.socketId);
  if (!socket) { await persistPlayer(player); return; }
  socket.emit('eaten', { by, score: player.score });
  await persistPlayer(player);
  if (socket.connected) { sendProfile(socket, player); socket.disconnect(true); }
}
function sendLeaderboard(socket) {
  socket.emit('leaderboard', [...leaderboard.values()].sort((a, b) => b.bestScore - a.bestScore).slice(0, 100));
}
function snapshot() {
  return {
    players: [...fish.values()].map((player) => ({ uid: player.uid, name: player.name, x: player.x, y: player.y, r: player.r, score: player.score, color: player.color, skin: player.skin, health: player.health, maxHealth: player.maxHealth, speed: Math.round(movementSpeed(player) * 20) })),
    pellets: [...pellets.values()],
    creatures: [...creatures.values()].map(({ id, type, name, sprite, x, y, r, hostile, boss }) => ({ id, type, name, sprite, x, y, r, hostile, boss: Boolean(boss) })),
    shells: [...shells.values()],
  };
}

app.use(express.static(path.join(root, 'public')));
app.get('/api/leaderboard', (_req, res) => res.json([...leaderboard.values()].sort((a, b) => b.bestScore - a.bestScore).slice(0, 100)));
app.get('/api/config', (_req, res) => res.json({ firebase: process.env.FIREBASE_WEB_CONFIG ? JSON.parse(process.env.FIREBASE_WEB_CONFIG) : null }));

io.use(async (socket, next) => {
  const identity = socket.handshake.auth || {};
  if (firebaseAuth && identity.token) {
    try { socket.data.identity = await firebaseAuth.verifyIdToken(identity.token); next(); }
    catch { next(new Error('Invalid sign-in token.')); }
  } else {
    // A browser without Firebase credentials can still play as a temporary guest.
    const guestUid = String(identity.uid || '');
    socket.data.identity = { uid: /^guest-[\w-]{8,100}$/.test(guestUid) ? guestUid : `guest-${socket.id}` };
    next();
  }
});

io.on('connection', async (socket) => {
  const identity = socket.handshake.auth || {};
  const uid = String(socket.data.identity.uid || `guest-${socket.id}`).slice(0, 128);
  const name = safeName(identity.name || socket.data.identity.name);
  let existing = leaderboard.get(uid);
  if (!existing && db) {
    try {
      const profile = await db.collection('users').doc(uid).get();
      if (profile.exists) { existing = { ...profile.data(), uid }; leaderboard.set(uid, existing); }
    } catch (error) { console.error('Profile load failed:', error.message); }
  }
  if (!socket.connected) return;
  const player = { uid, socketId: socket.id, name, x: random(500, WORLD.width - 500), y: random(400, WORLD.height - 400), r: 22, score: 0, health: 100, maxHealth: 100, lastDamageAt: 0, lastHitAt: 0, lastRegenAt: 0, active: false, protectedUntil: 0, matchElapsedMs: 0, startedAt: null, extraSharks: 0, bossWarningSent: false, bossSpawned: false, color: colors[Math.floor(Math.random() * colors.length)], skin: 'default', targetX: null, targetY: null, lastInput: 0 };
  if (existing?.skin) player.skin = existing.skin;
  fish.set(socket.id, player);
  player.coins = existing?.coins ?? 120;
  player.pearls = existing?.pearls ?? 0;
  player.unlockedSkins = existing?.unlockedSkins || ['default'];
  if (!player.unlockedSkins.includes('default')) player.unlockedSkins.unshift('default');
  if (!player.unlockedSkins.includes(player.skin)) player.skin = 'default';
  socket.emit('welcome', { uid, world: WORLD, playerId: socket.id, score: player.score, profile: profilePayload(player) });
  socket.emit('state', snapshot());
  sendLeaderboard(socket);
  socket.broadcast.emit('notice', `${name} đã xuống biển!`);

  socket.on('move', (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const now = Date.now();
    if (now - player.lastInput < 25) return;
    player.lastInput = now;
    player.targetX = Math.max(0, Math.min(WORLD.width, point.x));
    player.targetY = Math.max(0, Math.min(WORLD.height, point.y));
  });
  socket.on('startGame', () => {
    if (!player.active) { player.startedAt = Date.now(); player.protectedUntil = player.startedAt + 3000; }
    player.active = true;
  });
  socket.on('pauseGame', () => {
    if (player.active && player.startedAt != null) player.matchElapsedMs += Date.now() - player.startedAt;
    player.startedAt = null; player.active = false;
  });
  socket.on('profile', (profile) => {
    player.name = safeName(profile?.name || player.name);
    if (fishCatalogById.has(profile?.skin) && player.unlockedSkins.includes(profile.skin)) player.skin = profile.skin;
    sendProfile(socket, player);
  });
  socket.on('buySkin', async (skinId) => {
    const fishSkin = fishCatalogById.get(skinId);
    if (!fishSkin) return;
    if (player.unlockedSkins.includes(skinId)) { player.skin = skinId; await savePlayerProfile(player); sendProfile(socket, player); return; }
    if (!fishSkin.price || player.coins < fishSkin.price) { socket.emit('shopError', 'Bạn chưa có đủ xu.'); return; }
    player.coins -= fishSkin.price; player.unlockedSkins.push(skinId); player.skin = skinId;
    await savePlayerProfile(player);
    sendProfile(socket, player);
  });
  socket.on('getLeaderboard', () => sendLeaderboard(socket));
  socket.on('getHistory', () => {
    const record = leaderboard.get(uid);
    socket.emit('history', record?.recentMatches || []);
  });
  socket.on('disconnect', async () => {
    const finalPlayer = fish.get(socket.id);
    fish.delete(socket.id);
    if (finalPlayer?.score > 0) await persistPlayer(finalPlayer);
    io.emit('notice', `${player.name} đã rời đại dương.`);
    io.emit('leaderboard', [...leaderboard.values()].sort((a, b) => b.bestScore - a.bestScore).slice(0, 100));
  });
});

setInterval(async () => {
  const now = Date.now();
  for (const player of fish.values()) {
    if (player.dead) continue;
    if (player.active && player.startedAt != null) {
      const elapsed = player.matchElapsedMs + now - player.startedAt;
      const extraSharksDue = Math.min(difficulty.maxExtraSharks, Math.floor(elapsed / difficulty.sharkIntervalMs));
      while (player.extraSharks < extraSharksDue) {
        const angle = random(0, Math.PI * 2); const distance = random(480, 700);
        const x = Math.max(40, Math.min(WORLD.width - 40, player.x + Math.cos(angle) * distance));
        const y = Math.max(40, Math.min(WORLD.height - 40, player.y + Math.sin(angle) * distance));
        spawnCreature('shark', { targetSocketId: player.socketId, x, y }); player.extraSharks++;
        io.to(player.socketId).emit('notice', 'Một cá mập mới đang truy đuổi bạn!');
      }
      if (elapsed >= difficulty.bossWarningMs && !player.bossWarningSent) {
        player.bossWarningSent = true;
        io.to(player.socketId).emit('notice', 'Cảnh báo: Bạch tuộc khổng lồ xuất hiện sau 5 giây!');
      }
      if (elapsed >= difficulty.bossSpawnMs && !player.bossSpawned) {
        player.bossSpawned = true;
        const angle = random(0, Math.PI * 2); const distance = random(520, 700);
        const x = Math.max(50, Math.min(WORLD.width - 50, player.x + Math.cos(angle) * distance));
        const y = Math.max(50, Math.min(WORLD.height - 50, player.y + Math.sin(angle) * distance));
        spawnCreature('octopus', { targetSocketId: player.socketId, x, y, lifetimeMs: difficulty.bossLifetimeMs });
        io.to(player.socketId).emit('notice', 'Bạch tuộc khổng lồ đã xuất hiện! Hãy tránh xa nó!');
      }
    }
    if (player.targetX != null) {
      const dx = player.targetX - player.x; const dy = player.targetY - player.y;
      const distance = Math.hypot(dx, dy);
      const speed = movementSpeed(player);
      if (distance > 1) { player.x += (dx / distance) * Math.min(speed, distance); player.y += (dy / distance) * Math.min(speed, distance); }
    }
    for (const [id, pellet] of pellets) {
      if (Math.hypot(pellet.x - player.x, pellet.y - player.y) < player.r + pellet.r) {
        pellets.delete(id); player.score += 10; player.r = Math.min(82, 22 + Math.sqrt(player.score) * 0.78); createPellet();
      }
    }
    if (player.health < player.maxHealth && now - player.lastDamageAt > 4500 && now - player.lastRegenAt > 1000) {
      player.health = Math.min(player.maxHealth, player.health + 2); player.lastRegenAt = now;
    }
    for (const shell of [...shells.values()]) {
      if (Math.hypot(shell.x - player.x, shell.y - player.y) >= player.r + shell.r) continue;
      shells.delete(shell.id); player.pearls += 1;
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) { sendProfile(playerSocket, player); playerSocket.emit('pearlFound', { pearls: player.pearls }); }
      await savePlayerProfile(player);
      const timer = setTimeout(spawnShell, 20000); timer.unref?.();
    }
  }
  for (const creature of creatures.values()) {
    if (creature.expiresAt && now >= creature.expiresAt) {
      creatures.delete(creature.id);
      const ownerSocket = creature.targetSocketId && io.sockets.sockets.get(creature.targetSocketId);
      if (creature.boss && ownerSocket) ownerSocket.emit('notice', 'Bạch tuộc khổng lồ đã rời đi.');
      continue;
    }
    let target = null; let targetDistance = creature.boss ? 950 : 520;
    if (creature.hostile) {
      const assignedPlayer = creature.targetSocketId && fish.get(creature.targetSocketId);
      const targets = assignedPlayer?.active ? [assignedPlayer] : fish.values();
      for (const player of targets) {
        if (player.dead || !player.active || player.r >= creature.r * 1.2) continue;
        const distance = Math.hypot(player.x - creature.x, player.y - creature.y);
        if (distance < targetDistance) { target = player; targetDistance = distance; }
      }
    }
    if (target) { creature.targetX = target.x; creature.targetY = target.y; }
    else if (now >= creature.wanderAt) {
      creature.targetX = random(30, WORLD.width - 30); creature.targetY = random(30, WORLD.height - 30); creature.wanderAt = now + random(2500, 6000);
    }
    const dx = creature.targetX - creature.x; const dy = creature.targetY - creature.y; const distance = Math.hypot(dx, dy);
    if (distance > 1) {
      const step = Math.min(creature.speed, distance);
      creature.x = Math.max(20, Math.min(WORLD.width - 20, creature.x + dx / distance * step));
      creature.y = Math.max(20, Math.min(WORLD.height - 20, creature.y + dy / distance * step));
    }
    for (const player of fish.values()) {
      if (player.dead || !player.active || Math.hypot(player.x - creature.x, player.y - creature.y) > (player.r + creature.r) * 0.72) continue;
      if (player.r > creature.r * 1.2) {
        creatures.delete(creature.id); player.score += creature.score; player.r = Math.min(82, 22 + Math.sqrt(player.score) * 0.78); player.coins += creature.coins;
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) { sendProfile(playerSocket, player); playerSocket.emit('reward', { message: `Ăn ${creature.name}: +${creature.coins} xu`, coins: creature.coins }); }
        const timer = setTimeout(() => spawnCreature(creature.type), 12000); timer.unref?.();
        break;
      }
      if (creature.hostile && creature.r > player.r * 1.05 && now >= player.protectedUntil && now - player.lastHitAt > (creature.attackCooldown || 1250)) {
        creature.lastAttackAt = now; player.lastHitAt = now; player.health = Math.max(0, player.health - creature.damage); player.lastDamageAt = now;
        if (player.health === 0) await eliminatePlayer(player, creature.name);
        break;
      }
    }
  }
  const players = [...fish.values()];
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const a = players[i]; const b = players[j];
    if (a.dead || b.dead) continue;
    if (Math.abs(a.r - b.r) < 7) continue;
    const big = a.r > b.r ? a : b; const small = big === a ? b : a;
    if (Math.hypot(big.x - small.x, big.y - small.y) < big.r * 0.72) {
      big.score += Math.max(50, small.score + 50); big.r = Math.min(82, 22 + Math.sqrt(big.score) * 0.78);
      big.coins += 10;
      const bigSocket = io.sockets.sockets.get(big.socketId);
      if (bigSocket) { sendProfile(bigSocket, big); bigSocket.emit('reward', { message: `Hạ ${small.name}: +10 xu`, coins: 10 }); }
      await eliminatePlayer(small, big.name);
    }
  }
  if (pellets.size < 500) for (let i = pellets.size; i < 500; i++) createPellet();
  io.volatile.emit('state', snapshot());
}, 50);

httpServer.listen(PORT, () => console.log(`Fish Eat Fish running at http://localhost:${PORT}`));
