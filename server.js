require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { admin, db, rtdb } = require('./firebase');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.get('/', function (req, res) {
  res.json({ status: 'ok', message: 'Clur Mini App Engine running' });
});

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function verifyInit(initData, botToken) {
  try {
    var params = new URLSearchParams(initData);
    var hash = params.get('hash');
    params.delete('hash');
    var keys = [];
    params.forEach(function (v, k) { keys.push(k); });
    keys.sort();
    var dcs = keys.map(function (k) { return k + '=' + params.get(k); }).join('\n');
    var secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    var calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    return calc === hash;
  } catch (e) { return false; }
}

function adminOk(cfg, req) {
  var key = req.headers['x-mini-admin'] || '';
  if (process.env.ADMIN_KEY && key === process.env.ADMIN_KEY) return true;
  if (cfg.adminPassword && key === cfg.adminPassword) return true;
  return false;
}

async function logActivity(botId, text, icon) {
  if (!rtdb) return;
  try {
    await rtdb.ref('activities/' + botId).push({ text: text, icon: icon || 'bolt', date: Date.now() });
    var old = await rtdb.ref('activities/' + botId).limitToFirst(1).get();
    if (old.exists()) {
      old.forEach(function (c) {        if (Date.now() - (c.val().date || 0) > 7 * 86400000) c.ref.remove();
      });
    }
  } catch (e) {}
}

async function syncLeaderboard(botId, uid, u) {
  if (!rtdb) return;
  try {
    await rtdb.ref('leaderboard/' + botId + '/' + uid).set({
      name: u.firstName || u.username || ('user' + uid),
      refs: u.referrals || 0,
      balance: u.balance || 0
    });
  } catch (e) {}
}

async function getUserDoc(botId, uid) {
  var ref = db.collection('miniApps').doc(botId).collection('users').doc(String(uid));
  var snap = await ref.get();
  if (!snap.exists) {
    var data = { telegramId: uid, firstName: '', username: '', balance: 0, referrals: 0, referredBy: null, banned: false, completedTaskIds: [], streak: 0, lastDaily: '', joinedAt: new Date().toISOString() };
    await ref.set(data);
    return data;
  }
  return snap.data();
}

async function checkMustJoin(cfg, userId) {
  var list = [];
  if (cfg.mainChannel && cfg.mainMustJoin) list.push(cfg.mainChannel);
  if (cfg.prChannel && cfg.prMustJoin) list.push(cfg.prChannel);
  for (var i = 0; i < list.length; i++) {
    try {
      var r = await axios.post('https://api.telegram.org/bot' + cfg.botToken + '/getChatMember', { chat_id: list[i], user_id: userId }, { timeout: 5000 });
      var st = r.data.result && r.data.result.status;
      if (['creator', 'administrator', 'member', 'restricted'].indexOf(st) === -1) return false;
    } catch (e) { return true; }
  }
  return true;
}

function buildWelcomeKeyboard(cfg) {
  var kb = [];
  kb.push([{ text: '📢 Official Channel: @DAILYUUPA', url: 'https://t.me/DAILYUUPA' }]);
  if (cfg.mainChannel) kb.push([{ text: '📢 Main Channel: ' + cfg.mainChannel, url: 'https://t.me/' + String(cfg.mainChannel).replace('@', '') }]);
  if (cfg.prChannel) kb.push([{ text: '📣 PR Channel: ' + cfg.prChannel, url: 'https://t.me/' + String(cfg.prChannel).replace('@', '') }]);
  kb.push([{ text: '🎮 Open ' + cfg.appName, web_app: { url: cfg.miniUrl } }]);
  return kb;
}
function buildWelcomeText(cfg) {
  var t = cfg.tokenName || 'TON';
  var lines = [];
  lines.push('🌟 ══════════════════ 🌟');
  lines.push('');
  lines.push('💎 <b>' + escHtml(cfg.appName) + '</b> 💎');
  lines.push('');
  lines.push('🌟 ══════════════════ 🌟');
  lines.push('');
  lines.push(escHtml(cfg.description || 'Complete tasks and earn rewards!'));
  lines.push('');
  lines.push('┌─────────────────────┐');
  lines.push('    🚀 <b>HOW IT WORKS</b>');
  lines.push('└─────────────────────┘');
  lines.push('1️⃣ Join our 3 channels below');
  lines.push('2️⃣ Tap <b>🎮 Open ' + escHtml(cfg.appName) + '</b>');
  lines.push('3️⃣ Complete tasks & earn ' + escHtml(t));
  lines.push('4️⃣ Invite friends → +' + (cfg.refBonus || 0) + ' ' + escHtml(t) + ' each');
  lines.push('5️⃣ Withdraw from ' + (cfg.minW || 0) + ' ' + escHtml(t));
  lines.push('');
  lines.push('⚡ <b>Start earning now!</b> ⚡');
  return lines.join('\n');
}

app.post('/api/create-mini-app', async function (req, res) {
  try {
    var data = req.body;
    if (!data.botToken || !data.ownerId || !data.appName) return res.status(400).json({ error: 'Missing required fields' });
    var verifyRes = await axios.get('https://api.telegram.org/bot' + data.botToken + '/getMe', { timeout: 5000 });
    if (!verifyRes.data.ok) return res.status(400).json({ error: 'Invalid bot token' });
    var botUsername = verifyRes.data.result.username;
    var baseUrl = process.env.BACKEND_PUBLIC_URL || 'https://your-mini-backend.onrender.com';
    var miniData = {
      ownerId: data.ownerId,
      botToken: data.botToken,
      botUsername: botUsername,
      appName: data.appName,
      description: data.description || 'Complete tasks and earn rewards!',
      tokenName: data.tokenName || 'TON',
      refBonus: parseFloat(data.refBonus) || 0.002,
      minW: parseFloat(data.minW) || 0.05,
      maxW: parseFloat(data.maxW) || 100,
      adminPassword: data.adminPassword || 'admin123',
      officialChannel: '@DAILYUUPA',
      mainChannel: data.mainChannel || '',
      mainMustJoin: data.mainMustJoin === true,
      prChannel: data.prChannel || '',
      prMustJoin: data.prMustJoin === true,
      dailyBonusOn: data.dailyBonusOn === true,      dailyBonusAmt: parseFloat(data.dailyBonusAmt) || 0.001,
      status: 'active',
      users: 0,
      createdAt: new Date().toISOString()
    };
    var docRef = await db.collection('miniApps').add(miniData);
    var botId = docRef.id;
    var miniUrl = baseUrl + '/mini/' + botId;
    await db.collection('miniApps').doc(botId).update({ miniUrl: miniUrl });
    await axios.post('https://api.telegram.org/bot' + data.botToken + '/setWebhook', {
      url: baseUrl + '/mini-bot/' + botId + '/webhook',
      drop_pending_updates: true
    }).catch(function () {});
    res.json({ success: true, botId: botId, botUsername: botUsername, miniUrl: miniUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/mini/:botId', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).send('Mini App not found');
    var cfg = doc.data();
    var file = path.join(__dirname, 'public', 'miniapp.html');
    var html = fs.readFileSync(file, 'utf8');
    var inject = '<script>' +
      'window.APP_ID="' + req.params.botId + '";' +
      'window.APP_NAME="' + escHtml(cfg.appName).replace(/"/g, '') + '";' +
      'window.BOT_USERNAME="' + cfg.botUsername + '";' +
      'window.MINI_API="' + (process.env.BACKEND_PUBLIC_URL || '') + '";' +
      'window.RTDB_URL="' + (process.env.RTDB_URL || '') + '";' +
      'window.FB_API_KEY="' + (process.env.MINI_FB_API_KEY || '') + '";' +
      '</script>';
    html = html.replace('</head>', inject + '</head>');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    res.status(500).send('Error loading mini app');
  }
});

app.post('/mini-bot/:botId/webhook', async function (req, res) {
  try {
    var update = req.body;
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.sendStatus(200);
    var cfg = doc.data();
    var token = cfg.botToken;
    if (update.callback_query && update.callback_query.data === 'check_join') {
      var cq = update.callback_query;
      var okJoin = await checkMustJoin(cfg, cq.from.id);
      if (okJoin) {
        await axios.post('https://api.telegram.org/bot' + token + '/answerCallbackQuery', { callback_query_id: cq.id, text: 'Verified! Welcome in!' }).catch(function () {});
        await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', {
          chat_id: cq.message.chat.id,
          text: buildWelcomeText(cfg),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: buildWelcomeKeyboard(cfg) }
        });
      } else {
        await axios.post('https://api.telegram.org/bot' + token + '/answerCallbackQuery', { callback_query_id: cq.id, text: 'Not joined yet!', show_alert: true }).catch(function () {});
      }
      return res.sendStatus(200);
    }

    if (update.message && update.message.text && update.message.text.indexOf('/start') === 0) {
      var chatId = update.message.chat.id;
      var userId = update.message.from.id;
      var parts = update.message.text.split(' ');
      var refId = parts[1] || '';
      var usersCol = db.collection('miniApps').doc(botId).collection('users');
      var userSnap = await usersCol.doc(String(userId)).get();

      if (refId && refId !== String(userId) && !userSnap.exists) {
        var refSnap = await usersCol.doc(refId).get();
        if (refSnap.exists) {
          var rd = refSnap.data();
          await usersCol.doc(refId).update({
            referrals: (rd.referrals || 0) + 1,
            balance: (rd.balance || 0) + (cfg.refBonus || 0)
          });
          await syncLeaderboard(botId, refId, Object.assign({}, rd, { referrals: (rd.referrals || 0) + 1, balance: (rd.balance || 0) + (cfg.refBonus || 0) }));
          await logActivity(botId, '🎁 Referral bonus earned', 'gift');
          await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', {
            chat_id: refId,
            text: '🎉 <b>New referral!</b> You earned ' + (cfg.refBonus || 0) + ' ' + cfg.tokenName + '!',
            parse_mode: 'HTML'
          }).catch(function () {});
        }
      }

      if (!userSnap.exists) {
        await usersCol.doc(String(userId)).set({
          telegramId: userId,
          firstName: update.message.from.first_name || '',
          username: update.message.from.username || '',          referredBy: refId || null,
          balance: 0,
          referrals: 0,
          banned: false,
          completedTaskIds: [],
          streak: 0,
          lastDaily: '',
          joinedAt: new Date().toISOString()
        });
        await db.collection('miniApps').doc(botId).update({ users: (cfg.users || 0) + 1 });
        await logActivity(botId, '🎉 ' + (update.message.from.first_name || 'A user') + ' joined', 'user-plus');
        await syncLeaderboard(botId, userId, { firstName: update.message.from.first_name, referrals: 0, balance: 0 });
      }

      var okJoin2 = await checkMustJoin(cfg, userId);
      if (!okJoin2) {
        var gateKb = [];
        if (cfg.mainChannel && cfg.mainMustJoin) gateKb.push([{ text: '📢 Join Main Channel: ' + cfg.mainChannel, url: 'https://t.me/' + String(cfg.mainChannel).replace('@', '') }]);
        if (cfg.prChannel && cfg.prMustJoin) gateKb.push([{ text: '📣 Join PR Channel: ' + cfg.prChannel, url: 'https://t.me/' + String(cfg.prChannel).replace('@', '') }]);
        gateKb.push([{ text: '✅ I Have Joined', callback_data: 'check_join' }]);
        await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', {
          chat_id: chatId,
          text: '🚫 <b>JOIN REQUIRED CHANNELS FIRST</b>\n\nTap the buttons below, then press ✅ I Have Joined to enter ' + escHtml(cfg.appName) + '.',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: gateKb }
        });
        return res.sendStatus(200);
      }

      await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', {
        chat_id: chatId,
        text: buildWelcomeText(cfg),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buildWelcomeKeyboard(cfg) }
      });
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(200);
  }
});

app.post('/api/mini/:botId/userdata', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!verifyInit(req.body.initData, cfg.botToken)) return res.status(401).json({ error: 'Invalid session' });
    var params = new URLSearchParams(req.body.initData);    var tgUser = JSON.parse(params.get('user'));
    var user = await getUserDoc(req.params.botId, tgUser.id);
    var tasksSnap = await db.collection('miniApps').doc(req.params.botId).collection('tasks').get();
    var tasks = [];
    tasksSnap.forEach(function (t) { tasks.push(Object.assign({ id: t.id }, t.data())); });
    res.json({
      success: true,
      user: user,
      tasks: tasks,
      settings: {
        appName: cfg.appName,
        tokenName: cfg.tokenName,
        minW: cfg.minW,
        maxW: cfg.maxW,
        refBonus: cfg.refBonus,
        dailyBonusOn: cfg.dailyBonusOn,
        dailyBonusAmt: cfg.dailyBonusAmt,
        description: cfg.description
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/daily', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!cfg.dailyBonusOn) return res.json({ success: false, error: 'Daily bonus disabled' });
    if (!verifyInit(req.body.initData, cfg.botToken)) return res.status(401).json({ error: 'Invalid session' });
    var params = new URLSearchParams(req.body.initData);
    var tgUser = JSON.parse(params.get('user'));
    var ref = db.collection('miniApps').doc(botId).collection('users').doc(String(tgUser.id));
    var user = await getUserDoc(botId, tgUser.id);
    var today = new Date().toDateString();
    if (user.lastDaily === today) return res.json({ success: false, error: 'Already claimed today' });
    var streak = 1;
    if (user.lastDaily && new Date(user.lastDaily).toDateString() === new Date(Date.now() - 86400000).toDateString()) streak = (user.streak || 0) + 1;
    var amt = cfg.dailyBonusAmt || 0;
    await ref.update({ balance: (user.balance || 0) + amt, lastDaily: today, streak: streak });
    await syncLeaderboard(botId, tgUser.id, Object.assign({}, user, { balance: (user.balance || 0) + amt }));
    await logActivity(botId, '🎁 Daily bonus claimed', 'gift');
    res.json({ success: true, amount: amt, streak: streak });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/proof', async function (req, res) {
  try {
    var botId = req.params.botId;    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!verifyInit(req.body.initData, cfg.botToken)) return res.status(401).json({ error: 'Invalid session' });
    var params = new URLSearchParams(req.body.initData);
    var tgUser = JSON.parse(params.get('user'));
    var user = await getUserDoc(botId, tgUser.id);
    if (user.banned) return res.status(403).json({ error: 'Account banned' });
    var taskId = req.body.taskId;
    var handle = req.body.handle || '';
    var proofImg = req.body.proof || '';
    if (!taskId || !handle || !proofImg) return res.status(400).json({ error: 'Missing fields' });
    if ((user.completedTaskIds || []).indexOf(taskId) !== -1) return res.json({ success: false, error: 'Already completed' });
    var taskSnap = await db.collection('miniApps').doc(botId).collection('tasks').doc(taskId).get();
    if (!taskSnap.exists) return res.status(404).json({ error: 'Task not found' });
    var task = taskSnap.data();
    await db.collection('miniApps').doc(botId).collection('proofs').add({
      userId: tgUser.id,
      userName: user.firstName || user.username || ('user' + tgUser.id),
      taskId: taskId,
      taskName: task.name,
      reward: task.reward || 0,
      handle: handle,
      proof: proofImg,
      status: 'pending',
      date: Date.now()
    });
    res.json({ success: true, message: 'Submitted for review' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/withdraw', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!verifyInit(req.body.initData, cfg.botToken)) return res.status(401).json({ error: 'Invalid session' });
    var params = new URLSearchParams(req.body.initData);
    var tgUser = JSON.parse(params.get('user'));
    var ref = db.collection('miniApps').doc(botId).collection('users').doc(String(tgUser.id));
    var user = await getUserDoc(botId, tgUser.id);
    if (user.banned) return res.status(403).json({ error: 'Account banned' });
    var amt = parseFloat(req.body.amount) || 0;
    var address = req.body.address || '';
    if (!amt || !address) return res.status(400).json({ error: 'Missing fields' });
    if (amt < (cfg.minW || 0)) return res.json({ success: false, error: 'Below minimum' });
    if (amt > (cfg.maxW || 999999)) return res.json({ success: false, error: 'Above maximum' });
    if (amt > (user.balance || 0)) return res.json({ success: false, error: 'Insufficient balance' });
    await ref.update({ balance: (user.balance || 0) - amt });    await db.collection('miniApps').doc(botId).collection('withdrawals').add({
      userId: tgUser.id,
      userName: user.firstName || user.username || ('user' + tgUser.id),
      amount: amt,
      address: address,
      status: 'pending',
      date: Date.now()
    });
    await logActivity(botId, '💸 Withdrawal requested', 'paper-plane');
    res.json({ success: true, message: 'Withdrawal pending approval' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/chat', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!verifyInit(req.body.initData, cfg.botToken)) return res.status(401).json({ error: 'Invalid session' });
    var params = new URLSearchParams(req.body.initData);
    var tgUser = JSON.parse(params.get('user'));
    var text = req.body.text || '';
    if (!text) return res.status(400).json({ error: 'Empty message' });
    await db.collection('miniApps').doc(botId).collection('chats').doc(String(tgUser.id)).set({
      userId: tgUser.id,
      userName: tgUser.first_name || ('user' + tgUser.id),
      lastMsg: text,
      lastDate: Date.now()
    }, { merge: true });
    await db.collection('miniApps').doc(botId).collection('chats').doc(String(tgUser.id)).collection('messages').add({
      from: 'user', text: text, date: Date.now()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/chat', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!verifyInit(String(req.query.initData || ''), cfg.botToken)) return res.status(401).json({ error: 'Invalid session' });
    var params = new URLSearchParams(String(req.query.initData || ''));
    var tgUser = JSON.parse(params.get('user'));
    var snap = await db.collection('miniApps').doc(botId).collection('chats').doc(String(tgUser.id)).collection('messages').orderBy('date', 'asc').limitToLast ? await db.collection('miniApps').doc(botId).collection('chats').doc(String(tgUser.id)).collection('messages').orderBy('date', 'asc').get() : null;
    var msgs = [];
    if (snap) snap.forEach(function (m) { msgs.push(Object.assign({ id: m.id }, m.data())); });
    res.json({ success: true, messages: msgs });  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/admin/users', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var snap = await db.collection('miniApps').doc(req.params.botId).collection('users').get();
    var users = [];
    snap.forEach(function (u) { users.push(Object.assign({ id: u.id }, u.data())); });
    res.json({ success: true, users: users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/users/:uid/update', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var ref = db.collection('miniApps').doc(botId).collection('users').doc(req.params.uid);
    var snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    var u = snap.data();
    var patch = {};
    if (req.body.banned !== undefined) patch.banned = req.body.banned === true;
    if (req.body.addBalance !== undefined) patch.balance = (u.balance || 0) + (parseFloat(req.body.addBalance) || 0);
    if (req.body.firstName !== undefined) patch.firstName = req.body.firstName;
    await ref.update(patch);
    await syncLeaderboard(botId, req.params.uid, Object.assign({}, u, patch));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/admin/proofs', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var snap = await db.collection('miniApps').doc(req.params.botId).collection('proofs').where('status', '==', 'pending').get();
    var proofs = [];
    snap.forEach(function (p) { proofs.push(Object.assign({ id: p.id }, p.data())); });
    res.json({ success: true, proofs: proofs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/proofs/:proofId/resolve', async function (req, res) {
  try {
    var botId = req.params.botId;    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var proofRef = db.collection('miniApps').doc(botId).collection('proofs').doc(req.params.proofId);
    var proofSnap = await proofRef.get();
    if (!proofSnap.exists) return res.status(404).json({ error: 'Proof not found' });
    var p = proofSnap.data();
    if (req.body.approve === true) {
      var userRef = db.collection('miniApps').doc(botId).collection('users').doc(String(p.userId));
      var userSnap = await userRef.get();
      if (userSnap.exists) {
        var ud = userSnap.data();
        await userRef.update({
          balance: (ud.balance || 0) + (parseFloat(p.reward) || 0),
          completedTaskIds: admin.firestore.FieldValue.arrayUnion(p.taskId)
        });
        await syncLeaderboard(botId, p.userId, Object.assign({}, ud, { balance: (ud.balance || 0) + (parseFloat(p.reward) || 0) }));
      }
      await logActivity(botId, '✅ ' + (p.userName || 'A user') + ' completed a task', 'check-circle');
    }
    await proofRef.delete();
    res.json({ success: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/admin/withdrawals', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var snap = await db.collection('miniApps').doc(req.params.botId).collection('withdrawals').where('status', '==', 'pending').get();
    var list = [];
    snap.forEach(function (w) { list.push(Object.assign({ id: w.id }, w.data())); });
    res.json({ success: true, withdrawals: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/withdrawals/:wId/resolve', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var wRef = db.collection('miniApps').doc(botId).collection('withdrawals').doc(req.params.wId);
    var wSnap = await wRef.get();
    if (!wSnap.exists) return res.status(404).json({ error: 'Not found' });
    var w = wSnap.data();
    if (req.body.approve !== true) {
      var userRef = db.collection('miniApps').doc(botId).collection('users').doc(String(w.userId));
      var userSnap = await userRef.get();      if (userSnap.exists) {
        var ud = userSnap.data();
        await userRef.update({ balance: (ud.balance || 0) + (parseFloat(w.amount) || 0) });
        await syncLeaderboard(botId, w.userId, Object.assign({}, ud, { balance: (ud.balance || 0) + (parseFloat(w.amount) || 0) }));
      }
    } else {
      await logActivity(botId, '💰 ' + (w.userName || 'A user') + ' got paid', 'money-bill');
    }
    await wRef.delete();
    res.json({ success: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/admin/tasks', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var snap = await db.collection('miniApps').doc(req.params.botId).collection('tasks').get();
    var tasks = [];
    snap.forEach(function (t) { tasks.push(Object.assign({ id: t.id }, t.data())); });
    res.json({ success: true, tasks: tasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/tasks', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var b = req.body;
    if (!b.name) return res.status(400).json({ error: 'Name required' });
    await db.collection('miniApps').doc(botId).collection('tasks').add({
      name: b.name,
      url: b.url || '',
      reward: parseFloat(b.reward) || 0,
      category: b.category || 'social',
      createdAt: Date.now()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mini/:botId/admin/tasks/:taskId', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    await db.collection('miniApps').doc(req.params.botId).collection('tasks').doc(req.params.taskId).delete();    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/broadcast', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    var cfg = doc.data();
    if (!adminOk(cfg, req)) return res.status(403).json({ error: 'Invalid admin key' });
    var text = req.body.text || '';
    if (!text) return res.status(400).json({ error: 'Empty message' });
    var snap = await db.collection('miniApps').doc(botId).collection('users').get();
    var sent = 0;
    for (var i = 0; i < snap.docs.length; i++) {
      var u = snap.docs[i].data();
      try {
        await axios.post('https://api.telegram.org/bot' + cfg.botToken + '/sendMessage', {
          chat_id: u.telegramId,
          text: text,
          parse_mode: 'HTML'
        });
        sent++;
      } catch (e) {}
    }
    res.json({ success: true, sent: sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/admin/chats', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var snap = await db.collection('miniApps').doc(req.params.botId).collection('chats').get();
    var chats = [];
    snap.forEach(function (c) { chats.push(Object.assign({ id: c.id }, c.data())); });
    chats.sort(function (a, b) { return (b.lastDate || 0) - (a.lastDate || 0); });
    res.json({ success: true, chats: chats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mini/:botId/admin/chats/:uid', async function (req, res) {
  try {
    var doc = await db.collection('miniApps').doc(req.params.botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var snap = await db.collection('miniApps').doc(req.params.botId).collection('chats').doc(req.params.uid).collection('messages').orderBy('date', 'asc').get();
    var msgs = [];    snap.forEach(function (m) { msgs.push(Object.assign({ id: m.id }, m.data())); });
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/chats/:uid/send', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var text = req.body.text || '';
    if (!text) return res.status(400).json({ error: 'Empty message' });
    await db.collection('miniApps').doc(botId).collection('chats').doc(req.params.uid).collection('messages').add({
      from: 'admin', text: text, date: Date.now()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mini/:botId/admin/settings', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!adminOk(doc.data(), req)) return res.status(403).json({ error: 'Invalid admin key' });
    var b = req.body;
    var patch = {};
    if (b.tokenName !== undefined) patch.tokenName = b.tokenName;
    if (b.minW !== undefined) patch.minW = parseFloat(b.minW) || 0;
    if (b.maxW !== undefined) patch.maxW = parseFloat(b.maxW) || 100;
    if (b.refBonus !== undefined) patch.refBonus = parseFloat(b.refBonus) || 0;
    if (b.dailyBonusOn !== undefined) patch.dailyBonusOn = b.dailyBonusOn === true;
    if (b.dailyBonusAmt !== undefined) patch.dailyBonusAmt = parseFloat(b.dailyBonusAmt) || 0;
    if (b.description !== undefined) patch.description = b.description;
    if (b.mainChannel !== undefined) patch.mainChannel = b.mainChannel;
    if (b.prChannel !== undefined) patch.prChannel = b.prChannel;
    if (b.mainMustJoin !== undefined) patch.mainMustJoin = b.mainMustJoin === true;
    if (b.prMustJoin !== undefined) patch.prMustJoin = b.prMustJoin === true;
    if (b.adminPassword !== undefined && b.adminPassword) patch.adminPassword = b.adminPassword;
    await db.collection('miniApps').doc(botId).update(patch);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mini/:botId', async function (req, res) {
  try {
    var botId = req.params.botId;
    var doc = await db.collection('miniApps').doc(botId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });    var cfg = doc.data();
    if (!adminOk(cfg, req)) return res.status(403).json({ error: 'Invalid admin key' });
    var cols = ['users', 'proofs', 'withdrawals', 'tasks', 'chats'];
    for (var c = 0; c < cols.length; c++) {
      var snap = await db.collection('miniApps').doc(botId).collection(cols[c]).get();
      for (var i = 0; i < snap.docs.length; i++) {
        await snap.docs[i].ref.delete();
      }
    }
    await db.collection('miniApps').doc(botId).delete();
    if (rtdb) {
      await rtdb.ref('activities/' + botId).remove().catch(function () {});
      await rtdb.ref('leaderboard/' + botId).remove().catch(function () {});
    }
    try { await axios.post('https://api.telegram.org/bot' + cfg.botToken + '/deleteWebhook'); } catch (e) {}
    res.json({ success: true, message: 'Mini app and ALL its data deleted permanently' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('🚀 Clur Mini App Engine running on port ' + PORT);
});
