/**
 * Sync 727 notifier — FCM push dispatcher.
 *
 * Runs inside GitHub Actions (workflow_dispatch + 15-min schedule).
 * Auth: Application Default Credentials via Workload Identity Federation
 * (google-github-actions/auth) — no service-account keys anywhere.
 *
 * What it does on each run:
 *   1. Mentor announcements (collection `notifications`) -> role-targeted push.
 *   2. New playlist requests (`playlist_requests`, status=pending) -> admins.
 *   3. New sprint task assignments (`sprint_tasks`) -> assignees.
 *   4. Sprint task deadline reminders (due today, after 07:30 IL) -> assignees.
 *   5. Parent shift reminders (`parent_shifts`): 19:00 the day before and
 *      07:30 on the day itself (Asia/Jerusalem) -> the assigned parent.
 *      Shifts with parentId "manual" are skipped (no linked app user).
 *   6. Attendance status changes (`attendance`) -> mentors.
 *
 * Dedup state lives in Firestore `_notifier_state` (one doc per event key),
 * plus a `meta` doc with a high-watermark for create-time based events.
 * Dead FCM tokens are removed from `push_subscriptions`.
 */

const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'sync-727-1f91f' });
const db = admin.firestore();
const messaging = admin.messaging();

const SITE = 'https://sync727.netlify.app';
const TZ = 'Asia/Jerusalem';
const SKEW_MS = 10 * 60 * 1000; // tolerate client clock drift on Date.now() fields
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- time helpers (Asia/Jerusalem) ----------

function ilParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute)
  };
}

function shiftDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ilParts(new Date(Date.UTC(y, m - 1, d) + deltaDays * DAY_MS + 12 * 3600 * 1000)).dateStr;
}

function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis(); // Firestore Timestamp
  return null;
}

// ---------- dedupe state ----------

async function alreadySent(key) {
  const snap = await db.collection('_notifier_state').doc(key).get();
  return snap.exists;
}

async function markSent(key, info) {
  await db.collection('_notifier_state').doc(key).set({
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    ...info
  });
}

// ---------- push ----------

async function sendPush(subs, title, body, link) {
  const tokens = subs.map(s => s.fcmToken).filter(Boolean);
  if (tokens.length === 0) return { sent: 0, pruned: 0 };
  let sent = 0;
  let pruned = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      webpush: { fcmOptions: { link } }
    });
    sent += res.successCount;
    const toPrune = [];
    res.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        toPrune.push(chunk[idx]);
      }
    });
    for (const t of toPrune) {
      const stale = subs.filter(s => s.fcmToken === t);
      for (const s of stale) {
        try {
          await db.collection('push_subscriptions').doc(s.id)
            .update({ fcmToken: admin.firestore.FieldValue.delete() });
          pruned++;
        } catch (e) { console.error('token prune failed for', s.id, e.message); }
      }
    }
  }
  return { sent, pruned };
}

// ---------- subscriptions ----------

async function loadSubs() {
  const snap = await db.collection('push_subscriptions').get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.fcmToken);
}

async function loadAdminNames() {
  try {
    const snap = await db.collection('app_config').doc('whitelists').get();
    if (snap.exists && Array.isArray(snap.data().admins)) return snap.data().admins;
  } catch (e) { /* fall through to defaults */ }
  return ['boeing727.il@gmail.com', 'יובל'];
}

const norm = s => String(s || '').trim().toLowerCase();

function targetToRoles(target) {
  switch (target) {
    case 'members': return ['member'];
    case 'parents': return ['parent'];
    case 'mentors': return ['mentor'];
    default: return ['member', 'parent', 'mentor', 'admin'];
  }
}

// ---------- event handlers ----------

async function handleNotifications(subs, watermark) {
  const snap = await db.collection('notifications')
    .where('created_at', '>', watermark - SKEW_MS).get();
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const key = `notif:${doc.id}`;
    if (await alreadySent(key)) continue;
    const roles = targetToRoles(d.target);
    const targets = subs.filter(s => roles.includes(s.role) && s.id !== d.sender_id);
    const r = await sendPush(targets, d.title || 'עדכון', d.message || '', `${SITE}/dashboard`);
    await markSent(key, { kind: 'notification', pushed: r.sent });
    n++;
    console.log(`notification ${doc.id} -> ${r.sent} devices`);
  }
  return n;
}

async function handlePlaylistRequests(subs, adminNames, watermark) {
  const snap = await db.collection('playlist_requests')
    .where('status', '==', 'pending').get();
  const admins = subs.filter(s =>
    s.role === 'admin' || adminNames.some(a => norm(a) === norm(s.userName)));
  if (admins.length === 0) { console.log('no admin devices registered'); return 0; }
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const created = toMillis(d.created_at);
    if (created == null || created <= watermark - SKEW_MS) continue;
    const key = `plreq:${doc.id}`;
    if (await alreadySent(key)) continue;
    const isDelete = d.type === 'delete';
    const title = isDelete ? 'בקשה למחיקת שיר 🗑️' : 'בקשה חדשה להוספת שיר 🎵';
    const song = d.songTitle || (d.songData && d.songData.title) || '';
    const body = isDelete
      ? `${d.requested_by_name || 'חבר צוות'} ביקש למחוק את השיר "${song}"`
      : `${d.requested_by_name || 'חבר צוות'} ביקש להוסיף את השיר: ${song}`;
    const r = await sendPush(admins, title, body, `${SITE}/dashboard/playlist`);
    await markSent(key, { kind: 'playlist_request', pushed: r.sent });
    n++;
    console.log(`playlist request ${doc.id} -> ${r.sent} admin devices`);
  }
  return n;
}

function taskAssigneeIds(task) {
  if (Array.isArray(task.assignees) && task.assignees.length > 0) {
    return task.assignees.map(a => a.id).filter(Boolean);
  }
  return task.assignee_id ? [task.assignee_id] : [];
}

async function handleNewTasks(subs, watermark) {
  const snap = await db.collection('sprint_tasks')
    .where('created_at', '>', admin.firestore.Timestamp.fromMillis(Math.max(0, watermark - SKEW_MS))).get();
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const ids = taskAssigneeIds(d);
    if (ids.length === 0) continue; // group tasks: no specific assignee
    const key = `task-new:${doc.id}`;
    if (await alreadySent(key)) continue;
    const targets = subs.filter(s => ids.includes(s.id));
    const r = await sendPush(targets, 'משימה חדשה שובצה אליך 📋',
      `${d.title || 'משימה'} (יעד: ${d.deadline_date || 'ללא'})`, `${SITE}/dashboard`);
    await markSent(key, { kind: 'task_new', pushed: r.sent });
    n++;
    console.log(`new task ${doc.id} -> ${r.sent} devices`);
  }
  return n;
}

async function handleTaskDeadlines(subs, il) {
  if (il.minutes < 7 * 60 + 30 || il.minutes >= 12 * 60) return 0; // 07:30-12:00 IL window
  const snap = await db.collection('sprint_tasks')
    .where('deadline_date', '==', il.dateStr).get();
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.status === 'done') continue;
    const ids = taskAssigneeIds(d);
    if (ids.length === 0) continue;
    const key = `task-due:${doc.id}:${il.dateStr}`;
    if (await alreadySent(key)) continue;
    const targets = subs.filter(s => ids.includes(s.id));
    const r = await sendPush(targets, 'משימה לסיום היום ⏰',
      `המשימה "${d.title || 'משימה'}" מסתיימת היום`, `${SITE}/dashboard`);
    await markSent(key, { kind: 'task_due', pushed: r.sent });
    n++;
    console.log(`task due ${doc.id} -> ${r.sent} devices`);
  }
  return n;
}

async function handleParentShifts(subs, il) {
  const snap = await db.collection('parent_shifts').get();
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!d.parentId || d.parentId === 'manual') continue; // unlinked manual shift
    const parent = subs.filter(s => s.id === d.parentId);
    if (parent.length === 0) continue;
    const timeRange = `${d.startTime || ''}-${d.endTime || ''}`;
    // day-before reminder at 19:00 IL
    if (il.dateStr === shiftDateStr(d.date, -1) && il.minutes >= 19 * 60) {
      const key = `shift:${doc.id}:eve`;
      if (!(await alreadySent(key))) {
        const r = await sendPush(parent, 'תזכורת: משמרת הורים מחר 👋',
          `מחר ${d.date} את/ה במשמרת ${timeRange}`, `${SITE}/dashboard`);
        await markSent(key, { kind: 'shift_eve', pushed: r.sent });
        n++;
        console.log(`shift eve ${doc.id} -> ${r.sent} devices`);
      }
    }
    // same-day reminder at 07:30 IL (until noon)
    if (il.dateStr === d.date && il.minutes >= 7 * 60 + 30 && il.minutes < 12 * 60) {
      const key = `shift:${doc.id}:morning`;
      if (!(await alreadySent(key))) {
        const r = await sendPush(parent, 'תזכורת: משמרת הורים היום 🕢',
          `היום ${d.date} את/ה במשמרת ${timeRange}`, `${SITE}/dashboard`);
        await markSent(key, { kind: 'shift_morning', pushed: r.sent });
        n++;
        console.log(`shift morning ${doc.id} -> ${r.sent} devices`);
      }
    }
  }
  return n;
}

async function handleAttendance(subs, watermark) {
  const mentors = subs.filter(s => s.role === 'mentor' || s.role === 'admin');
  if (mentors.length === 0) return 0;
  const snap = await db.collection('attendance').get();
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const updated = toMillis(d.updated_at);
    if (!d.status || updated == null || updated <= watermark - SKEW_MS) continue;
    const key = `att:${doc.id}:${updated}`;
    if (await alreadySent(key)) continue;
    if (doc.id === d.uid) { /* no-op, id is the uid */ }
    const r = await sendPush(mentors.filter(m => m.id !== doc.id),
      'עדכון נוכחות ✅',
      `${d.name || 'חבר צוות'} סימן/ה: ${d.status}${d.time ? ` (${d.time})` : ''}`,
      `${SITE}/dashboard`);
    await markSent(key, { kind: 'attendance', pushed: r.sent });
    n++;
    console.log(`attendance ${doc.id} -> ${r.sent} mentor devices`);
  }
  return n;
}

// ---------- main ----------

(async () => {
  // One-device diagnostic, never writes an in-app announcement or broadcasts.
  // Remove this branch after the acceptance test.
  if (process.env.TEST_TARGET_UID === 'member_יובל') {
    const target = await db.collection('push_subscriptions').doc('member_יובל').get();
    if (!target.exists || !target.data().fcmToken) throw new Error('test target token not registered');
    const r = await sendPush([{ id: target.id, ...target.data() }],
      'SYNC 727', 'בדיקת התראה', SITE + '/dashboard');
    console.log('single-device test:', JSON.stringify(r));
    if (r.sent !== 1) throw new Error('single-device test was not accepted by FCM');
    return;
  }
  if (process.env.TEST_TARGET_UID) throw new Error('unsupported test target');
  const runStart = Date.now();
  const il = ilParts();
  console.log(`notifier run at ${new Date(runStart).toISOString()} (IL ${il.dateStr} ${String(Math.floor(il.minutes / 60)).padStart(2, '0')}:${String(il.minutes % 60).padStart(2, '0')})`);

  const metaRef = db.collection('_notifier_state').doc('meta');
  const meta = await metaRef.get();
  const watermark = meta.exists && typeof meta.data().lastRunAt === 'number'
    ? meta.data().lastRunAt
    : runStart; // bootstrap: only future events trigger push

  const [subs, adminNames] = await Promise.all([loadSubs(), loadAdminNames()]);
  console.log(`subscriptions with FCM tokens: ${subs.length}`);

  const counts = {};
  counts.notifications = await handleNotifications(subs, watermark);
  counts.playlistRequests = await handlePlaylistRequests(subs, adminNames, watermark);
  counts.newTasks = await handleNewTasks(subs, watermark);
  counts.taskDeadlines = await handleTaskDeadlines(subs, il);
  counts.parentShifts = await handleParentShifts(subs, il);
  counts.attendance = await handleAttendance(subs, watermark);

  await metaRef.set({ lastRunAt: runStart }, { merge: true });
  console.log('done:', JSON.stringify(counts));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
