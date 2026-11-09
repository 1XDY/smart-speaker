/* ============================================================
   定时小喇叭 · app.js
   功能：定时任务管理 / 提示音合成 / 语音播报 / 本地存储 / 蓝牙扫描
   ============================================================ */

'use strict';

// ---------- 数据层 ----------
const STORE_KEY = 'dingding_tasks_v1';
const SET_KEY   = 'dingding_settings_v1';

let tasks = load(STORE_KEY, []);
let settings = load(SET_KEY, {
  autostart: true,
  vibrate: true,
  dndFrom: '22:00',
  dndTo: '07:00',
  volume: 90,
  net: ''
});

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(tasks));
  localStorage.setItem(SET_KEY, JSON.stringify(settings));
}

// ---------- 时间工具 ----------
// 把 "HH:MM" 转成当天的分钟数
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
// 星期：0=周日 ... 6=周六
function today() { return new Date().getDay(); }

// 判断某个任务此刻是否应该触发
function shouldFire(task, firedKey) {
  if (!task.enabled) return false;
  const key = fireKey(task);
  if (task._lastFire === key) return false; // 今天这一分钟已触发过

  // 仅一次任务，只在指定日期触发
  if (task.repeat === 'once') {
    if (!task.date) return false;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    if (task.date !== todayStr) return false;
    return nowMinutes() === toMinutes(task.time);
  }

  // 按星期重复
  const days = task.days || [];
  if (days.length > 0 && !days.includes(today())) return false;

  // 免打扰
  if (inDND()) return false;

  return nowMinutes() === toMinutes(task.time);
}
function fireKey(task) {
  const now = new Date();
  return `${now.toISOString().slice(0,10)}_${task.time}`;
}
function inDND() {
  const cur = nowMinutes();
  const from = toMinutes(settings.dndFrom);
  const to = toMinutes(settings.dndTo);
  if (from <= to) return cur >= from && cur < to;
  return cur >= from || cur < to; // 跨午夜
}

// ---------- 声音引擎（Web Audio 合成，无需音频文件） ----------
let audioCtx = null;
function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(ctx, freq, start, dur, type, gainVal) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, ctx.currentTime + start);
  gain.gain.linearRampToValueAtTime(gainVal, ctx.currentTime + start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

// ---------- 卡通音色（原创合成，模仿各角色气质） ----------
// 每个预设是一串音符 {f频率, t起始秒, d时长, w波形, g增益}
const CARTOON_SOUNDS = {
  // 史迪奇：调皮外星、跳脱搞怪
  stitch: [
    {f:392,t:0,d:.09,w:'square',g:.6}, {f:523,t:.09,d:.09,w:'triangle'},
    {f:466,t:.18,d:.09,w:'triangle'}, {f:622,t:.27,d:.12,w:'triangle'},
    {f:587,t:.40,d:.18,w:'triangle'}, {f:784,t:.55,d:.25,w:'triangle'}
  ],
  // 懒洋洋：慢、软、萌、髓髓欲睡
  lazy: [
    {f:349,t:0,d:.5,w:'triangle',g:.7}, {f:392,t:.5,d:.5,w:'triangle',g:.7},
    {f:440,t:1.0,d:.75,w:'sine',g:.8}
  ],
  // 哆啦A梦：元气铃铛、明亮上行
  doraemon: [
    {f:784,t:0,d:.18,w:'sine'}, {f:988,t:.16,d:.18,w:'sine'},
    {f:1174,t:.32,d:.18,w:'sine'}, {f:1318,t:.48,d:.4,w:'sine',g:.9}
  ],
  // 小熊维尼：温暖、软糯、摇篮曲感
  pooh: [
    {f:523,t:0,d:.35,w:'sine'}, {f:587,t:.32,d:.35,w:'sine'},
    {f:659,t:.64,d:.35,w:'sine'}, {f:523,t:.96,d:.6,w:'sine',g:.85}
  ],
  // 皮卡丘：电气跳跃、短促高音
  pikachu: [
    {f:1046,t:0,d:.10,w:'square',g:.45}, {f:1318,t:.10,d:.10,w:'square',g:.45},
    {f:1568,t:.20,d:.14,w:'square',g:.45}, {f:1046,t:.36,d:.18,w:'triangle',g:.8},
    {f:1396,t:.52,d:.3,w:'triangle'}
  ],
  // 龙猫：森林软风、轻柔舒缓
  totoro: [
    {f:440,t:0,d:.4,w:'sine',g:.7}, {f:554,t:.35,d:.4,w:'sine',g:.7},
    {f:659,t:.70,d:.55,w:'triangle',g:.8}
  ],
  // 凯蒂猫：甜心闪亮、高亮可爱
  kitty: [
    {f:1174,t:0,d:.12,w:'triangle'}, {f:1318,t:.12,d:.12,w:'triangle'},
    {f:1568,t:.24,d:.12,w:'triangle'}, {f:1760,t:.36,d:.32,w:'sine',g:.8}
  ],
  // 小黄人：搞笑香蕉、笨拙吭声
  minion: [
    {f:220,t:0,d:.18,w:'square',g:.55}, {f:277,t:.18,d:.18,w:'square',g:.55},
    {f:330,t:.36,d:.22,w:'square',g:.55}, {f:220,t:.58,d:.32,w:'triangle',g:.7}
  ]
};

const VOICE_STYLES = {
  stitch:   { rate: 1.15, pitch: 1.35 },
  doraemon: { rate: 1.05, pitch: 1.25 },
  pooh:     { rate: 0.9,  pitch: 0.8  },
  pikachu:  { rate: 1.25, pitch: 1.7  },
  lazy:     { rate: 0.72, pitch: 0.75 },
  totoro:   { rate: 0.88, pitch: 0.95 },
  kitty:    { rate: 1.12, pitch: 1.55 },
  minion:   { rate: 1.05, pitch: 1.15 }
};

function playSound(name, vol, speed, pitch) {
  const sp = speed || 1;
  const pt = pitch || 1;
  const ctx = getCtx();
  const v = (vol == null ? settings.volume : vol) / 100 * 0.4;
  // 卡通音色优先
  if (CARTOON_SOUNDS[name]) {
    CARTOON_SOUNDS[name].forEach(n =>
      tone(ctx, n.f * pt, n.t / sp, n.d / sp, n.w || 'triangle', v * (n.g == null ? 1 : n.g)));
    return;
  }
  switch (name) {
    case 'bell':   // 铃声：两个音叠加
      tone(ctx, 880, 0, 0.6, 'sine', v);
      tone(ctx, 1320, 0, 0.5, 'sine', v * 0.6);
      tone(ctx, 880, 0.35, 0.6, 'sine', v);
      tone(ctx, 1320, 0.35, 0.5, 'sine', v * 0.6);
      break;
    case 'chime':  // 木琴：上行琶音
      [523, 659, 784, 1046].forEach((f, i) => tone(ctx, f, i * 0.13, 0.5, 'triangle', v));
      break;
    case 'beep':   // 蜂鸣：短促方波
      for (let i = 0; i < 3; i++) tone(ctx, 900, i * 0.22, 0.14, 'square', v * 0.7);
      break;
    case 'magic':  // 魔法：滑音
      [660, 880, 1100, 1320, 1760].forEach((f, i) => tone(ctx, f, i * 0.09, 0.35, 'sine', v));
      break;
    default:
      tone(ctx, 880, 0, 0.5, 'sine', v);
  }
}

// ---------- 语音播报 ----------
function speak(text, vol, style, rateMul) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.volume = (vol == null ? settings.volume : vol) / 100;
  const vs = VOICE_STYLES[style] || { rate: 1, pitch: 1 };
  u.rate = Math.max(0.5, Math.min(2, vs.rate * (rateMul == null ? 1 : rateMul)));
  u.pitch = Math.max(0, Math.min(2, vs.pitch));
  const voices = speechSynthesis.getVoices();
  const zh = voices.find(v => /zh|Chinese/i.test(v.lang));
  if (zh) u.voice = zh;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
// 预加载语音列表
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {
  const sel = document.getElementById('s-voice');
  const voices = speechSynthesis.getVoices().filter(v => /zh|Chinese/i.test(v.lang));
  sel.innerHTML = '';
  voices.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = v.name;
    sel.appendChild(o);
  });
  if (!voices.length) sel.innerHTML = '<option>默认女声</option>';
};

// ---------- 震动 ----------
function buzz() {
  if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

// ---------- 蓝牙喇叭（玩偶音箱 · BLE） ----------
const BLE_SERVICE = '12345678-1234-1234-1234-123456789abc';
const BLE_COMMAND = 'abcd1111-1234-1234-1234-123456789abc';
let bleChar = null;
let bleDevice = null;

function bleSend(cmd) {
  if (!bleChar) return Promise.resolve(false);
  const data = new TextEncoder().encode(cmd);
  const w = bleChar.writeValueWithoutResponse
    ? bleChar.writeValueWithoutResponse(data)
    : bleChar.writeValue(data);
  return w.then(() => true).catch(() => false);
}
function blePlay(file, vol) {
  return bleSend('PLAY:' + (file || 'default.mp3'));
}
function bleSyncTime() {
  return bleSend('TIME:' + Math.floor(Date.now() / 1000));
}
// 把所有任务同步到玩偶，让它手机不在也能按时响
function bleSyncTasks() {
  return bleSend('CLEAR').then(() => {
    (tasks || []).forEach(t => {
      if (!t.enabled) return;
      const [h, m] = (t.time || '08:00').split(':').map(Number);
      let rep = 0;                                   // 默认每天
      if (t.repeat === 'once' || (t.days && t.days.length === 0)) rep = 8;
      else if (t.days && t.days.length > 0 && t.days.length < 7) rep = Math.min(...t.days.filter(d => d >= 1 && d <= 7).concat([0]));
      const file = (t.toyFile && t.toyFile.trim()) ? t.toyFile.trim() : 'default.mp3';
      bleSend(`TASK:${t.id},${h},${m},${rep},${file}`);
    });
  });
}

function setBleStatus(text, cls) {
  const el = document.getElementById('net-status');
  if (el) { el.textContent = text; el.className = 'net-status' + (cls ? ' ' + cls : ''); }
}

async function bleConnect() {
  if (!navigator.bluetooth) {
    setBleStatus('⚠️ 此浏览器不支持蓝牙，请用 Chrome / Edge / 安卓浏览器', 'bad');
    return;
  }
  try {
    setBleStatus('正在搜索“玩偶小喇叭”…');
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: '玩偶小喇叭' }],
      optionalServices: [BLE_SERVICE]
    });
    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    bleChar = await service.getCharacteristic(BLE_COMMAND);
    setBleStatus('✅ 已连接 ' + (bleDevice.name || '玩偶小喇叭') + '，正在同步…', 'ok');
    document.getElementById('device-name').textContent = bleDevice.name || '玩偶小喇叭';
    document.getElementById('device-status').textContent = '已连接 · 蓝牙直连';
    await bleSyncTime();
    await bleSyncTasks();
    blePlay('chime.mp3');
    setBleStatus('✅ 已连接并同步日程，手机不在也能按时响', 'ok');
    bleDevice.addEventListener('gattserverdisconnected', () => {
      bleChar = null;
      setBleStatus('已断开连接，请重新连接', 'bad');
    });
  } catch (e) {
    setBleStatus('未连接：' + (e.message || '已取消'), 'bad');
  }
}

// ---------- 触发一个任务 ----------
function fireTask(task) {
  task._lastFire = fireKey(task);
  save();

  const vol = task.volume != null ? task.volume : settings.volume;
  const act = task.action || 'sound';

  if (act === 'sound' || act === 'both') playSound(task.sound || 'bell', vol, task.speed, task.pitch);
  if (act === 'voice' || act === 'both') {
    const text = task.voice && task.voice.trim() ? task.voice.trim() : (task.name + ' 时间到啦！');
    speak(text, vol, task.sound, task.voiceRate);
  }
  // 同步让蓝牙玩偶音箱也响：优先用真人语音文件
  if (task.toyFile && task.toyFile.trim()) bleSend('PLAY:' + task.toyFile.trim());
  buzz();
  notify(task);
  renderNext();
  showToast(`📣 ${task.time}　${task.name}`);
}

function notify(task) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification('📣 定时小喇叭', {
      body: `${task.time}　${task.name}`,
      icon: 'icon.svg',
      tag: 'dingding-' + task.id
    });
  }
}

// ---------- 调度器：每秒检查一次 ----------
let lastCheckedMinute = -1;
function tick() {
  const curMinute = nowMinutes();
  if (curMinute === lastCheckedMinute) return; // 同一分钟只查一次
  lastCheckedMinute = curMinute;

  tasks.forEach(t => {
    if (shouldFire(t)) fireTask(t);
  });
}
setInterval(tick, 1000);

// ---------- 渲染 ----------
function repeatLabel(t) {
  if (t.repeat === 'once') return '仅一次';
  const days = t.days || [];
  if (days.length === 7) return '每天';
  if (days.length === 5 && [1,2,3,4,5].every(d => days.includes(d))) return '工作日';
  if (days.length === 0) return '每天';
  const names = ['日','一','二','三','四','五','六'];
  return '周' + days.slice().sort().map(d => names[d]).join('');
}
function actionLabel(t) {
  const a = t.action;
  return a === 'voice' ? '语音' : a === 'both' ? '音+语音' : '提示音';
}

function renderList() {
  const list = document.getElementById('task-list');
  const empty = document.getElementById('empty-state');
  document.getElementById('task-count').textContent = tasks.length + ' 个';

  if (tasks.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    empty.style.display = 'block';
    return;
  }

  // 按时间排序
  const sorted = tasks.slice().sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  list.innerHTML = '';
  sorted.forEach(t => {
    const el = document.createElement('div');
    el.className = 'task' + (t.enabled ? '' : ' disabled');
    el.innerHTML = `
      <div class="task-time">${t.time}</div>
      <div class="task-body">
        <div class="task-name">${escapeHtml(t.name)}</div>
        <div class="task-meta">
          <span class="tag">${repeatLabel(t)}</span>
          <span class="tag">${actionLabel(t)}</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="mini-btn ${t.enabled ? 'on' : ''}" data-toggle="${t.id}">${t.enabled ? '✓' : '⏸'}</button>
        <button class="mini-btn del" data-del="${t.id}">🗑</button>
      </div>`;

    // 点击卡片=编辑
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-toggle]') || e.target.closest('[data-del]')) return;
      openTaskSheet(t);
    });
    list.appendChild(el);
  });

  list.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    const t = tasks.find(x => x.id == b.dataset.toggle);
    t.enabled = !t.enabled;
    save(); renderList(); renderNext();
  }));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    tasks = tasks.filter(x => x.id != b.dataset.del);
    save(); renderList(); renderNext();
    showToast('已删除任务');
  }));
}

function renderNext() {
  const upcoming = tasks.filter(t => t.enabled)
    .map(t => ({ ...t, _min: toMinutes(t.time) }))
    .sort((a, b) => a._min - b._min);

  const cur = nowMinutes();
  let next = upcoming.find(t => t._min > cur) || upcoming[0];

  const timeEl = document.getElementById('next-time');
  const nameEl = document.getElementById('next-name');
  const metaEl = document.getElementById('next-meta');

  if (!next) {
    timeEl.textContent = '--:--';
    nameEl.textContent = '还没有任务';
    metaEl.textContent = '点右下角 + 添加一个吧';
    return;
  }
  timeEl.textContent = next.time;
  nameEl.textContent = next.name;
  const diff = next._min - cur;
  const diffText = diff > 0 ? `还有 ${Math.floor(diff/60) ? Math.floor(diff/60)+' 小时 ' : ''}${diff%60} 分钟` : '即将触发';
  metaEl.textContent = `${repeatLabel(next)} · ${diffText}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- 弹层控制 ----------
function openSheet(id) {
  document.getElementById(id + '-mask').classList.add('show');
  document.getElementById(id + '-sheet').classList.add('show');
}
function closeSheet(id) {
  document.getElementById(id + '-mask').classList.remove('show');
  document.getElementById(id + '-sheet').classList.remove('show');
}

// ---------- 任务表单 ----------
let editing = null;
let formData = { days: [], action: 'sound', sound: 'stitch' };

function openTaskSheet(task) {
  editing = task || null;
  document.getElementById('sheet-title').textContent = task ? '编辑任务' : '新建任务';

  if (task) {
    document.getElementById('f-name').value = task.name;
    document.getElementById('f-time').value = task.time;
    document.getElementById('f-voice').value = task.voice || '';
    document.getElementById('f-volume').value = task.volume != null ? task.volume : settings.volume;
    document.getElementById('f-toyfile').value = task.toyFile || '';
    document.getElementById('f-speed').value = task.speed != null ? task.speed : 1;
    document.getElementById('f-pitch').value = task.pitch != null ? task.pitch : 1;
    document.getElementById('f-voicerate').value = task.voiceRate != null ? task.voiceRate : 1;
    formData.days = (task.days || []).slice();
    formData.action = task.action || 'sound';
    formData.sound = task.sound || 'stitch';
    if (task.repeat === 'once') formData.days = [];
  } else {
    document.getElementById('f-name').value = '';
    document.getElementById('f-time').value = '08:00';
    document.getElementById('f-voice').value = '';
    document.getElementById('f-volume').value = settings.volume;
    document.getElementById('f-toyfile').value = '';
    document.getElementById('f-speed').value = 1;
    document.getElementById('f-pitch').value = 1;
    document.getElementById('f-voicerate').value = 1;
    formData.days = [1,2,3,4,5];
    formData.action = 'sound';
    formData.sound = 'stitch';
  }
  syncFormUI();
  openSheet('task');
}

function syncFormUI() {
  document.querySelectorAll('#f-days .day').forEach(b => {
    b.classList.toggle('active', formData.days.includes(Number(b.dataset.d)));
  });
  document.querySelectorAll('#f-action button').forEach(b => {
    b.classList.toggle('active', b.dataset.a === formData.action);
  });
  document.querySelectorAll('.sound-row .sound').forEach(b => {
    b.classList.toggle('active', b.dataset.s === formData.sound);
  });
  document.getElementById('vol-val').textContent = document.getElementById('f-volume').value;
  document.getElementById('speed-val').textContent = Number(document.getElementById('f-speed').value).toFixed(2);
  document.getElementById('pitch-val').textContent = Number(document.getElementById('f-pitch').value).toFixed(2);
  document.getElementById('vr-val').textContent = Number(document.getElementById('f-voicerate').value).toFixed(2);
  // 显示/隐藏字段
  const a = formData.action;
  document.getElementById('field-sound').style.display = (a === 'sound' || a === 'both') ? 'block' : 'none';
  document.getElementById('field-voice').style.display = (a === 'voice' || a === 'both') ? 'block' : 'none';
}

function saveTask() {
  const name = document.getElementById('f-name').value.trim() || '未命名任务';
  const time = document.getElementById('f-time').value || '08:00';
  const voice = document.getElementById('f-voice').value.trim();
  const volume = Number(document.getElementById('f-volume').value);

  if (editing) {
    Object.assign(editing, {
      name, time, voice, volume,
      days: formData.days.slice(),
      action: formData.action,
      sound: formData.sound,
      toyFile: document.getElementById('f-toyfile').value.trim(),
      speed: Number(document.getElementById('f-speed').value),
      pitch: Number(document.getElementById('f-pitch').value),
      voiceRate: Number(document.getElementById('f-voicerate').value)
    });
  } else {
    tasks.push({
      id: Date.now(),
      name, time, voice, volume,
      days: formData.days.slice(),
      action: formData.action,
      sound: formData.sound,
      toyFile: document.getElementById('f-toyfile').value.trim(),
      speed: Number(document.getElementById('f-speed').value),
      pitch: Number(document.getElementById('f-pitch').value),
      voiceRate: Number(document.getElementById('f-voicerate').value),
      enabled: true
    });
  }
  save();
  renderList();
  renderNext();
  closeSheet('task');
  showToast(editing ? '任务已更新' : '✅ 任务已创建');
  editing = null;
}

// ---------- 蓝牙扫描 ----------
async function scanBLE() {
  const listEl = document.getElementById('ble-list');
  if (!navigator.bluetooth) {
    listEl.innerHTML = '<div class="ble-item"><span class="ble-name">⚠️ 此浏览器不支持蓝牙，请用 Chrome / Edge 打开</span></div>';
    return;
  }
  listEl.innerHTML = '<div class="ble-item"><span class="ble-name">正在搜索附近设备…</span></div>';
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ['generic_access', 'device_information']
    });
    listEl.innerHTML = `
      <div class="ble-item">
        <div><div class="ble-name">${escapeHtml(device.name || '未命名设备')}</div>
        <div style="font-size:11px;color:#6B7280;margin-top:2px">${device.id.slice(0,12)}…</div></div>
        <button id="ble-connect">连接</button>
      </div>`;
    document.getElementById('ble-connect').addEventListener('click', async () => {
      try {
        const server = await device.gatt.connect();
        showToast('✅ 已连接 ' + (device.name || '设备'));
        document.getElementById('device-name').textContent = device.name || '外接设备';
        document.getElementById('device-status').textContent = '已连接 · 通过此设备外放';
      } catch (e) {
        showToast('连接失败：' + e.message);
      }
    });
    device.addEventListener('gattserverdisconnected', () => {
      showToast('设备已断开连接');
    });
  } catch (e) {
    listEl.innerHTML = '<div class="ble-item"><span class="ble-name">未选择设备或搜索被取消</span></div>';
  }
}

// ---------- 事件绑定 ----------
document.addEventListener('DOMContentLoaded', () => {
  // 请求通知权限
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  renderList();
  renderNext();

  // 添加
  document.getElementById('btn-add').addEventListener('click', () => openTaskSheet(null));
  document.getElementById('btn-close-sheet').addEventListener('click', () => closeSheet('task'));
  document.getElementById('task-mask').addEventListener('click', () => closeSheet('task'));
  document.getElementById('btn-save').addEventListener('click', saveTask);

  // 试听
  document.getElementById('btn-test').addEventListener('click', () => {
    const vol = Number(document.getElementById('f-volume').value);
    const a = formData.action;
    const voice = document.getElementById('f-voice').value.trim();
    const sp = Number(document.getElementById('f-speed').value);
    const pt = Number(document.getElementById('f-pitch').value);
    const vr = Number(document.getElementById('f-voicerate').value);
    if (a === 'sound' || a === 'both') playSound(formData.sound, vol, sp, pt);
    if (a === 'voice' || a === 'both') speak(voice || '这是一条语音播报测试', vol, formData.sound, vr);
  });

  // 天数
  document.querySelectorAll('#f-days .day').forEach(b => b.addEventListener('click', () => {
    const d = Number(b.dataset.d);
    const i = formData.days.indexOf(d);
    if (i >= 0) formData.days.splice(i, 1); else formData.days.push(d);
    syncFormUI();
  }));
  // 快捷重复
  document.querySelectorAll('[data-repeat]').forEach(b => b.addEventListener('click', () => {
    const r = b.dataset.repeat;
    if (r === 'daily') formData.days = [0,1,2,3,4,5,6];
    else if (r === 'weekday') formData.days = [1,2,3,4,5];
    else formData.days = [];
    syncFormUI();
    showToast(r === 'once' ? '设为仅一次' : r === 'daily' ? '设为每天' : '设为工作日');
  }));
  // 动作
  document.querySelectorAll('#f-action button').forEach(b => b.addEventListener('click', () => {
    formData.action = b.dataset.a; syncFormUI();
  }));
  // 提示音（卡通 + 基础两排）
  document.querySelectorAll('.sound-row .sound').forEach(b => b.addEventListener('click', () => {
    formData.sound = b.dataset.s; syncFormUI();
    playSound(formData.sound, Number(document.getElementById('f-volume').value), Number(document.getElementById('f-speed').value), Number(document.getElementById('f-pitch').value));
  }));
  // 音量
  document.getElementById('f-volume').addEventListener('input', (e) => {
    document.getElementById('vol-val').textContent = e.target.value;
  });
  // 节奏 / 音调 / 语音语速（拖动实时试听）
  document.getElementById('f-speed').addEventListener('input', (e) => {
    document.getElementById('speed-val').textContent = Number(e.target.value).toFixed(2);
    playSound(formData.sound, Number(document.getElementById('f-volume').value), Number(e.target.value), Number(document.getElementById('f-pitch').value));
  });
  document.getElementById('f-pitch').addEventListener('input', (e) => {
    document.getElementById('pitch-val').textContent = Number(e.target.value).toFixed(2);
    playSound(formData.sound, Number(document.getElementById('f-volume').value), Number(document.getElementById('f-speed').value), Number(e.target.value));
  });
  document.getElementById('f-voicerate').addEventListener('input', (e) => {
    document.getElementById('vr-val').textContent = Number(e.target.value).toFixed(2);
  });

  // 设置
  document.getElementById('btn-settings').addEventListener('click', () => openSheet('settings'));
  document.getElementById('btn-close-settings').addEventListener('click', () => closeSheet('settings'));
  document.getElementById('settings-mask').addEventListener('click', () => closeSheet('settings'));
  document.getElementById('s-autostart').addEventListener('change', e => { settings.autostart = e.target.checked; save(); });
  document.getElementById('s-vibrate').addEventListener('change', e => { settings.vibrate = e.target.checked; save(); });
  document.getElementById('s-dnd-from').addEventListener('change', e => { settings.dndFrom = e.target.value; save(); });
  document.getElementById('s-dnd-to').addEventListener('change', e => { settings.dndTo = e.target.value; save(); });
  // 蓝牙喇叭
  document.getElementById('btn-ble-connect').addEventListener('click', bleConnect);
  document.getElementById('btn-ble-sync').addEventListener('click', async () => {
    if (!bleChar) { setBleStatus('请先连接蓝牙设备', 'bad'); return; }
    setBleStatus('正在同步日程…');
    await bleSyncTime();
    await bleSyncTasks();
    setBleStatus('✅ 日程已同步到玩偶', 'ok');
    showToast('日程已同步到玩偶');
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('确定清空所有任务吗？此操作不可恢复。')) {
      tasks = []; save(); renderList(); renderNext(); closeSheet('settings');
      showToast('已清空所有任务');
    }
  });

  // 外接设备
  document.getElementById('btn-devices').addEventListener('click', () => openSheet('device'));
  document.getElementById('btn-close-device').addEventListener('click', () => closeSheet('device'));
  document.getElementById('device-mask').addEventListener('click', () => closeSheet('device'));
  document.getElementById('btn-scan').addEventListener('click', scanBLE);

  // 首次进入，解锁音频（移动端需用户手势）
  document.body.addEventListener('click', () => { try { getCtx(); } catch(e){} }, { once: true });
});

// Service Worker（后台/离线支持）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
