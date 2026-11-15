import { fishCatalog } from '/assets/fish/catalog.js';

const io = window.io;
const $ = (id) => document.getElementById(id);
const canvas = $('gameCanvas'); const ctx = canvas.getContext('2d');
const mini = $('miniCanvas'); const miniCtx = mini.getContext('2d');
const oceanBackground = new Image(); oceanBackground.src = '/assets/ocean-background.png';
const state = { world: { width: 2600, height: 1800 }, players: [], pellets: [], creatures: [], shells: [], uid: null, playerId: null, me: null, active: false, startPending: false, target: null, camera: { x: 0, y: 0 }, lastMove: 0, firebase: null, auth: null, sound: true, rankings: [], allRankings: [], screen: 'home', user: null, profileRecord: {}, fishNodes: new Map(), creatureNodes: new Map(), shellNodes: new Map() };
const fishEmojis = ['🐠','🐟','🐡','🐬','🐳','🦈'];
let socket;
let audioContext = null;
let masterGain = null;

function startAmbientAudio() {
  if (!state.sound) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioContext) {
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain(); masterGain.connect(audioContext.destination);
    const ambience = audioContext.createGain(); ambience.gain.value = .55; ambience.connect(masterGain);
    for (const [index, frequency] of [110, 164.81].entries()) {
      const tone = audioContext.createOscillator(); const volume = audioContext.createGain();
      const drift = audioContext.createOscillator(); const driftDepth = audioContext.createGain();
      tone.type = 'sine'; tone.frequency.value = frequency; volume.gain.value = index ? .018 : .032;
      drift.frequency.value = .08 + index * .035; driftDepth.gain.value = 1.1;
      drift.connect(driftDepth); driftDepth.connect(tone.frequency);
      tone.connect(volume); volume.connect(ambience); tone.start(); drift.start();
    }
    const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 2, audioContext.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
    const noise = audioContext.createBufferSource(); const filter = audioContext.createBiquadFilter(); const noiseGain = audioContext.createGain();
    noise.buffer = noiseBuffer; noise.loop = true; filter.type = 'lowpass'; filter.frequency.value = 420; noiseGain.gain.value = .012;
    noise.connect(filter); filter.connect(noiseGain); noiseGain.connect(ambience); noise.start();
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  masterGain.gain.setTargetAtTime(.68, audioContext.currentTime, .2);
}
function setSoundEnabled(enabled) {
  state.sound = enabled;
  if (enabled) startAmbientAudio();
  else if (masterGain && audioContext) masterGain.gain.setTargetAtTime(0, audioContext.currentTime, .08);
  document.querySelectorAll('#soundToggle, #gameSoundToggle').forEach((button) => {
    button.textContent = enabled ? '♫' : '♪';
    button.title = enabled ? 'Tắt âm thanh' : 'Bật âm thanh';
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(enabled));
  });
}
function playTone(startFrequency, endFrequency, duration, volume, type = 'sine', delay = 0) {
  if (!state.sound || !audioContext || !masterGain) return;
  const start = audioContext.currentTime + delay; const tone = audioContext.createOscillator(); const envelope = audioContext.createGain();
  tone.type = type; tone.frequency.setValueAtTime(startFrequency, start); tone.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  envelope.gain.setValueAtTime(volume, start); envelope.gain.exponentialRampToValueAtTime(.001, start + duration);
  tone.connect(envelope); envelope.connect(masterGain); tone.start(start); tone.stop(start + duration + .02);
}
function playEatSound() { playTone(520, 840, .16, .28, 'triangle'); playTone(820, 1120, .15, .18, 'sine', .07); }
function playDamageSound() { playTone(190, 55, .28, .34, 'triangle'); }

function resize() {
  const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr); canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas); resize();

function connect(identity = {}) {
  if (socket) socket.disconnect();
  state.me = null; state.cameraReady = false;
  socket = io({ auth: identity });
  socket.on('connect', () => {
    $('onlineCount').textContent = 'Đại dương đang trực tiếp';
    if (state.startPending) { state.startPending = false; startGame(); }
    else if (!state.active) $('gameMessage').classList.remove('hidden');
  });
  socket.on('disconnect', () => { $('onlineCount').textContent = 'Đang kết nối lại…'; });
  socket.on('connect_error', (error) => {
    $('onlineCount').textContent = 'Chưa kết nối';
    $('gameMessage').classList.remove('hidden');
    showToast(`Chưa vào được đại dương: ${error.message}`);
  });
  socket.on('welcome', (data) => { state.world = data.world; state.uid = data.uid; state.playerId = data.playerId; if (data.profile) applyProfile(data.profile); });
  socket.on('profileData', applyProfile);
  socket.on('shopError', showToast);
  socket.on('state', (data) => {
    const previousScore = state.me?.score; const previousHealth = state.me?.health;
    state.players = data.players; state.pellets = data.pellets; state.creatures = data.creatures || []; state.shells = data.shells || [];
    state.me = state.players.find((p) => p.uid === state.uid) || state.players.find((p) => p.uid === state.uid && p.name === $('headerName').textContent);
    if (state.me && previousScore != null && state.me.score > previousScore) playEatSound();
    if (state.me && previousHealth != null && state.me.health < previousHealth) playDamageSound();
      updateFeaturedStats();
    if (state.me && !state.cameraReady) {
      const width = canvas.clientWidth; const height = canvas.clientHeight;
      state.camera.x = Math.max(0, Math.min(state.world.width - width, state.me.x - width / 2));
      state.camera.y = Math.max(0, Math.min(state.world.height - height, state.me.y - height / 2));
      state.cameraReady = true;
    }
    $('playerCount').textContent = state.players.length;
    if (state.me) {
      $('scoreValue').textContent = state.me.score.toLocaleString('vi-VN'); $('levelValue').textContent = Math.floor(state.me.score / 500) + 1;
      const health = Math.max(0, Math.min(100, state.me.health / state.me.maxHealth * 100));
      $('healthText').textContent = `${Math.ceil(state.me.health)} / ${state.me.maxHealth}`;
      $('healthFill').style.width = `${health}%`;
      $('healthFill').classList.toggle('low', health <= 30);
    }
    renderFishLayer();
    renderMatchFeed();
  });
  socket.on('leaderboard', renderLeaderboard);
  socket.on('notice', showToast);
  socket.on('reward', ({ message }) => showToast(message));
  socket.on('pearlFound', () => showToast('Bạn tìm thấy một viên ngọc trai!'));
  socket.on('eaten', ({ by, score }) => {
    playDamageSound();
    state.active = false; $('finalScore').textContent = Number(score || 0).toLocaleString('vi-VN'); $('deathOverlay').classList.remove('hidden'); $('gameMessage').classList.add('hidden');
    $('healthText').textContent = '0 / 100'; $('healthFill').style.width = '0%'; $('healthFill').classList.add('low');
    $('deathTitle').textContent = `Bạn đã bị ${by} hạ gục!`;
    saveLocalMatch(Number(score || 0));
    showToast(`Bạn đã bị ${by} hạ gục.`);
  });
}
function guestUid() {
  let uid = localStorage.getItem('fish-eat-fish:guestUid');
  if (!uid) {
    const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    uid = `guest-${randomId}`; localStorage.setItem('fish-eat-fish:guestUid', uid);
  }
  return uid;
}
connect({ uid: guestUid(), name: 'Thủy thủ' });
function applyProfile(profile) {
  state.profileRecord = { ...(state.profileRecord || {}), ...profile };
  writeStore('coins', profile.coins ?? getCoins()); writeStore('pearls', profile.pearls ?? getPearls()); writeStore('skins', profile.unlockedSkins || ['default']); writeStore('equipped', profile.skin || 'default');
  state.remoteHistory = profile.recentMatches || state.remoteHistory || [];
  if (profile.xp != null) $('profileXp').textContent = Number(profile.xp).toLocaleString('vi-VN');
  if (profile.level != null) { $('profileLevel').textContent = profile.level; document.querySelector('.level-circle').textContent = profile.level; }
  if (profile.bestScore != null) $('profileBest').textContent = Number(profile.bestScore).toLocaleString('vi-VN');
  if (profile.games != null) $('profileGames').textContent = profile.games;
  updateWallet(); renderFishCollection(); renderShop(); renderProfile();
}

function renderLeaderboard(entries) {
  state.rankings = Array.isArray(entries) ? entries : [];
  state.allRankings = state.rankings;
  const list = $('leaderboardList'); list.innerHTML = '';
  if (!entries.length) { list.innerHTML = '<li class="empty-board">Chưa có kỷ lục — hãy là người đầu tiên!</li>'; renderRankingPage(); return; }
  entries.slice(0, 10).forEach((entry, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank-no ${index < 3 ? 'gold' : ''}">${String(index + 1).padStart(2, '0')}</span><span class="rank-avatar">${fishEmojis[index % fishEmojis.length]}</span><span class="rank-name"><strong></strong><small>Cấp ${entry.level || 1} · ${entry.games || 0} trận</small></span><strong class="rank-score">${Number(entry.bestScore || 0).toLocaleString('vi-VN')}</strong>`;
    li.querySelector('.rank-name strong').textContent = entry.name || 'Thủy thủ'; list.append(li);
  });
  const mine = entries.findIndex((entry) => entry.uid === state.uid);
  $('yourBest').textContent = mine >= 0 ? Number(entries[mine].bestScore).toLocaleString('vi-VN') : (state.me?.score ? state.me.score.toLocaleString('vi-VN') : '—');
  document.querySelector('.your-rank .rank-no').textContent = mine >= 0 ? String(mine + 1).padStart(2, '0') : '—';
  document.querySelector('.your-rank .rank-name small').textContent = mine >= 0 ? `Cấp ${entries[mine].level || 1} · thành tích tốt nhất` : 'Đăng nhập để lưu thành tích';
  renderRankingPage();
}
function spriteUrl(sprite) { return `/assets/fish/${sprite}.png`; }
function skinSprite(skin) { return fishCatalog.find((fish) => fish.id === skin)?.sprite || fishCatalog[0].sprite; }
function storageKey(key) { return `fish-eat-fish:${state.user?.uid || 'guest-local'}:${key}`; }
function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(storageKey(key))) ?? fallback; } catch { return fallback; } }
function writeStore(key, value) { localStorage.setItem(storageKey(key), JSON.stringify(value)); }
function getCoins() { return readStore('coins', 120); }
function getPearls() { return readStore('pearls', 0); }
function getSkins() { return readStore('skins', ['default']); }
function currentSkin() { return readStore('equipped', 'default'); }
function updateWallet() {
  const coins = getCoins(); $('coinBalance').textContent = coins.toLocaleString('vi-VN');
  $('pearlBalance').textContent = getPearls().toLocaleString('vi-VN');
  document.querySelectorAll('.coin-number').forEach((node) => { node.textContent = coins.toLocaleString('vi-VN'); });
  $('profileCoins').textContent = coins.toLocaleString('vi-VN');
}
function updateFeaturedStats() {
  const maxHealth = state.me?.maxHealth ?? 100;
  $('featuredHealth').textContent = `${Math.ceil(state.me?.health ?? maxHealth)} / ${maxHealth}`;
  $('featuredDamage').textContent = 'Ăn cá nhỏ';
  $('featuredSpeed').textContent = `${state.me?.speed ?? 91} đv/s`;
}
function renderFishCollection() {
  const owned = getSkins(); const equipped = currentSkin();
  $('fishGrid').innerHTML = fishCatalog.map((fish) => {
    const isOwned = owned.includes(fish.id); const selected = equipped === fish.id;
    return `<button class="fish-tile ${selected ? 'selected' : ''} ${isOwned ? '' : 'locked'}" data-fish="${fish.id}"><span class="tile-fish">${isOwned ? `<img src="${spriteUrl(fish.sprite)}" alt="">` : '🔒'}</span><span class="tile-name">${fish.name}</span><div class="${isOwned ? 'tile-status' : 'tile-lock'}">${selected ? 'Đang sử dụng ✓' : isOwned ? fish.rarity : `🪙 ${fish.price}`}</div></button>`;
  }).join('');
  $('collectionCount').textContent = `${owned.length} / ${fishCatalog.length} đã mở khóa`;
  const selectedFish = fishCatalog.find((fish) => fish.id === equipped) || fishCatalog[0];
  $('featuredFish').innerHTML = `<img src="${spriteUrl(selectedFish.sprite)}" alt="">`; $('featuredName').textContent = selectedFish.name;
  updateFeaturedStats();
  $('equipFish').textContent = `Đang sử dụng · ${selectedFish.name} ✓`;
  $('fishGrid').querySelectorAll('[data-fish]').forEach((button) => button.addEventListener('click', () => {
    const fish = fishCatalog.find((item) => item.id === button.dataset.fish);
    if (getSkins().includes(fish.id)) equipSkin(fish.id);
    else showScreen('shop');
  }));
}
function renderShop() {
  const owned = getSkins(); const equipped = currentSkin();
  $('shopGrid').innerHTML = fishCatalog.map((fish) => {
    const isOwned = owned.includes(fish.id);
    const label = equipped === fish.id ? '✓ Đang sử dụng' : isOwned ? 'Dùng skin' : `🪙 ${fish.price} xu`;
    return `<article class="shop-item"><div class="shop-item-art"><img src="${spriteUrl(fish.sprite)}" alt=""></div><div class="shop-item-body"><strong>${fish.name}</strong><small>${fish.rarity} · Skin cá</small><button class="shop-buy ${isOwned ? 'owned' : ''} ${equipped === fish.id ? 'equipped' : ''}" data-shop-fish="${fish.id}">${label}</button></div></article>`;
  }).join('');
  $('shopGrid').querySelectorAll('[data-shop-fish]').forEach((button) => button.addEventListener('click', () => {
    const fish = fishCatalog.find((item) => item.id === button.dataset.shopFish);
    socket?.emit('buySkin', fish.id);
  }));
}
function equipSkin(id) {
  writeStore('equipped', id); socket?.emit('profile', { name: $('headerName').textContent, skin: id });
  renderFishCollection(); renderShop(); updateWallet(); showToast('Đã đổi diện mạo cá của bạn.');
}
function saveLocalMatch(score) {
  const history = readStore('history', []); const coinsEarned = Math.floor(score / 10);
  history.unshift({ score, coins: coinsEarned, date: Date.now() }); writeStore('history', history.slice(0, 20));
  writeStore('coins', getCoins() + coinsEarned); updateWallet(); renderProfile();
}
function renderProfile() {
  const entries = state.rankings; const mine = entries.find((entry) => entry.uid === state.uid) || {};
  const history = state.remoteHistory?.length ? state.remoteHistory : readStore('history', []);
  $('profileName').textContent = $('headerName').textContent || 'Thủy thủ';
  $('profileAvatar').textContent = state.user?.photoURL ? '🌟' : '🐟';
  $('profileSince').textContent = state.user ? (state.user.email || 'Thành viên đại dương') : 'Thành viên đại dương · Khách';
  const record = state.profileRecord || {};
  const best = Number(mine.bestScore ?? record.bestScore ?? history.reduce((value, item) => Math.max(value, item.score), 0));
  const games = Number(mine.games ?? record.games ?? history.length);
  const xp = Number(mine.xp ?? record.xp ?? history.reduce((sum, item) => sum + item.score, 0));
  $('profileBest').textContent = best.toLocaleString('vi-VN');
  $('profileGames').textContent = games.toLocaleString('vi-VN');
  $('profileXp').textContent = xp.toLocaleString('vi-VN');
  const level = Number(mine.level ?? record.level ?? Math.floor(xp / 500) + 1);
  $('profileLevel').textContent = level; document.querySelector('.level-circle').textContent = level; updateWallet();
  $('matchHistory').innerHTML = history.length ? history.map((item) => `<div class="history-row"><div class="history-icon">🐠</div><div class="history-info"><strong>Chuyến phiêu lưu ${new Date(item.date || item.finishedAt).toLocaleDateString('vi-VN')}</strong><small>Thưởng ${item.coinsEarned ?? item.coins ?? 0} xu · Kết thúc trận đấu</small></div><div class="history-score">+${Number(item.score).toLocaleString('vi-VN')} điểm</div></div>`).join('') : '<div class="empty-history">Chơi trận đầu tiên để bắt đầu hành trình nhé! 🐠</div>';
  const badges = [{ icon: '🐚', title: 'Lần đầu ra khơi', detail: 'Hoàn thành trận đấu đầu tiên', unlocked: games > 0 }, { icon: '⭐', title: 'Cá lớn trưởng thành', detail: 'Đạt 500 điểm trong một trận', unlocked: best >= 500 }, { icon: '🧜', title: 'Nhà sưu tập', detail: 'Mở khóa đủ 4 skin cá', unlocked: getSkins().length >= 4 }, { icon: '🌊', title: 'Thủy thủ chăm chỉ', detail: 'Chơi 5 trận đấu', unlocked: games >= 5 }];
  $('achievementGrid').innerHTML = badges.map((badge) => `<article class="achievement-item ${badge.unlocked ? '' : 'locked'}"><span>${badge.icon}</span><div><b>${badge.title}</b><small>${badge.detail}</small></div><i>${badge.unlocked ? '✓' : '🔒'}</i></article>`).join('');
}
function renderRankingPage() {
  const entries = state.rankings.slice(0, 10); const podium = $('podium'); const list = $('fullLeaderboard');
  if (!podium || !list) return;
  const top = [entries[1], entries[0], entries[2]].filter(Boolean);
  podium.innerHTML = top.length ? top.map((entry, index) => {
    const place = index === 0 ? 2 : index === 1 ? 1 : 3;
    const score = state.rankMode === 'week' ? entry.weekScore : entry.bestScore;
    return `<div class="podium-player place-${place}">${place === 1 ? '<span class="podium-crown">👑</span>' : ''}<div class="podium-avatar">${fishEmojis[(place - 1) % fishEmojis.length]}</div><div class="podium-name"></div><div class="podium-score">${Number(score || 0).toLocaleString('vi-VN')} điểm</div><div class="podium-block">${place}</div></div>`;
  }).join('') : '<div class="notice-empty">Hãy là người đầu tiên ghi tên lên bảng vàng! 🏆</div>';
  top.forEach((entry, index) => { podium.querySelectorAll('.podium-name')[index].textContent = entry.name || 'Thủy thủ'; });
  list.innerHTML = entries.length ? entries.map((entry, index) => {
    const score = state.rankMode === 'week' ? entry.weekScore : entry.bestScore;
    return `<li><span class="rank-no">${String(index + 1).padStart(2, '0')}</span><span class="full-rank-user"><i>${fishEmojis[index % fishEmojis.length]}</i><b></b></span><span class="full-rank-level">Cấp ${entry.level || 1}</span><strong class="full-rank-score">${Number(score || 0).toLocaleString('vi-VN')}</strong></li>`;
  }).join('') : '<li class="notice-empty">Chưa có điểm xếp hạng. Hãy là người đầu tiên!</li>';
  entries.forEach((entry, index) => { const name = list.querySelectorAll('.full-rank-user b')[index]; if (name) name.textContent = entry.name || 'Thủy thủ'; });
}
function renderMatchFeed() {
  const leaders = [...state.players].sort((a, b) => b.score - a.score).slice(0, 10); const feed = $('matchFeedList');
  feed.innerHTML = leaders.length ? leaders.map((player, index) => `<li><span>${index + 1}. ${escapeHtml(player.name)}${player.uid === state.uid ? ' (Bạn)' : ''}</span><b>${player.score}</b></li>`).join('') : '<li>Chưa có thủy thủ</li>';
}
function renderFishLayer() {
  const layer = $('fishLayer');
  const current = new Set();
  state.players.forEach((player, index) => {
    const key = `${player.uid}:${index}`; current.add(key);
    let node = state.fishNodes.get(key);
    if (!node) {
      node = document.createElement('div'); node.className = 'fish-sprite';
      node.innerHTML = '<img class="sprite-art" alt=""><small></small>'; layer.append(node); state.fishNodes.set(key, node);
    }
    const art = node.querySelector('.sprite-art'); const sprite = skinSprite(player.skin); const size = Math.max(58, Math.min(150, player.r * 2.8));
    if (art.dataset.sprite !== sprite) { art.dataset.sprite = sprite; art.src = spriteUrl(sprite); }
    if (Number(node.dataset.spriteSize) !== size) { art.style.width = `${size}px`; art.style.height = `${size}px`; node.dataset.spriteSize = size; }
    const previousX = Number(node.dataset.lastX);
    if (Number.isFinite(previousX) && Math.abs(player.x - previousX) > .1) art.classList.toggle('faces-right', player.x > previousX);
    node.dataset.lastX = player.x;
    node.querySelector('small').textContent = player.name;
    node.style.left = `${player.x - state.camera.x}px`;
    node.style.top = `${player.y - state.camera.y}px`;
    node.classList.toggle('is-me', player.uid === state.uid);
  });
  for (const [key, node] of state.fishNodes) if (!current.has(key)) { node.remove(); state.fishNodes.delete(key); }
  const currentCreatures = new Set();
  state.creatures.forEach((creature) => {
    currentCreatures.add(creature.id);
    let node = state.creatureNodes.get(creature.id);
    if (!node) {
      node = document.createElement('div'); node.innerHTML = '<img class="sprite-art" alt=""><small></small>'; $('fishLayer').append(node); state.creatureNodes.set(creature.id, node);
    }
    node.className = `creature-sprite ${creature.hostile ? 'hostile' : 'prey'} ${creature.boss ? 'boss' : ''}`;
    const art = node.querySelector('.sprite-art'); const sprite = creature.sprite || 'goldfish'; const size = Math.max(42, creature.r * 2.4);
    if (art.dataset.sprite !== sprite) { art.dataset.sprite = sprite; art.src = spriteUrl(sprite); }
    if (Number(node.dataset.spriteSize) !== size) { art.style.width = `${size}px`; art.style.height = `${size}px`; node.dataset.spriteSize = size; }
    const previousX = Number(node.dataset.lastX);
    if (Number.isFinite(previousX) && Math.abs(creature.x - previousX) > .1) art.classList.toggle('faces-right', creature.x > previousX);
    node.dataset.lastX = creature.x;
    node.querySelector('small').textContent = creature.hostile ? creature.name : '';
    node.style.left = `${creature.x - state.camera.x}px`; node.style.top = `${creature.y - state.camera.y}px`;
  });
  for (const [key, node] of state.creatureNodes) if (!currentCreatures.has(key)) { node.remove(); state.creatureNodes.delete(key); }
  const currentShells = new Set();
  state.shells.forEach((shell) => {
    currentShells.add(shell.id);
    let node = state.shellNodes.get(shell.id);
    if (!node) { node = document.createElement('div'); node.className = 'shell-sprite'; node.innerHTML = '<span>🐚</span><i>◆</i>'; $('fishLayer').append(node); state.shellNodes.set(shell.id, node); }
    node.style.left = `${shell.x - state.camera.x}px`; node.style.top = `${shell.y - state.camera.y}px`;
  });
  for (const [key, node] of state.shellNodes) if (!currentShells.has(key)) { node.remove(); state.shellNodes.delete(key); }
}
function escapeHtml(text) { const node = document.createElement('span'); node.textContent = text; return node.innerHTML; }
function enterMobilePlayMode() {
  const isTouchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
  if ((!window.matchMedia('(max-width: 760px)').matches && !isTouchDevice) || document.body.classList.contains('play-immersive')) return;
  document.body.classList.add('play-immersive');
  const lockLandscape = () => {
    try {
      if (!screen.orientation?.lock) {
        if (innerHeight > innerWidth) showToast('Xoay thiết bị ngang để chơi thoải mái hơn.');
        return;
      }
      const request = screen.orientation.lock('landscape');
      if (request?.catch) request.catch(() => showToast('Xoay thiết bị ngang để chơi thoải mái hơn.'));
    } catch { showToast('Xoay thiết bị ngang để chơi thoải mái hơn.'); }
  };
  try {
    const request = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    if (request?.then) request.then(lockLandscape, lockLandscape);
    else lockLandscape();
  } catch { lockLandscape(); }
}
function leaveMobilePlayMode() {
  document.body.classList.remove('play-immersive');
  try { screen.orientation?.unlock?.(); } catch { /* unsupported */ }
  const request = document.exitFullscreen?.();
  if (request?.catch) request.catch(() => {});
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('play-immersive')) leaveMobilePlayMode();
});
function showScreen(name) {
  if (name !== 'game') {
    if (state.active) { state.active = false; socket?.emit('pauseGame'); }
    leaveMobilePlayMode();
  }
  state.screen = name; document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.screen === name));
  $('layout').classList.toggle('hidden', !['home', 'game'].includes(name));
  $('layout').classList.toggle('game-focus', name === 'game');
  document.querySelectorAll('.feature-screen').forEach((screen) => screen.classList.add('hidden'));
  const pages = { characters: 'charactersScreen', shop: 'shopScreen', ranking: 'rankingScreen', profile: 'profileScreen' };
  if (pages[name]) $(pages[name]).classList.remove('hidden');
  if (name === 'game') { resize(); startGame(); }
  else if (name === 'characters') renderFishCollection();
  else if (name === 'shop') renderShop();
  else if (name === 'profile') renderProfile();
  if (name === 'ranking') {
    state.rankMode = 'server'; state.rankings = state.allRankings;
    document.querySelectorAll('[data-rank-tab]').forEach((button) => button.classList.toggle('active', button.dataset.rankTab === 'server'));
    renderRankingPage();
  }
}
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.screen)));
$('shopScroll').addEventListener('click', () => $('shopGrid').scrollIntoView({ behavior: 'smooth', block: 'center' }));
$('equipFish').addEventListener('click', () => showToast('Chú cá này đang đồng hành cùng bạn!'));
$('profileLogin').addEventListener('click', () => $('loginButton').click());
$('refreshPageRanking').addEventListener('click', () => socket?.emit('getLeaderboard'));
document.querySelectorAll('[data-rank-tab]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-rank-tab]').forEach((item) => item.classList.toggle('active', item === button));
  if (button.dataset.rankTab === 'friends') { state.rankMode = 'friends'; $('podium').innerHTML = '<div class="notice-empty">Đăng nhập để theo dõi bạn bè trong đại dương. 🐟</div>'; $('fullLeaderboard').innerHTML = '<li class="notice-empty">Bạn bè sẽ xuất hiện tại đây sau khi kết nối tài khoản.</li>'; }
  else if (button.dataset.rankTab === 'week') {
    state.rankMode = 'week'; const currentWeek = new Date(); const monday = new Date(Date.UTC(currentWeek.getUTCFullYear(), currentWeek.getUTCMonth(), currentWeek.getUTCDate())); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1)); const week = monday.toISOString().slice(0, 10);
    state.rankings = state.allRankings.filter((entry) => entry.weekKey === week && Number(entry.weekScore || 0) > 0).sort((a, b) => b.weekScore - a.weekScore); renderRankingPage();
  } else { state.rankMode = 'server'; state.rankings = state.allRankings; renderRankingPage(); }
}));
updateWallet(); renderFishCollection(); renderShop(); renderProfile();
fetch('/api/leaderboard').then((res) => res.json()).then(renderLeaderboard).catch(() => {});

function worldPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left + state.camera.x, y: event.clientY - rect.top + state.camera.y };
}
canvas.addEventListener('pointermove', (event) => {
  if (event.pointerId === floatingPointerId) return;
  if (!state.active || !state.me) return;
  state.target = worldPoint(event);
  const now = performance.now(); if (now - state.lastMove > 35) { socket.emit('move', state.target); state.lastMove = now; }
});
canvas.addEventListener('pointerdown', (event) => {
  if (!state.active) { startGame(); return; }
  if (event.pointerType === 'touch') { beginFloatingJoystick(event); return; }
  state.target = worldPoint(event); socket.emit('move', state.target);
});

function startGame() {
  startAmbientAudio();
  enterMobilePlayMode();
  if (!socket?.connected) { state.startPending = true; showToast('Đang kết nối với đại dương…'); return; }
  state.active = true; $('gameMessage').classList.add('hidden'); $('deathOverlay').classList.add('hidden');
  socket.emit('startGame');
  const rect = canvas.getBoundingClientRect(); socket.emit('move', { x: state.camera.x + rect.width / 2, y: state.camera.y + rect.height / 2 });
}
$('playButton').addEventListener('click', () => showScreen('game')); $('messagePlay').addEventListener('click', () => showScreen('game')); $('retryButton').addEventListener('click', async () => {
  if (state.user) { const token = await state.user.getIdToken(); connect({ uid: state.user.uid, name: $('headerName').textContent, token }); }
  else connect({ uid: guestUid(), name: $('headerName').textContent });
  setTimeout(startGame, 300);
});
$('exitGame').addEventListener('click', () => showScreen('home'));
$('refreshLeaderboard').addEventListener('click', () => socket.emit('getLeaderboard'));
$('openLeaderboard').addEventListener('click', () => { showScreen('ranking'); socket.emit('getLeaderboard'); });
function toggleSound() { setSoundEnabled(!state.sound); }
$('soundToggle').addEventListener('click', toggleSound);
$('gameSoundToggle').addEventListener('click', toggleSound);
function showToast(message) { if (!message) return; const toast = $('globalToast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200); }

function drawBackground(width, height) {
  if (oceanBackground.complete && oceanBackground.naturalWidth) {
    const scale = Math.max(width / oceanBackground.naturalWidth, height / oceanBackground.naturalHeight);
    const backgroundWidth = oceanBackground.naturalWidth * scale; const backgroundHeight = oceanBackground.naturalHeight * scale;
    const cameraRangeX = Math.max(1, state.world.width - width); const cameraRangeY = Math.max(1, state.world.height - height);
    const offsetX = -Math.max(0, backgroundWidth - width) * state.camera.x / cameraRangeX;
    const offsetY = -Math.max(0, backgroundHeight - height) * state.camera.y / cameraRangeY;
    ctx.drawImage(oceanBackground, offsetX, offsetY, backgroundWidth, backgroundHeight);
    ctx.fillStyle = 'rgba(0, 48, 89, .08)'; ctx.fillRect(0, 0, width, height);
    return;
  }
  const grad = ctx.createLinearGradient(0, 0, 0, height); grad.addColorStop(0, '#bcebe2'); grad.addColorStop(1, '#7ac9c3'); ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);
  ctx.save(); ctx.translate(-state.camera.x % 110, -state.camera.y % 90);
  for (let x = -110; x < width + 110; x += 110) for (let y = -90; y < height + 90; y += 90) {
    ctx.beginPath(); ctx.arc(x + ((Math.floor((x + 1000) / 110) % 2) * 28), y, 1.3, 0, Math.PI * 2); ctx.fillStyle = '#e6fff74b'; ctx.fill();
  }
  ctx.restore();
}
function drawOceanAmbience(width, height) {
  const time = performance.now() / 1000;
  const clumps = [
    { x: 18, count: 4, color: '#3b9c68' },
    { x: 58, count: 3, color: '#67b85d' },
    { x: width - 18, count: 4, color: '#3b9c68' },
    { x: width - 58, count: 3, color: '#67b85d' },
  ];
  ctx.save(); ctx.globalAlpha = .48; ctx.lineCap = 'round';
  for (const [clumpIndex, clump] of clumps.entries()) {
    for (let frond = 0; frond < clump.count; frond++) {
      const direction = clump.x < width / 2 ? 1 : -1;
      const baseX = clump.x + direction * frond * 9;
      const frondHeight = 42 + (frond % 3) * 13;
      const sway = Math.sin(time * 1.15 + clumpIndex + frond * .8) * 8;
      ctx.beginPath(); ctx.moveTo(baseX, height + 8);
      ctx.quadraticCurveTo(baseX + sway - direction * 13, height - frondHeight * .55, baseX + sway, height - frondHeight);
      ctx.strokeStyle = clump.color; ctx.lineWidth = 5 - frond % 2; ctx.stroke();
    }
  }
  ctx.restore();

  ctx.save(); ctx.lineWidth = 1.4;
  for (let index = 0; index < 17; index++) {
    const cycle = height + 44;
    const rise = (time * (12 + index % 4 * 3) + index * 67) % cycle;
    const x = ((index * 97 + Math.sin(time * .55 + index) * 13 - state.camera.x * .025) % (width + 30) + width + 30) % (width + 30) - 15;
    const y = height - rise + 12;
    const radius = 2.5 + index % 4 * 1.25;
    const alpha = .22 + (index % 3) * .08;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(206, 250, 255, ${alpha * .35})`; ctx.fill();
    ctx.strokeStyle = `rgba(225, 253, 255, ${alpha})`; ctx.stroke();
    ctx.beginPath(); ctx.arc(x - radius * .32, y - radius * .35, Math.max(.7, radius * .18), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha * .8})`; ctx.fill();
  }
  ctx.restore();
}
function drawFish(player, isMe) {
  const x = player.x - state.camera.x; const y = player.y - state.camera.y; const r = player.r;
  if (x < -r - 60 || x > canvas.clientWidth + r + 60 || y < -r - 60 || y > canvas.clientHeight + r + 60) return;
  const palette = player.skin === 'sunset' ? ['#ff946c','#ffe097'] : player.skin === 'mint' ? ['#5bc9ac','#b1f1cb'] : player.skin === 'berry' ? ['#d578bc','#ffc2dc'] : [player.color, '#ffe29a'];
  const angle = isMe && state.target ? Math.atan2(state.target.y - player.y, state.target.x - player.x) : 0;
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.shadowColor = '#387f7250'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 5;
  ctx.fillStyle = palette[0]; ctx.beginPath(); ctx.moveTo(-r * .63, 0); ctx.lineTo(-r * 1.32, -r * .66); ctx.quadraticCurveTo(-r * 1.13, 0, -r * 1.32, r * .66); ctx.closePath(); ctx.fill();
  const body = ctx.createRadialGradient(-r * .1, -r * .32, r * .05, 0, 0, r * 1.1); body.addColorStop(0, palette[1]); body.addColorStop(.48, palette[0]); body.addColorStop(1, shade(palette[0], -.14));
  ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, r * 1.13, r * .76, 0, 0, Math.PI * 2); ctx.fill(); ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#ffffffa3'; ctx.beginPath(); ctx.ellipse(-r * .12, -r * .25, r * .42, r * .12, -.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r * .57, -r * .14, Math.max(2.3, r * .16), 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#234653'; ctx.beginPath(); ctx.arc(r * .63, -r * .12, Math.max(1.3, r * .085), 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#a9505360'; ctx.lineWidth = Math.max(1, r * .035); ctx.beginPath(); ctx.arc(r * .79, r * .18, r * .1, .25, 1.3); ctx.stroke();
  ctx.restore();
  ctx.font = `700 ${Math.max(9, Math.min(12, r * .36))}px 'DM Sans', sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#225c5d'; ctx.shadowBlur = 4; ctx.fillText(player.name, x, y - r - 11); ctx.shadowBlur = 0;
  if (isMe) { ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.strokeStyle = '#ffffffa8'; ctx.lineWidth = 2; ctx.stroke(); }
}
function shade(hex, amount) { const num = parseInt(hex.slice(1), 16); return `#${[num >> 16, num >> 8 & 255, num & 255].map((c) => Math.max(0, Math.min(255, Math.round(c * (1 + amount)))).toString(16).padStart(2, '0')).join('')}`; }
function drawMini() {
  const width = mini.width; const height = mini.height;
  const scaleX = width / state.world.width; const scaleY = height / state.world.height;
  const ocean = miniCtx.createLinearGradient(0, 0, width, height);
  ocean.addColorStop(0, '#72c8bc'); ocean.addColorStop(1, '#4aa99f');
  miniCtx.fillStyle = ocean; miniCtx.fillRect(0, 0, width, height);
  miniCtx.strokeStyle = '#ffffff30'; miniCtx.lineWidth = 1;
  for (let division = 1; division < 4; division++) {
    miniCtx.beginPath(); miniCtx.moveTo(width * division / 4, 0); miniCtx.lineTo(width * division / 4, height); miniCtx.stroke();
    miniCtx.beginPath(); miniCtx.moveTo(0, height * division / 4); miniCtx.lineTo(width, height * division / 4); miniCtx.stroke();
  }
  for (const pellet of state.pellets) {
    miniCtx.fillStyle = pellet.color;
    miniCtx.globalAlpha = .85;
    miniCtx.beginPath(); miniCtx.arc(pellet.x * scaleX, pellet.y * scaleY, 1, 0, Math.PI * 2); miniCtx.fill();
  }
  miniCtx.globalAlpha = 1;
  const viewX = state.camera.x * scaleX; const viewY = state.camera.y * scaleY;
  const viewWidth = canvas.clientWidth * scaleX; const viewHeight = canvas.clientHeight * scaleY;
  miniCtx.fillStyle = '#ffffff20'; miniCtx.fillRect(viewX, viewY, viewWidth, viewHeight);
  miniCtx.strokeStyle = '#ffffff'; miniCtx.lineWidth = 1.5; miniCtx.strokeRect(viewX, viewY, viewWidth, viewHeight);
  for (const player of state.players) {
    const isMe = player.uid === state.uid;
    miniCtx.beginPath(); miniCtx.arc(player.x * scaleX, player.y * scaleY, isMe ? 3.2 : 2.2, 0, Math.PI * 2);
    miniCtx.fillStyle = isMe ? '#ff725e' : '#173f50'; miniCtx.fill();
    miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 1; miniCtx.stroke();
  }
  for (const creature of state.creatures) {
    miniCtx.beginPath(); miniCtx.arc(creature.x * scaleX, creature.y * scaleY, creature.boss ? 4 : creature.hostile ? 2 : 1.4, 0, Math.PI * 2);
    miniCtx.fillStyle = creature.boss ? '#ff365e' : creature.hostile ? '#ed5353' : '#173f50'; miniCtx.fill();
  }
  for (const shell of state.shells) {
    miniCtx.beginPath(); miniCtx.arc(shell.x * scaleX, shell.y * scaleY, 1.8, 0, Math.PI * 2);
    miniCtx.fillStyle = '#fff'; miniCtx.fill();
  }
}
function frame() {
  const width = canvas.clientWidth; const height = canvas.clientHeight;
  if (state.me) { const desiredX = Math.max(0, Math.min(state.world.width - width, state.me.x - width / 2)); const desiredY = Math.max(0, Math.min(state.world.height - height, state.me.y - height / 2)); state.camera.x += (desiredX - state.camera.x) * .1; state.camera.y += (desiredY - state.camera.y) * .1; }
  drawBackground(width, height);
  drawOceanAmbience(width, height);
  for (const p of state.pellets) { const x = p.x - state.camera.x; const y = p.y - state.camera.y; if (x < -12 || x > width + 12 || y < -12 || y > height + 12) continue; ctx.shadowColor = p.color; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill(); ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(x - p.r * .25, y - p.r * .25, Math.max(1, p.r * .28), 0, Math.PI * 2); ctx.fillStyle = '#ffffffaa'; ctx.fill(); }
  renderFishLayer(); drawMini(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const configResponse = await fetch('/api/config').then((res) => res.json()).catch(() => ({}));
if (configResponse.firebase) {
  try {
    const [{ initializeApp }, authModule] = await Promise.all([import('https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js'), import('https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js')]);
    const app = initializeApp(configResponse.firebase); state.auth = authModule.getAuth(app);
    authModule.onAuthStateChanged(state.auth, (user) => {
      if (!user) return;
      state.user = user; const name = user.displayName || user.email?.split('@')[0] || 'Thủy thủ';
      $('headerName').textContent = name; $('headerAvatar').textContent = user.photoURL ? '🌟' : '🐠'; $('loginButton').textContent = 'Đã đăng nhập ✓';
      user.getIdToken().then((token) => { connect({ uid: user.uid, name, token }); socket.emit('profile', { name, skin: currentSkin() }); });
      $('profileLogin').textContent = 'Tài khoản đã kết nối ✓';
      $('authModal').classList.add('hidden');
    });
    const { GoogleAuthProvider, signInWithPopup, createUserWithEmailAndPassword, signInWithEmailAndPassword } = authModule;
    $('googleLogin').addEventListener('click', async () => { try { await signInWithPopup(state.auth, new GoogleAuthProvider()); } catch (e) { $('authError').textContent = e.message; } });
    $('emailLogin').addEventListener('click', async () => {
      const email = $('emailInput').value.trim(); const password = $('passwordInput').value;
      try { await signInWithEmailAndPassword(state.auth, email, password); } catch (e) { if (e.code === 'auth/invalid-credential' || e.code === 'auth/user-not-found') { try { await createUserWithEmailAndPassword(state.auth, email, password); } catch (err) { $('authError').textContent = firebaseError(err); } } else $('authError').textContent = firebaseError(e); }
    });
  } catch (error) { console.error('Firebase client setup failed:', error); $('authError').textContent = 'Không thể tải cấu hình đăng nhập.'; }
} else {
  $('googleLogin').addEventListener('click', () => { $('authError').textContent = 'Chủ game cần cấu hình Firebase trước khi bật đăng nhập.'; });
  $('emailLogin').addEventListener('click', () => { $('authError').textContent = 'Chủ game cần cấu hình Firebase trước khi bật đăng nhập.'; });
}
function firebaseError(error) { return error.code === 'auth/weak-password' ? 'Mật khẩu cần có ít nhất 6 ký tự.' : error.code === 'auth/invalid-email' ? 'Địa chỉ email không hợp lệ.' : error.message; }
$('loginButton').addEventListener('click', () => { $('authError').textContent = ''; $('authModal').classList.remove('hidden'); });
$('profileButton').addEventListener('click', () => state.user ? showScreen('profile') : $('loginButton').click());
$('closeModal').addEventListener('click', () => $('authModal').classList.add('hidden'));
$('authModal').addEventListener('click', (e) => { if (e.target === $('authModal')) $('authModal').classList.add('hidden'); });

const joystick = $('virtualJoystick'); const joystickKnob = joystick.querySelector('span');
let floatingPointerId = null;
function beginFloatingJoystick(event) {
  if (!state.active || !state.me) return;
  event.preventDefault();
  floatingPointerId = event.pointerId;
  const bounds = canvas.parentElement.getBoundingClientRect(); const radius = (joystick.offsetWidth || 88) / 2;
  const centerX = Math.max(radius + 8, Math.min(bounds.width - radius - 8, event.clientX - bounds.left));
  const centerY = Math.max(radius + 8, Math.min(bounds.height - radius - 8, event.clientY - bounds.top));
  joystick.style.left = `${centerX - radius}px`; joystick.style.top = `${centerY - radius}px`;
  joystick.style.right = 'auto'; joystick.style.bottom = 'auto'; joystick.classList.add('floating');
  try { joystick.setPointerCapture(event.pointerId); } catch { /* window listeners keep the drag alive */ }
  steerJoystick(event);
}
joystick.addEventListener('pointerdown', beginFloatingJoystick);
window.addEventListener('pointermove', (event) => { if (event.pointerId === floatingPointerId) steerJoystick(event); });
window.addEventListener('pointerup', (event) => resetJoystick(event));
window.addEventListener('pointercancel', (event) => resetJoystick(event));
function steerJoystick(event) {
  if (!state.me) return;
  const rect = joystick.getBoundingClientRect(); const radius = rect.width * .34;
  const dx = event.clientX - (rect.left + rect.width / 2); const dy = event.clientY - (rect.top + rect.height / 2);
  const length = Math.hypot(dx, dy); const scale = length > radius ? radius / length : 1;
  const x = dx * scale; const y = dy * scale;
  joystickKnob.style.transform = `translate(${x}px,${y}px)`;
  state.target = { x: state.me.x + x / radius * 380, y: state.me.y + y / radius * 380 };
  const now = performance.now(); if (now - state.lastMove > 35) { socket.emit('move', state.target); state.lastMove = now; }
}
function resetJoystick(event) {
  if (event && event.pointerId !== floatingPointerId) return;
  floatingPointerId = null; joystickKnob.style.transform = ''; joystick.classList.remove('floating');
  joystick.style.left = ''; joystick.style.top = ''; joystick.style.right = ''; joystick.style.bottom = '';
}
