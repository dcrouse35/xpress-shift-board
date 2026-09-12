const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { LOTS, DEFAULT_ROSTER } = require('../shared/constants');

const app = express();
const PORT = process.env.PORT || 3000;

// Session secret persists to disk so logins survive a server restart.
// Lives next to db.json — same DATA_DIR override applies (see server/db.js).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SECRET_PATH = path.join(DATA_DIR, '.session-secret');
function getSecret() {
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch (e) {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret);
    return secret;
  }
}

const isProd = process.env.NODE_ENV === 'production';
if (isProd) app.set('trust proxy', 1); // behind Render's HTTPS-terminating proxy

app.use(express.json());
app.use(session({
  secret: getSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// ---------- helpers ----------
function uid(prefix) {
  return (prefix || 'id') + '_' + crypto.randomBytes(6).toString('hex');
}

function publicEmployee(e) {
  if (!e) return null;
  const { passwordHash, ...rest } = e;
  return rest;
}

function currentEmployee(req) {
  const id = req.session.employeeId;
  if (!id) return null;
  return db.data.employees.find(e => e.id === id) || null;
}

function requireLogin(req, res, next) {
  const emp = currentEmployee(req);
  if (!emp) return res.status(401).json({ error: 'Log in first.' });
  req.employee = emp;
  next();
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function weekDatesFrom(weekStartISO) {
  const start = new Date(weekStartISO + 'T00:00:00');
  const out = [];
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(d); }
  return out;
}

// ---------- auth ----------
app.post('/api/auth/signup', (req, res) => {
  let { name, email, phone, password, passwordConfirm } = req.body || {};
  name = (name || '').trim();
  email = (email || '').trim();
  phone = (phone || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!email || !email.includes('@') || !email.includes('.')) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!phone) return res.status(400).json({ error: 'Enter a phone number.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (password !== passwordConfirm) return res.status(400).json({ error: "Those passwords don't match." });

  const nameLower = name.toLowerCase();
  const unclaimed = db.data.employees.find(e => e.name.trim().toLowerCase() === nameLower && !e.passwordHash);
  const emailTaken = db.data.employees.find(e => e.email && e.email.toLowerCase() === email.toLowerCase() && e !== unclaimed);
  if (emailTaken) return res.status(400).json({ error: 'That email is already registered — log in instead.' });

  const passwordHash = bcrypt.hashSync(password, 10);
  let emp;
  if (unclaimed) {
    unclaimed.email = email;
    unclaimed.phone = phone;
    unclaimed.passwordHash = passwordHash;
    if (unclaimed.onboarded === undefined) unclaimed.onboarded = false;
    if (!unclaimed.lot) unclaimed.lot = 'Unassigned';
    emp = unclaimed;
  } else {
    emp = { id: uid('e'), name, email, phone, lot: 'Unassigned', passwordHash, onboarded: false };
    db.data.employees.push(emp);
  }
  req.session.employeeId = emp.id;
  db.persist();
  res.json({ employee: publicEmployee(emp) });
});

app.post('/api/auth/login', (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  const emp = db.data.employees.find(e => e.email && e.email.toLowerCase() === email);
  if (!emp || !emp.passwordHash || !bcrypt.compareSync(password, emp.passwordHash)) {
    return res.status(400).json({ error: "Email or password didn't match. Try again, or sign up if you're new." });
  }
  req.session.employeeId = emp.id;
  res.json({ employee: publicEmployee(emp) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ employee: publicEmployee(currentEmployee(req)) });
});

// ---------- employees ----------
app.get('/api/employees', (req, res) => {
  res.json({ employees: db.data.employees.map(publicEmployee) });
});

app.put('/api/employees/me', requireLogin, (req, res) => {
  const { name, email, phone, lot } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name can't be blank." });
  req.employee.name = name.trim();
  req.employee.email = (email || '').trim();
  req.employee.phone = (phone || '').trim();
  if (lot) req.employee.lot = lot;
  db.persist();
  res.json({ employee: publicEmployee(req.employee) });
});

app.put('/api/employees/me/onboard', requireLogin, (req, res) => {
  const dates = weekDatesFrom(toISO(mondayOf(new Date()))).map(toISO);
  const avail = db.data.availability[req.employee.id] || {};
  const allSet = dates.every(iso => !!avail[iso]);
  if (!allSet) return res.status(400).json({ error: 'Set a status for all 7 days first.' });
  req.employee.onboarded = true;
  db.persist();
  res.json({ employee: publicEmployee(req.employee) });
});

app.post('/api/employees/import', (req, res) => {
  const existing = new Set(db.data.employees.map(e => e.name.trim().toLowerCase()));
  let added = 0;
  DEFAULT_ROSTER.forEach(name => {
    if (!existing.has(name.toLowerCase())) {
      db.data.employees.push({ id: uid('e'), name, lot: 'Unassigned', onboarded: false });
      existing.add(name.toLowerCase());
      added++;
    }
  });
  if (added > 0) db.persist();
  res.json({ added, skipped: DEFAULT_ROSTER.length - added });
});

// ---------- availability ----------
app.get('/api/availability', (req, res) => {
  res.json({ availability: db.data.availability });
});

app.put('/api/availability/:date', requireLogin, (req, res) => {
  const date = req.params.date;
  const state = (req.body && req.body.state) || null;
  if (!db.data.availability[req.employee.id]) db.data.availability[req.employee.id] = {};
  if (state === null) delete db.data.availability[req.employee.id][date];
  else db.data.availability[req.employee.id][date] = state;
  db.persist();
  res.json({ availability: db.data.availability[req.employee.id] || {} });
});

// ---------- shifts ----------
function findShift(id) { return db.data.shifts.find(s => s.id === id); }

app.get('/api/shifts', (req, res) => {
  res.json({ shifts: db.data.shifts });
});

app.post('/api/shifts', (req, res) => {
  const { date, lot, customName, start, end, employeeId } = req.body || {};
  if (!date || !lot) return res.status(400).json({ error: 'Missing date or location.' });
  const shift = {
    id: uid('s'), date, lot,
    customName: customName || null,
    start: start || '09:00', end: end || '17:00',
    employeeIds: employeeId ? [employeeId] : [],
    draft: false
  };
  db.data.shifts.push(shift);
  db.persist();
  res.json({ shift });
});

app.post('/api/shifts/slot-assign', (req, res) => {
  const { date, lot, slotId, start, end, employeeId } = req.body || {};
  if (!date || !lot || !slotId) return res.status(400).json({ error: 'Missing fields.' });
  let shift = db.data.shifts.find(s => s.date === date && s.lot === lot && s.slotId === slotId);
  if (shift) {
    shift.employeeIds = [employeeId];
    shift.draft = true;
  } else {
    shift = { id: uid('s'), date, lot, slotId, start, end, employeeIds: [employeeId], draft: true };
    db.data.shifts.push(shift);
  }
  db.persist();
  res.json({ shift });
});

app.delete('/api/shifts/slot', (req, res) => {
  const { date, lot, slotId } = req.query;
  db.data.shifts = db.data.shifts.filter(s => !(s.date === date && s.lot === lot && s.slotId === slotId));
  db.persist();
  res.json({ ok: true });
});

app.patch('/api/shifts/:id', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  const { start, end, customName } = req.body || {};
  if (start !== undefined) shift.start = start;
  if (end !== undefined) shift.end = end;
  if (customName !== undefined) shift.customName = customName || null;
  shift.draft = true;
  db.persist();
  res.json({ shift });
});

app.delete('/api/shifts/:id', (req, res) => {
  db.data.shifts = db.data.shifts.filter(s => s.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

app.post('/api/shifts/:id/assignees', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  const employeeId = req.body && req.body.employeeId;
  if (!employeeId) return res.status(400).json({ error: 'Missing employeeId.' });
  if (!shift.employeeIds) shift.employeeIds = [];
  if (!shift.employeeIds.includes(employeeId)) shift.employeeIds.push(employeeId);
  shift.draft = true;
  db.persist();
  res.json({ shift });
});

app.delete('/api/shifts/:id/assignees/:employeeId', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  shift.employeeIds = (shift.employeeIds || []).filter(eid => eid !== req.params.employeeId);
  shift.draft = true;
  db.persist();
  res.json({ shift });
});

app.post('/api/shifts/publish', (req, res) => {
  const weekStart = req.body && req.body.weekStart;
  if (!weekStart) return res.status(400).json({ error: 'Missing weekStart.' });
  const isoSet = new Set(weekDatesFrom(weekStart).map(toISO));
  db.data.shifts.forEach(s => { if (isoSet.has(s.date)) s.draft = false; });
  db.persist();
  res.json({ ok: true });
});

// ---------- static ----------
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Xpress Shift Board running at http://localhost:${PORT}`);
});
