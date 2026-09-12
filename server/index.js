const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { sendEmail } = require('./email');
const { LOTS, DEFAULT_ROSTER, POSITION_COLORS, DAILY_TEMPLATES, slotApplies } = require('../shared/constants');

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

// Wages are sensitive — never included in the general employee list that
// every signed-in user (including coworkers) can read.
function publicEmployee(e) {
  if (!e) return null;
  const { passwordHash, hourlyWage, positionWages, ...rest } = e;
  return rest;
}
// Used only for responses the requesting admin/supervisor is entitled to see
// about themselves or in a wage-aware context.
function adminEmployee(e) {
  if (!e) return null;
  const { passwordHash, ...rest } = e;
  return rest;
}

function currentEmployee(req) {
  const id = req.session.employeeId;
  if (!id) return null;
  return db.data.employees.find(e => e.id === id) || null;
}

function currentAdmin(req) {
  const id = req.session.adminId;
  if (!id) return null;
  return db.data.admins.find(a => a.id === id) || null;
}

function publicAdmin(a) {
  if (!a) return null;
  const { passwordHash, ...rest } = a;
  return rest;
}

function requireLogin(req, res, next) {
  const emp = currentEmployee(req);
  if (!emp) return res.status(401).json({ error: 'Log in first.' });
  req.employee = emp;
  next();
}

// Full admin only — role is missing on legacy accounts created before the
// supervisor tier existed, so anything except an explicit 'supervisor' counts.
function requireAdmin(req, res, next) {
  const admin = currentAdmin(req);
  if (!admin || admin.role === 'supervisor') return res.status(403).json({ error: 'Admins only.' });
  req.admin = admin;
  next();
}

// Admin or supervisor — schedule-building access, but not staff-directory
// management, time-off approval, or positions/wage editing.
function requireScheduler(req, res, next) {
  const admin = currentAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admins or supervisors only.' });
  req.admin = admin;
  next();
}

// Any signed-in identity (staff or admin) — used to gate reads now that
// nothing in the app is visible without logging in.
function requireAnyAuth(req, res, next) {
  const emp = currentEmployee(req);
  const admin = currentAdmin(req);
  if (!emp && !admin) return res.status(401).json({ error: 'Log in first.' });
  req.employee = emp;
  req.admin = admin;
  next();
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function fmt12(t) {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + pad(m) + ' ' + ap;
}
function describeShiftForEmail(shift) {
  if (!shift) return '';
  let label;
  if (shift.slotId) {
    const template = (DAILY_TEMPLATES[shift.lot] || []).find(sl => sl.id === shift.slotId);
    label = shift.lot + (template ? ' — ' + template.label : '');
  } else {
    label = shift.lot + (shift.customName ? ' — ' + shift.customName : ' — Extra shift');
  }
  return `${label} on ${shift.date}, ${fmt12(shift.start)}–${fmt12(shift.end)}`;
}
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

// Weekly availability is open for changes Monday until 9pm business time,
// then locked for the rest of the week — so people can't flip their pattern
// after the schedule's already been built around it. Time-off requests
// remain the way to handle a one-off exception any time. Computed in the
// business's own timezone, not the server's, so it doesn't drift with
// where this happens to be hosted.
const BUSINESS_TIME_ZONE = 'America/New_York';
function isAvailabilityLocked() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23'
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = Number(parts.find(p => p.type === 'hour').value);
  if (weekday !== 'Mon') return true;
  return hour >= 21;
}

// Given a base date and a set of target JS weekdays (0=Sun..6=Sat), returns
// the ISO dates for those weekdays in the base date's own week — plus, if
// repeatWeeks > 0, the same set again for each of the following weeks.
// Used by "copy this shift to other days / future weeks". Capped for sanity.
function expandCopyDates(baseDateISO, weekdays, repeatWeeks) {
  const cappedWeeks = Math.max(0, Math.min(8, repeatWeeks || 0));
  const monday = mondayOf(new Date(baseDateISO + 'T00:00:00'));
  const out = [];
  for (let w = 0; w <= cappedWeeks; w++) {
    (weekdays || []).forEach(jsDay => {
      const offset = (jsDay === 0 ? 6 : jsDay - 1) + w * 7;
      const d = new Date(monday);
      d.setDate(monday.getDate() + offset);
      const iso = toISO(d);
      if (iso !== baseDateISO) out.push(iso);
    });
  }
  return [...new Set(out)].slice(0, 60);
}

// ---------- auth ----------
app.post('/api/auth/signup', (req, res) => {
  let { name, email, phone, password, passwordConfirm, signupCode } = req.body || {};
  const requiredCode = process.env.STAFF_SIGNUP_CODE;
  if (!requiredCode) return res.status(503).json({ error: 'Staff sign-up is not configured on this server.' });
  if (!signupCode || signupCode !== requiredCode) return res.status(403).json({ error: 'Invalid sign-up code.' });
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
    emp = unclaimed;
  } else {
    emp = { id: uid('e'), name, email, phone, passwordHash, onboarded: false };
    db.data.employees.push(emp);
  }
  req.session.employeeId = emp.id;
  delete req.session.adminId;
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
  delete req.session.adminId;
  res.json({ employee: publicEmployee(emp) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ employee: publicEmployee(currentEmployee(req)), admin: publicAdmin(currentAdmin(req)) });
});

// ---------- admin auth ----------
app.post('/api/admin/signup', (req, res) => {
  let { name, email, password, passwordConfirm, inviteCode, role } = req.body || {};
  name = (name || '').trim();
  email = (email || '').trim();
  role = role === 'supervisor' ? 'supervisor' : 'admin';
  const requiredCode = process.env.ADMIN_SIGNUP_CODE;
  if (!requiredCode) return res.status(503).json({ error: 'Admin sign-up is not configured on this server.' });
  if (!inviteCode || inviteCode !== requiredCode) return res.status(403).json({ error: 'Invalid invite code.' });
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!email || !email.includes('@') || !email.includes('.')) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (password !== passwordConfirm) return res.status(400).json({ error: "Those passwords don't match." });
  if (db.data.admins.find(a => a.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'That email is already registered as an admin — log in instead.' });
  }
  const admin = { id: uid('a'), name, email, role, passwordHash: bcrypt.hashSync(password, 10) };
  db.data.admins.push(admin);
  req.session.adminId = admin.id;
  delete req.session.employeeId;
  db.persist();
  res.json({ admin: publicAdmin(admin) });
});

app.post('/api/admin/login', (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  const admin = db.data.admins.find(a => a.email.toLowerCase() === email);
  if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
    return res.status(400).json({ error: "Email or password didn't match." });
  }
  req.session.adminId = admin.id;
  delete req.session.employeeId;
  res.json({ admin: publicAdmin(admin) });
});

app.get('/api/admins', requireAdmin, (req, res) => {
  res.json({ admins: db.data.admins.map(publicAdmin) });
});

app.delete('/api/admins/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.admin.id) return res.status(400).json({ error: "You can't remove your own account." });
  db.data.admins = db.data.admins.filter(a => a.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

// ---------- employees ----------
app.get('/api/employees', requireAnyAuth, (req, res) => {
  res.json({ employees: db.data.employees.map(publicEmployee) });
});

app.put('/api/employees/me', requireLogin, (req, res) => {
  const { name, email, phone } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name can't be blank." });
  req.employee.name = name.trim();
  req.employee.email = (email || '').trim();
  req.employee.phone = (phone || '').trim();
  db.persist();
  res.json({ employee: publicEmployee(req.employee) });
});

app.put('/api/employees/me/onboard', requireLogin, (req, res) => {
  const pattern = db.data.weeklyAvailability[req.employee.id] || {};
  const allSet = [0, 1, 2, 3, 4, 5, 6].every(day => !!pattern[day]);
  if (!allSet) return res.status(400).json({ error: 'Set a status for all 7 days first.' });
  req.employee.onboarded = true;
  db.persist();
  res.json({ employee: publicEmployee(req.employee) });
});

app.patch('/api/employees/:id', requireAdmin, (req, res) => {
  const emp = db.data.employees.find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const { name, email, phone, defaultPositionId, hourlyWage, positionWages, groupIds, archived } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Name can't be blank." });
    emp.name = name.trim();
  }
  if (email !== undefined) emp.email = email.trim();
  if (phone !== undefined) emp.phone = phone.trim();
  if (defaultPositionId !== undefined) emp.defaultPositionId = defaultPositionId || null;
  if (hourlyWage !== undefined) {
    const n = Number(hourlyWage);
    emp.hourlyWage = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  // Per-position pay rate overrides — e.g. a runner who also fills in as
  // manager may earn a different rate in that role. Missing/blank entries
  // fall back to the employee's base hourlyWage at cost-calculation time.
  if (positionWages !== undefined && typeof positionWages === 'object' && positionWages !== null) {
    const cleaned = {};
    Object.keys(positionWages).forEach(posId => {
      const n = Number(positionWages[posId]);
      if (Number.isFinite(n) && n >= 0) cleaned[posId] = n;
    });
    emp.positionWages = cleaned;
  }
  if (groupIds !== undefined) {
    const validIds = new Set(db.data.groups.map(g => g.id));
    emp.groupIds = Array.isArray(groupIds) ? groupIds.filter(id => validIds.has(id)) : [];
  }
  // Archived staff (e.g. seasonal Keeneland-only crew) stay fully on file —
  // wages, availability, history — but drop out of active scheduling until
  // someone brings them back.
  if (archived !== undefined) emp.archived = !!archived;
  db.persist();
  res.json({ employee: adminEmployee(emp) });
});

app.get('/api/wages', requireScheduler, (req, res) => {
  const wages = {};
  db.data.employees.forEach(e => {
    wages[e.id] = { hourlyWage: e.hourlyWage || 0, positionWages: e.positionWages || {} };
  });
  res.json({ wages });
});

app.delete('/api/employees/:id', requireAdmin, (req, res) => {
  const idx = db.data.employees.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Employee not found.' });
  db.data.employees.splice(idx, 1);
  delete db.data.availability[req.params.id];
  delete db.data.weeklyAvailability[req.params.id];
  db.data.shifts.forEach(s => {
    if (s.employeeIds) s.employeeIds = s.employeeIds.filter(id => id !== req.params.id);
  });
  db.persist();
  res.json({ ok: true });
});

app.post('/api/employees/import', requireAdmin, (req, res) => {
  const existing = new Set(db.data.employees.map(e => e.name.trim().toLowerCase()));
  let added = 0;
  DEFAULT_ROSTER.forEach(name => {
    if (!existing.has(name.toLowerCase())) {
      db.data.employees.push({ id: uid('e'), name, onboarded: false });
      existing.add(name.toLowerCase());
      added++;
    }
  });
  if (added > 0) db.persist();
  res.json({ added, skipped: DEFAULT_ROSTER.length - added });
});

// ---------- positions ----------
app.get('/api/positions', requireAnyAuth, (req, res) => {
  res.json({ positions: db.data.positions });
});

app.post('/api/positions', requireAdmin, (req, res) => {
  let { name, color } = req.body || {};
  name = (name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a position name.' });
  if (!POSITION_COLORS.includes(color)) color = POSITION_COLORS[0];
  const position = { id: uid('pos'), name, color };
  db.data.positions.push(position);
  db.persist();
  res.json({ position });
});

app.patch('/api/positions/:id', requireAdmin, (req, res) => {
  const position = db.data.positions.find(p => p.id === req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found.' });
  const { name, color } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Name can't be blank." });
    position.name = name.trim();
  }
  if (color !== undefined && POSITION_COLORS.includes(color)) position.color = color;
  db.persist();
  res.json({ position });
});

app.delete('/api/positions/:id', requireAdmin, (req, res) => {
  db.data.positions = db.data.positions.filter(p => p.id !== req.params.id);
  db.data.shifts.forEach(s => { if (s.positionId === req.params.id) delete s.positionId; });
  db.data.employees.forEach(e => {
    if (e.defaultPositionId === req.params.id) delete e.defaultPositionId;
    if (e.positionWages) delete e.positionWages[req.params.id];
  });
  db.data.payRates = db.data.payRates.filter(r => r.positionId !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

// ---------- pay rates (standard rate for a location+position combo, e.g.
// "any Driver at Tony's earns $2.50/hr" — separate from an individual
// employee's own wage, which is only used as a fallback where no rate card
// entry covers that shift's location+position). positionId of null means
// the rate applies regardless of position (e.g. a flat rate for private
// events). payType 'salary' stores an ANNUAL amount, tracked as its own
// line in labor cost rather than multiplied by shift hours.
app.get('/api/pay-rates', requireScheduler, (req, res) => {
  res.json({ payRates: db.data.payRates });
});

app.post('/api/pay-rates', requireAdmin, (req, res) => {
  let { lot, positionId, payType, rate } = req.body || {};
  lot = (lot || '').trim();
  if (!lot) return res.status(400).json({ error: 'Enter a location.' });
  if (payType !== 'hourly' && payType !== 'salary') return res.status(400).json({ error: 'Invalid pay type.' });
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Enter a valid rate.' });
  if (positionId) {
    const pos = db.data.positions.find(p => p.id === positionId);
    if (!pos) return res.status(400).json({ error: 'Position not found.' });
  }
  const entry = { id: uid('rate'), lot, positionId: positionId || null, payType, rate: n };
  db.data.payRates.push(entry);
  db.persist();
  res.json({ payRate: entry });
});

app.delete('/api/pay-rates/:id', requireAdmin, (req, res) => {
  db.data.payRates = db.data.payRates.filter(r => r.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

// ---------- groups (labels for filtering/organizing staff, e.g. "Weekend Crew") ----------
app.get('/api/groups', requireAnyAuth, (req, res) => {
  res.json({ groups: db.data.groups });
});

app.post('/api/groups', requireAdmin, (req, res) => {
  let { name } = req.body || {};
  name = (name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a group name.' });
  const group = { id: uid('grp'), name };
  db.data.groups.push(group);
  db.persist();
  res.json({ group });
});

app.patch('/api/groups/:id', requireAdmin, (req, res) => {
  const group = db.data.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const { name } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Name can't be blank." });
    group.name = name.trim();
  }
  db.persist();
  res.json({ group });
});

app.delete('/api/groups/:id', requireAdmin, (req, res) => {
  db.data.groups = db.data.groups.filter(g => g.id !== req.params.id);
  db.data.employees.forEach(e => {
    if (e.groupIds) e.groupIds = e.groupIds.filter(id => id !== req.params.id);
  });
  db.persist();
  res.json({ ok: true });
});

// ---------- shift templates (saved time presets) ----------
app.get('/api/shift-templates', requireScheduler, (req, res) => {
  res.json({ templates: db.data.shiftTemplates });
});

app.post('/api/shift-templates', requireScheduler, (req, res) => {
  let { label, start, end } = req.body || {};
  label = (label || '').trim();
  if (!label) return res.status(400).json({ error: 'Enter a name for the template.' });
  if (!start || !end) return res.status(400).json({ error: 'Pick a start and end time.' });
  const template = { id: uid('tmpl'), label, start, end };
  db.data.shiftTemplates.push(template);
  db.persist();
  res.json({ template });
});

app.delete('/api/shift-templates/:id', requireScheduler, (req, res) => {
  db.data.shiftTemplates = db.data.shiftTemplates.filter(t => t.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

// ---------- availability ----------
app.get('/api/availability', requireAnyAuth, (req, res) => {
  res.json({ availability: db.data.availability });
});

app.put('/api/availability/:date', requireLogin, (req, res) => {
  const date = req.params.date;
  const state = (req.body && req.body.state) || null;
  if (state !== null && state !== 'available' && state !== 'unavailable') {
    return res.status(400).json({ error: 'Invalid availability state.' });
  }
  if (!db.data.availability[req.employee.id]) db.data.availability[req.employee.id] = {};
  if (state === null) delete db.data.availability[req.employee.id][date];
  else db.data.availability[req.employee.id][date] = state;
  db.persist();
  res.json({ availability: db.data.availability[req.employee.id] || {} });
});

// Staff set ONE recurring weekly pattern instead of re-entering it every
// week (nobody actually did that) — keyed by JS getDay() (0=Sun..6=Sat) to
// match the convention DAILY_TEMPLATES already uses. A specific date can
// still be overridden in `availability` above; that's how an approved
// time-off request cuts in over the usual pattern for just those days.
app.get('/api/weekly-availability', requireAnyAuth, (req, res) => {
  res.json({ weeklyAvailability: db.data.weeklyAvailability, locked: isAvailabilityLocked() });
});

app.put('/api/weekly-availability/:day', requireLogin, (req, res) => {
  const day = Number(req.params.day);
  const state = (req.body && req.body.state) || null;
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return res.status(400).json({ error: 'Invalid day of week.' });
  }
  if (state !== null && state !== 'available' && state !== 'unavailable') {
    return res.status(400).json({ error: 'Invalid availability state.' });
  }
  // Someone still finishing signup needs to be able to set their pattern
  // regardless of the day/time — the lock only applies once they're in.
  if (req.employee.onboarded && isAvailabilityLocked()) {
    return res.status(403).json({ error: 'Weekly availability is locked until Monday. Need an exception this week? Submit a time-off request instead.' });
  }
  const previousState = (db.data.weeklyAvailability[req.employee.id] || {})[day] || null;
  if (!db.data.weeklyAvailability[req.employee.id]) db.data.weeklyAvailability[req.employee.id] = {};
  if (state === null) delete db.data.weeklyAvailability[req.employee.id][day];
  else db.data.weeklyAvailability[req.employee.id][day] = state;

  db.data.availabilityChangeLog.push({
    id: uid('avlog'), employeeId: req.employee.id, day, previousState, newState: state,
    changedAt: new Date().toISOString()
  });
  if (db.data.availabilityChangeLog.length > 2000) {
    db.data.availabilityChangeLog.splice(0, db.data.availabilityChangeLog.length - 2000);
  }

  db.persist();
  res.json({ weeklyAvailability: db.data.weeklyAvailability[req.employee.id] || {} });
});

app.get('/api/availability-log', requireScheduler, (req, res) => {
  res.json({ log: db.data.availabilityChangeLog.slice(-100).reverse() });
});

// ---------- shifts ----------
function findShift(id) { return db.data.shifts.find(s => s.id === id); }

app.get('/api/shifts', requireAnyAuth, (req, res) => {
  res.json({ shifts: db.data.shifts });
});

app.post('/api/shifts', requireScheduler, (req, res) => {
  const { date, lot, customName, start, end, employeeId, open, positionId, copyToWeekdays, repeatWeeks } = req.body || {};
  if (!date || !lot) return res.status(400).json({ error: 'Missing date or location.' });
  const makeShift = (d) => ({
    id: uid('s'), date: d, lot,
    customName: customName || null,
    start: start || '09:00', end: end || '17:00',
    employeeIds: employeeId ? [employeeId] : [],
    open: !employeeId && !!open,
    positionId: positionId || null,
    draft: false
  });
  const shift = makeShift(date);
  db.data.shifts.push(shift);
  const extraDates = expandCopyDates(date, copyToWeekdays, repeatWeeks);
  extraDates.forEach(d => db.data.shifts.push(makeShift(d)));
  db.persist();
  res.json({ shift, copies: extraDates.length });
});

app.post('/api/shifts/slot-assign', requireScheduler, (req, res) => {
  const { date, lot, slotId, start, end, employeeId, positionId, copyToWeekdays, repeatWeeks } = req.body || {};
  if (!date || !lot || !slotId) return res.status(400).json({ error: 'Missing fields.' });
  const upsertFor = (d) => {
    let s = db.data.shifts.find(x => x.date === d && x.lot === lot && x.slotId === slotId);
    if (s) {
      s.employeeIds = [employeeId];
      if (positionId !== undefined) s.positionId = positionId || null;
      s.draft = true;
    } else {
      s = { id: uid('s'), date: d, lot, slotId, start, end, employeeIds: [employeeId], positionId: positionId || null, draft: true };
      db.data.shifts.push(s);
    }
    return s;
  };
  const shift = upsertFor(date);
  const slotDef = (DAILY_TEMPLATES[lot] || []).find(sl => sl.id === slotId);
  let extraDates = expandCopyDates(date, copyToWeekdays, repeatWeeks);
  if (slotDef) extraDates = extraDates.filter(d => slotApplies(slotDef, new Date(d + 'T00:00:00')));
  extraDates.forEach(d => upsertFor(d));
  db.persist();
  res.json({ shift, copies: extraDates.length });
});

app.delete('/api/shifts/slot', requireScheduler, (req, res) => {
  const { date, lot, slotId } = req.query;
  db.data.shifts = db.data.shifts.filter(s => !(s.date === date && s.lot === lot && s.slotId === slotId));
  db.persist();
  res.json({ ok: true });
});

app.patch('/api/shifts/:id', requireScheduler, (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  const { start, end, customName, open, positionId } = req.body || {};
  if (start !== undefined) shift.start = start;
  if (end !== undefined) shift.end = end;
  if (customName !== undefined) shift.customName = customName || null;
  if (open !== undefined) shift.open = !!open;
  if (positionId !== undefined) shift.positionId = positionId || null;
  shift.draft = true;
  db.persist();
  res.json({ shift });
});

app.delete('/api/shifts/:id', requireScheduler, (req, res) => {
  db.data.shifts = db.data.shifts.filter(s => s.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

app.post('/api/shifts/:id/assignees', requireScheduler, (req, res) => {
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

app.post('/api/shifts/:id/claim', requireLogin, (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  if (!shift.open) return res.status(400).json({ error: 'This shift is not open for pickup.' });
  if ((shift.employeeIds || []).length) return res.status(400).json({ error: 'Someone already claimed this shift.' });
  const state = (db.data.availability[req.employee.id] || {})[shift.date];
  if (state === 'unavailable') return res.status(400).json({ error: "You've marked yourself unavailable that day." });
  shift.employeeIds = [req.employee.id];
  shift.open = false;
  db.persist();
  res.json({ shift });
});

app.delete('/api/shifts/:id/assignees/:employeeId', requireScheduler, (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  shift.employeeIds = (shift.employeeIds || []).filter(eid => eid !== req.params.employeeId);
  shift.draft = true;
  db.persist();
  res.json({ shift });
});

app.post('/api/shifts/publish', requireScheduler, (req, res) => {
  const weekStart = req.body && req.body.weekStart;
  if (!weekStart) return res.status(400).json({ error: 'Missing weekStart.' });
  const isoSet = new Set(weekDatesFrom(weekStart).map(toISO));
  const affectedIds = new Set();
  db.data.shifts.forEach(s => {
    if (!isoSet.has(s.date)) return;
    s.draft = false;
    (s.employeeIds || []).forEach(id => affectedIds.add(id));
  });
  db.persist();
  res.json({ ok: true });

  const weekLabel = weekStart;
  affectedIds.forEach(id => {
    const emp = db.data.employees.find(e => e.id === id);
    if (emp) sendEmail(emp.email, 'Your schedule has been published', `Hi ${emp.name},\n\nThis week's schedule (starting ${weekLabel}) has been published. Check the shift board to see your shifts.\n\n— Xpress Parking Services`);
  });
});

// ---------- shift swaps ----------
app.get('/api/swaps', requireAnyAuth, (req, res) => {
  res.json({ swaps: db.data.swapRequests });
});

app.post('/api/swaps', requireLogin, (req, res) => {
  const { shiftId, toEmployeeId } = req.body || {};
  const shift = findShift(shiftId);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  if (!(shift.employeeIds || []).includes(req.employee.id)) {
    return res.status(400).json({ error: "You're not assigned to that shift." });
  }
  if (!toEmployeeId || toEmployeeId === req.employee.id) {
    return res.status(400).json({ error: 'Pick a coworker to offer the shift to.' });
  }
  const coworker = db.data.employees.find(e => e.id === toEmployeeId);
  if (!coworker) return res.status(404).json({ error: 'That employee no longer exists.' });
  const already = db.data.swapRequests.find(r => r.shiftId === shiftId && r.fromEmployeeId === req.employee.id);
  if (already) return res.status(400).json({ error: 'You already have a pending swap for this shift.' });

  const request = {
    id: uid('sw'),
    shiftId,
    fromEmployeeId: req.employee.id,
    toEmployeeId,
    createdAt: new Date().toISOString()
  };
  db.data.swapRequests.push(request);
  db.persist();
  res.json({ request });

  sendEmail(coworker.email, 'Shift swap request', `Hi ${coworker.name},\n\n${req.employee.name} wants you to take their shift:\n${describeShiftForEmail(shift)}\n\nLog in to the shift board to accept or decline.\n\n— Xpress Parking Services`);
});

app.post('/api/swaps/:id/accept', requireLogin, (req, res) => {
  const request = db.data.swapRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Swap request not found.' });
  if (request.toEmployeeId !== req.employee.id) return res.status(403).json({ error: 'This swap is not addressed to you.' });
  const shift = findShift(request.shiftId);
  if (shift) {
    const ids = (shift.employeeIds || []).filter(id => id !== request.fromEmployeeId);
    if (!ids.includes(request.toEmployeeId)) ids.push(request.toEmployeeId);
    shift.employeeIds = ids;
    shift.draft = true;
  }
  db.data.swapRequests = db.data.swapRequests.filter(r => r.id !== req.params.id);
  db.persist();
  res.json({ shift: shift || null });

  const fromEmp = db.data.employees.find(e => e.id === request.fromEmployeeId);
  if (fromEmp && shift) sendEmail(fromEmp.email, 'Shift swap accepted', `Hi ${fromEmp.name},\n\n${req.employee.name} accepted your shift swap:\n${describeShiftForEmail(shift)}\n\n— Xpress Parking Services`);
});

app.post('/api/swaps/:id/decline', requireLogin, (req, res) => {
  const request = db.data.swapRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Swap request not found.' });
  if (request.toEmployeeId !== req.employee.id) return res.status(403).json({ error: 'This swap is not addressed to you.' });
  const shift = findShift(request.shiftId);
  db.data.swapRequests = db.data.swapRequests.filter(r => r.id !== req.params.id);
  db.persist();
  res.json({ ok: true });

  const fromEmp = db.data.employees.find(e => e.id === request.fromEmployeeId);
  if (fromEmp && shift) sendEmail(fromEmp.email, 'Shift swap declined', `Hi ${fromEmp.name},\n\n${req.employee.name} declined your shift swap offer:\n${describeShiftForEmail(shift)}\n\nYou're still on the hook for this shift — check the schedule.\n\n— Xpress Parking Services`);
});

app.delete('/api/swaps/:id', requireLogin, (req, res) => {
  const request = db.data.swapRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Swap request not found.' });
  if (request.fromEmployeeId !== req.employee.id) return res.status(403).json({ error: 'This is not your swap request.' });
  db.data.swapRequests = db.data.swapRequests.filter(r => r.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

// ---------- time off (PTO) ----------
app.get('/api/pto', requireAnyAuth, (req, res) => {
  const all = db.data.ptoRequests;
  const visible = req.admin ? all : all.filter(r => r.employeeId === req.employee.id);
  res.json({ requests: visible });
});

app.post('/api/pto', requireLogin, (req, res) => {
  const { startDate, endDate, reason } = req.body || {};
  if (!startDate || !endDate) return res.status(400).json({ error: 'Pick a start and end date.' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date is before the start date.' });
  const request = {
    id: uid('pto'),
    employeeId: req.employee.id,
    startDate, endDate,
    reason: (reason || '').trim() || null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.data.ptoRequests.push(request);
  db.persist();
  res.json({ request });
});

app.delete('/api/pto/:id', requireLogin, (req, res) => {
  const request = db.data.ptoRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.employeeId !== req.employee.id) return res.status(403).json({ error: 'This is not your request.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Only a pending request can be cancelled.' });
  db.data.ptoRequests = db.data.ptoRequests.filter(r => r.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

app.post('/api/pto/:id/approve', requireAdmin, (req, res) => {
  const request = db.data.ptoRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  request.status = 'approved';
  const dates = [];
  let d = new Date(request.startDate + 'T00:00:00');
  const end = new Date(request.endDate + 'T00:00:00');
  while (d <= end) { dates.push(toISO(d)); d.setDate(d.getDate() + 1); }
  if (!db.data.availability[request.employeeId]) db.data.availability[request.employeeId] = {};
  dates.forEach(iso => { db.data.availability[request.employeeId][iso] = 'unavailable'; });
  db.persist();
  res.json({ request });

  const emp = db.data.employees.find(e => e.id === request.employeeId);
  if (emp) sendEmail(emp.email, 'Time off approved', `Hi ${emp.name},\n\nYour time-off request for ${request.startDate} to ${request.endDate} has been approved.\n\n— Xpress Parking Services`);
});

app.post('/api/pto/:id/deny', requireAdmin, (req, res) => {
  const request = db.data.ptoRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  request.status = 'denied';
  db.persist();
  res.json({ request });

  const emp = db.data.employees.find(e => e.id === request.employeeId);
  if (emp) sendEmail(emp.email, 'Time off request denied', `Hi ${emp.name},\n\nYour time-off request for ${request.startDate} to ${request.endDate} was denied. Check the shift board or talk to your manager for details.\n\n— Xpress Parking Services`);
});

// ---------- time clock / timesheets ----------
app.get('/api/timeclock/status', requireLogin, (req, res) => {
  const open = db.data.timeEntries.find(t => t.employeeId === req.employee.id && !t.clockOut);
  res.json({ entry: open || null });
});

app.post('/api/timeclock/in', requireLogin, (req, res) => {
  const already = db.data.timeEntries.find(t => t.employeeId === req.employee.id && !t.clockOut);
  if (already) return res.status(400).json({ error: "You're already clocked in." });
  const now = new Date();
  const entry = { id: uid('te'), employeeId: req.employee.id, date: toISO(now), clockIn: now.toISOString(), clockOut: null };
  db.data.timeEntries.push(entry);
  db.persist();
  res.json({ entry });
});

app.post('/api/timeclock/out', requireLogin, (req, res) => {
  const entry = db.data.timeEntries.find(t => t.employeeId === req.employee.id && !t.clockOut);
  if (!entry) return res.status(400).json({ error: "You're not clocked in." });
  entry.clockOut = new Date().toISOString();
  db.persist();
  res.json({ entry });
});

app.get('/api/timesheets', requireScheduler, (req, res) => {
  const weekStart = req.query.weekStart;
  let entries = db.data.timeEntries;
  if (weekStart) {
    const isoSet = new Set(weekDatesFrom(weekStart).map(toISO));
    entries = entries.filter(t => isoSet.has(t.date));
  }
  res.json({ entries });
});

// Manual entries store a naive "local wall-clock" datetime string (no Z, no
// offset) instead of converting through Date/toISOString — that conversion
// would silently apply *this server's* OS timezone (e.g. Render's UTC),
// which has nothing to do with the business's actual timezone. Real
// clock-in/out button presses are fine as true UTC instants (see above);
// only typed-in times need this naive-string treatment.
app.post('/api/timesheets', requireAdmin, (req, res) => {
  const { employeeId, date, clockIn, clockOut } = req.body || {};
  if (!employeeId || !date || !clockIn) return res.status(400).json({ error: 'Missing fields.' });
  const entry = { id: uid('te'), employeeId, date, clockIn: `${date}T${clockIn}:00`, clockOut: clockOut ? `${date}T${clockOut}:00` : null };
  db.data.timeEntries.push(entry);
  db.persist();
  res.json({ entry });
});

app.patch('/api/timesheets/:id', requireAdmin, (req, res) => {
  const entry = db.data.timeEntries.find(t => t.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  const { clockIn, clockOut } = req.body || {};
  if (clockIn !== undefined) entry.clockIn = `${entry.date}T${clockIn}:00`;
  if (clockOut !== undefined) entry.clockOut = clockOut ? `${entry.date}T${clockOut}:00` : null;
  db.persist();
  res.json({ entry });
});

app.delete('/api/timesheets/:id', requireAdmin, (req, res) => {
  db.data.timeEntries = db.data.timeEntries.filter(t => t.id !== req.params.id);
  db.persist();
  res.json({ ok: true });
});

// ---------- static ----------
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Xpress Shift Board running at http://localhost:${PORT}`);
});
