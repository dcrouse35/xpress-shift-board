const { LOTS, EMP_HOME_TAGS, STATE_ORDER, STATE_LABEL, DAILY_TEMPLATES, slotApplies, POSITION_COLORS } = window.APP_CONSTANTS;

let employees = [];
let availability = {}; // { employeeId: { 'YYYY-MM-DD': state } }
let shifts = []; // [ {id, date, employeeIds, lot, slotId?, customName?, start, end, draft, open?, positionId?} ]
let swapRequests = []; // [ {id, shiftId, fromEmployeeId, toEmployeeId, createdAt} ]
let ptoRequests = []; // [ {id, employeeId, startDate, endDate, reason, status, createdAt} ]
let positions = []; // [ {id, name, color} ]

let me = null;    // logged-in staff identity (sanitized), or null
let admin = null; // logged-in admin identity (sanitized), or null
let authView = 'staff'; // which gate form shows when nobody is logged in: 'staff' | 'admin'
let staffTab = 'my';     // 'my' | 'schedule' | 'timeoff'
let adminTab = 'schedule'; // 'schedule' | 'staff' | 'timeoff'

let managerLot = '__ALL__';
let scheduleEditor = null; // { type:'slot', date, lot, slotId, start, end } | { type:'shift', shiftId } | { type:'newcustom', employeeId, date }
let addShiftError = null;
let signupError = null;
let loginError = null;
let adminSignupError = null;
let adminLoginError = null;
let importResultMsg = null;
let positionError = null;
let weekOffset = 0; // 0 = this week
let openDayKey = null; // for admin breakdown panel
let loaded = false;
let loadError = null;
let swapError = null;
let ptoError = null;

function icon(name){
  if(name==="available") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3zm0 0 4.5-8a2 2 0 0 1 3.8.9L14.5 9H19a2 2 0 0 1 2 2.3l-1.4 8A3 3 0 0 1 16.6 22H10a3 3 0 0 1-3-3"/></svg>';
  if(name==="unavailable") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V3h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3zm0 0-4.5 8a2 2 0 0 1-3.8-.9L9.5 15H5a2 2 0 0 1-2-2.3l1.4-8A3 3 0 0 1 7.4 2H14a3 3 0 0 1 3 3"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>';
}

function pad(n){return n<10 ? "0"+n : ""+n;}
function toISO(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());}
function mondayOf(date){
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day===0? -6 : 1-day);
  d.setDate(d.getDate()+diff);
  d.setHours(0,0,0,0);
  return d;
}
function getWeekDates(offset){
  const base = mondayOf(new Date());
  base.setDate(base.getDate() + offset*7);
  const out = [];
  for(let i=0;i<7;i++){
    const d = new Date(base);
    d.setDate(base.getDate()+i);
    out.push(d);
  }
  return out;
}
function fmtWeekLabel(dates){
  const opt = {month:"short", day:"numeric"};
  return dates[0].toLocaleDateString("en-US",opt) + " – " + dates[6].toLocaleDateString("en-US",opt);
}
function fmtDayName(d){ return d.toLocaleDateString("en-US",{weekday:"long"}); }
function fmtDayShort(d){ return d.toLocaleDateString("en-US",{month:"short", day:"numeric"}); }
function fmt12(t){
  if(!t) return '';
  const [h,m] = t.split(':').map(Number);
  const ap = h>=12 ? 'PM':'AM';
  let hh = h%12; if(hh===0) hh=12;
  return hh+':'+pad(m)+' '+ap;
}

// ---------- backend calls ----------
async function api(path, opts){
  const res = await fetch(path, Object.assign({ headers: {'Content-Type':'application/json'} }, opts));
  let body = null;
  try{ body = await res.json(); }catch(e){}
  if(!res.ok) throw new Error((body && body.error) || 'Something went wrong — try again.');
  return body;
}

async function loadAll(){
  try{
    const meRes = await api('/api/me');
    me = meRes.employee;
    admin = meRes.admin;
    if(me || admin){
      await loadProtectedData();
    }
  }catch(e){
    loadError = "Couldn't load the shift board — check your connection and reload.";
  }
  loaded = true;
  render();
}

async function loadProtectedData(){
  const [empRes, availRes, shiftRes, swapRes, ptoRes, posRes] = await Promise.all([
    api('/api/employees'), api('/api/availability'), api('/api/shifts'), api('/api/swaps'), api('/api/pto'), api('/api/positions')
  ]);
  employees = empRes.employees;
  availability = availRes.availability;
  shifts = shiftRes.shifts;
  swapRequests = swapRes.swaps;
  ptoRequests = ptoRes.requests;
  positions = posRes.positions;
}

async function refreshShifts(){
  const sres = await api('/api/shifts');
  shifts = sres.shifts;
}

async function setDayState(empId, dateISO, newState){
  try{
    await api('/api/availability/' + encodeURIComponent(dateISO), { method:'PUT', body: JSON.stringify({state:newState}) });
    if(!availability[empId]) availability[empId] = {};
    if(newState===null) delete availability[empId][dateISO];
    else availability[empId][dateISO] = newState;
  }catch(e){ loadError = e.message; }
  render();
}

function cycleState(current){
  const idx = STATE_ORDER.indexOf(current || null);
  return STATE_ORDER[(idx+1) % STATE_ORDER.length];
}

// ---------- staff auth ----------
async function addEmployee(name, email, phone, password, passwordConfirm){
  name = (name||'').trim();
  email = (email||'').trim();
  phone = (phone||'').trim();
  if(!name){ signupError = "Enter your name."; render(); return; }
  if(!email || !email.includes('@') || !email.includes('.')){ signupError = "Enter a valid email address."; render(); return; }
  if(!phone){ signupError = "Enter a phone number."; render(); return; }
  if(!password || password.length < 6){ signupError = "Password must be at least 6 characters."; render(); return; }
  if(password !== passwordConfirm){ signupError = "Those passwords don't match."; render(); return; }

  try{
    const res = await api('/api/auth/signup', { method:'POST', body: JSON.stringify({name,email,phone,password,passwordConfirm}) });
    me = res.employee;
    admin = null;
    signupError = null;
    await loadProtectedData();
  }catch(e){ signupError = e.message; }
  render();
}

async function loginEmployee(email, password){
  try{
    const res = await api('/api/auth/login', { method:'POST', body: JSON.stringify({email,password}) });
    me = res.employee;
    admin = null;
    loginError = null;
    await loadProtectedData();
  }catch(e){ loginError = e.message; }
  render();
}

async function logoutEmployee(){
  try{ await api('/api/auth/logout', { method:'POST' }); }catch(e){}
  me = null; admin = null; loginError = null; adminLoginError = null;
  employees = []; availability = {}; shifts = []; swapRequests = []; ptoRequests = []; positions = [];
  render();
}

// ---------- admin auth ----------
async function adminSignup(name, email, password, passwordConfirm, inviteCode){
  try{
    const res = await api('/api/admin/signup', { method:'POST', body: JSON.stringify({name,email,password,passwordConfirm,inviteCode}) });
    admin = res.admin;
    me = null;
    adminSignupError = null;
    await loadProtectedData();
  }catch(e){ adminSignupError = e.message; }
  render();
}

async function adminLogin(email, password){
  try{
    const res = await api('/api/admin/login', { method:'POST', body: JSON.stringify({email,password}) });
    admin = res.admin;
    me = null;
    adminLoginError = null;
    await loadProtectedData();
  }catch(e){ adminLoginError = e.message; }
  render();
}

async function importRoster(){
  try{
    const res = await api('/api/employees/import', { method:'POST' });
    importResultMsg = res.added + ' name' + (res.added===1?'':'s') + ' added' + (res.skipped>0 ? ', ' + res.skipped + ' already on the list and skipped.' : '.');
    if(res.added>0){
      const empRes = await api('/api/employees');
      employees = empRes.employees;
    }
  }catch(e){ loadError = e.message; }
  render();
}

async function updateMyInfo(){
  const name = (document.getElementById('myName')||{}).value || '';
  if(!name.trim()){ signupError = "Name can't be blank."; render(); return; }
  const email = ((document.getElementById('myEmail')||{}).value || '').trim();
  const phone = ((document.getElementById('myPhone')||{}).value || '').trim();
  const lot = (document.getElementById('myLot')||{}).value;
  try{
    const res = await api('/api/employees/me', { method:'PUT', body: JSON.stringify({name,email,phone,lot}) });
    me = res.employee;
    const idx = employees.findIndex(e=>e.id===me.id);
    if(idx>=0) employees[idx] = me;
    signupError = null;
  }catch(e){ signupError = e.message; }
  render();
}

async function updateStaffField(empId, field, value){
  try{
    const res = await api(`/api/employees/${empId}`, { method:'PATCH', body: JSON.stringify({ [field]: value }) });
    const idx = employees.findIndex(e=>e.id===empId);
    if(idx>=0) employees[idx] = res.employee;
  }catch(e){ loadError = e.message; }
  render();
}

async function removeStaffMember(empId){
  try{
    await api(`/api/employees/${empId}`, { method:'DELETE' });
    employees = employees.filter(e=>e.id!==empId);
    delete availability[empId];
    shifts.forEach(s=>{ s.employeeIds = (s.employeeIds||[]).filter(id=>id!==empId); });
  }catch(e){ loadError = e.message; }
  render();
}

// ---------- positions ----------
async function addPosition(){
  const nameInput = document.getElementById('newPositionName');
  const colorInput = document.querySelector('input[name="newPositionColor"]:checked');
  const name = nameInput ? nameInput.value.trim() : '';
  if(!name){ positionError = "Enter a position name."; render(); return; }
  const color = colorInput ? colorInput.value : POSITION_COLORS[0];
  try{
    const res = await api('/api/positions', { method:'POST', body: JSON.stringify({ name, color }) });
    positions.push(res.position);
    positionError = null;
  }catch(e){ positionError = e.message; }
  render();
}
async function removePosition(id){
  if(!confirm('Remove this position? Shifts already tagged with it keep their color until edited.')) return;
  try{
    await api(`/api/positions/${id}`, { method:'DELETE' });
    positions = positions.filter(p=>p.id!==id);
    shifts.forEach(s=>{ if(s.positionId===id) s.positionId = null; });
    employees.forEach(e=>{ if(e.defaultPositionId===id) e.defaultPositionId = null; });
  }catch(e){ positionError = e.message; }
  render();
}
function positionOptionsHtml(selectedId){
  let html = `<option value="">No position</option>`;
  positions.forEach(p=> html += `<option value="${p.id}" ${p.id===selectedId?'selected':''}>${p.name}</option>`);
  return html;
}
function colorForShift(s){
  if(s && s.positionId){
    const pos = positions.find(p=>p.id===s.positionId);
    if(pos) return pos.color;
  }
  return null;
}

// ---------- shift swaps ----------
async function requestSwap(shiftId, toEmployeeId){
  try{
    const res = await api('/api/swaps', { method:'POST', body: JSON.stringify({ shiftId, toEmployeeId }) });
    swapRequests.push(res.request);
    swapError = null;
  }catch(e){ swapError = e.message; }
  render();
}
async function acceptSwap(requestId){
  try{
    const res = await api(`/api/swaps/${requestId}/accept`, { method:'POST' });
    if(res.shift){
      const idx = shifts.findIndex(s=>s.id===res.shift.id);
      if(idx>=0) shifts[idx] = res.shift;
    }
    swapRequests = swapRequests.filter(r=>r.id!==requestId);
  }catch(e){ swapError = e.message; }
  render();
}
async function declineSwap(requestId){
  try{
    await api(`/api/swaps/${requestId}/decline`, { method:'POST' });
    swapRequests = swapRequests.filter(r=>r.id!==requestId);
  }catch(e){ swapError = e.message; }
  render();
}
async function cancelSwap(requestId){
  try{
    await api(`/api/swaps/${requestId}`, { method:'DELETE' });
    swapRequests = swapRequests.filter(r=>r.id!==requestId);
  }catch(e){ swapError = e.message; }
  render();
}
function describeShift(shift){
  const d = new Date(shift.date+'T00:00:00');
  let label;
  if(shift.slotId){
    const template = (DAILY_TEMPLATES[shift.lot]||[]).find(sl=>sl.id===shift.slotId);
    label = shift.lot + (template ? ' — '+template.label : '');
  } else {
    label = shift.lot + (shift.customName ? ' — '+shift.customName : ' — Extra shift');
  }
  return `${label} · ${fmtDayName(d)}, ${fmtDayShort(d)} · ${fmt12(shift.start)}–${fmt12(shift.end)}`;
}

// ---------- open shift board ----------
async function claimShift(shiftId){
  try{
    const res = await api(`/api/shifts/${shiftId}/claim`, { method:'POST' });
    const idx = shifts.findIndex(s=>s.id===res.shift.id);
    if(idx>=0) shifts[idx] = res.shift;
    swapError = null;
  }catch(e){ swapError = e.message; }
  render();
}

// ---------- time off (PTO) ----------
async function submitPto(){
  const startDate = (document.getElementById('ptoStart')||{}).value;
  const endDate = (document.getElementById('ptoEnd')||{}).value;
  const reason = ((document.getElementById('ptoReason')||{}).value || '').trim();
  if(!startDate || !endDate){ ptoError = "Pick a start and end date."; render(); return; }
  try{
    const res = await api('/api/pto', { method:'POST', body: JSON.stringify({ startDate, endDate, reason }) });
    ptoRequests.push(res.request);
    ptoError = null;
  }catch(e){ ptoError = e.message; }
  render();
}
async function cancelPto(id){
  try{
    await api(`/api/pto/${id}`, { method:'DELETE' });
    ptoRequests = ptoRequests.filter(r=>r.id!==id);
  }catch(e){ ptoError = e.message; }
  render();
}
async function approvePto(id){
  try{
    const res = await api(`/api/pto/${id}/approve`, { method:'POST' });
    const idx = ptoRequests.findIndex(r=>r.id===id);
    if(idx>=0) ptoRequests[idx] = res.request;
    const availRes = await api('/api/availability');
    availability = availRes.availability;
  }catch(e){ ptoError = e.message; }
  render();
}
async function denyPto(id){
  try{
    const res = await api(`/api/pto/${id}/deny`, { method:'POST' });
    const idx = ptoRequests.findIndex(r=>r.id===id);
    if(idx>=0) ptoRequests[idx] = res.request;
  }catch(e){ ptoError = e.message; }
  render();
}
function fmtDateShort(iso){ return new Date(iso+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}); }

// ---------- shifts ----------
function getShiftEmployeeIds(s){ return s.employeeIds || []; }

function slotOptionsHtml(iso, assignedId){
  const sortedEmps = employees.slice().sort((a,b)=>a.name.localeCompare(b.name));
  let options = `<option value="">— Open —</option>`;
  sortedEmps.forEach(emp=>{
    const st = (availability[emp.id] && availability[emp.id][iso]) || null;
    if(st === 'unavailable' && emp.id !== assignedId) return;
    let label = emp.name;
    if(st === 'unavailable') label += ' (unavailable)';
    options += `<option value="${emp.id}" ${emp.id===assignedId?'selected':''}>${label}</option>`;
  });
  return options;
}

function addAssigneeOptionsHtml(iso, excludeIds){
  const sortedEmps = employees.slice().sort((a,b)=>a.name.localeCompare(b.name));
  let opts = '<option value="">+ Add staff…</option>';
  sortedEmps.forEach(emp=>{
    if(excludeIds.includes(emp.id)) return;
    const st = (availability[emp.id] && availability[emp.id][iso]) || null;
    if(st === 'unavailable') return;
    opts += `<option value="${emp.id}">${emp.name}</option>`;
  });
  return opts;
}

// copy-to-other-days / future-weeks controls, shared by the slot and new-shift editors
function renderCopyOptionsHtml(prefix){
  const days = [
    {n:0,label:'Sun'},{n:1,label:'Mon'},{n:2,label:'Tue'},{n:3,label:'Wed'},{n:4,label:'Thu'},{n:5,label:'Fri'},{n:6,label:'Sat'}
  ];
  return `<div style="margin-top:12px;">
    <label>Also copy to these days this week</label>
    <div class="row" style="flex-wrap:wrap;gap:10px;">
      ${days.map(d=>`<label style="display:inline-flex;align-items:center;gap:4px;font-weight:600;color:var(--ink-soft);margin:0;">
        <input type="checkbox" class="${prefix}-copyday" value="${d.n}" style="width:auto;" /> ${d.label}
      </label>`).join('')}
    </div>
    <div class="row" style="margin-top:8px;align-items:center;">
      <input type="checkbox" id="${prefix}-repeat4" style="width:auto;" />
      <label style="margin:0;" for="${prefix}-repeat4">Also repeat for the next 4 weeks</label>
    </div>
  </div>`;
}
function readCopyOptions(prefix){
  const days = Array.from(document.querySelectorAll('.'+prefix+'-copyday:checked')).map(el=>parseInt(el.value,10));
  const repeat4 = document.getElementById(prefix+'-repeat4');
  return { copyToWeekdays: days, repeatWeeks: (repeat4 && repeat4.checked) ? 4 : 0 };
}

async function assignSlot(dateISO, lot, slotId, start, end, employeeId, positionId, copy){
  try{
    const body = Object.assign({ date:dateISO, lot, slotId, start, end, employeeId, positionId }, copy||{});
    const res = await api('/api/shifts/slot-assign', { method:'POST', body: JSON.stringify(body) });
    const idx = shifts.findIndex(s=>s.date===dateISO && s.lot===lot && s.slotId===slotId);
    if(idx>=0) shifts[idx] = res.shift; else shifts.push(res.shift);
    if(res.copies) await refreshShifts();
  }catch(e){ loadError = e.message; }
  render();
}
async function clearSlot(dateISO, lot, slotId){
  try{
    await api(`/api/shifts/slot?date=${encodeURIComponent(dateISO)}&lot=${encodeURIComponent(lot)}&slotId=${encodeURIComponent(slotId)}`, { method:'DELETE' });
    shifts = shifts.filter(s=>!(s.date===dateISO && s.lot===lot && s.slotId===slotId));
  }catch(e){ loadError = e.message; }
  render();
}

async function addShiftAssignee(shiftId, employeeId){
  try{
    const res = await api(`/api/shifts/${shiftId}/assignees`, { method:'POST', body: JSON.stringify({ employeeId }) });
    const idx = shifts.findIndex(s=>s.id===shiftId);
    if(idx>=0) shifts[idx] = res.shift;
  }catch(e){ loadError = e.message; }
  render();
}
async function removeShiftAssignee(shiftId, employeeId){
  try{
    const res = await api(`/api/shifts/${shiftId}/assignees/${employeeId}`, { method:'DELETE' });
    const idx = shifts.findIndex(s=>s.id===shiftId);
    if(idx>=0) shifts[idx] = res.shift;
  }catch(e){ loadError = e.message; }
  render();
}

async function publishWeek(){
  const weekStart = toISO(getWeekDates(weekOffset)[0]);
  try{
    await api('/api/shifts/publish', { method:'POST', body: JSON.stringify({ weekStart }) });
    const isoSet = new Set(getWeekDates(weekOffset).map(toISO));
    shifts.forEach(s=>{ if(isoSet.has(s.date)) s.draft = false; });
  }catch(e){ loadError = e.message; }
  render();
}

async function updateShift(shiftId, field, value){
  try{
    const res = await api(`/api/shifts/${shiftId}`, { method:'PATCH', body: JSON.stringify({ [field]: value }) });
    const idx = shifts.findIndex(s=>s.id===shiftId);
    if(idx>=0) shifts[idx] = res.shift;
  }catch(e){ loadError = e.message; }
  render();
}
async function deleteShift(shiftId){
  try{
    await api(`/api/shifts/${shiftId}`, { method:'DELETE' });
    shifts = shifts.filter(s=>s.id!==shiftId);
    scheduleEditor = null;
  }catch(e){ loadError = e.message; }
  render();
}

async function saveNewCustomEditor(){
  const nameInput = document.getElementById('newCustomName');
  const locSelect = document.getElementById('newCustomLocation');
  const customLocInput = document.getElementById('newCustomCustomLocation');
  const startInput = document.getElementById('newCustomStart');
  const endInput = document.getElementById('newCustomEnd');
  const posSel = document.getElementById('newCustomPosition');
  const openCheckbox = document.getElementById('newCustomOpen');
  if(!locSelect || !scheduleEditor) return;

  let lot = locSelect.value;
  if(lot === '__CUSTOM__'){
    lot = (customLocInput ? customLocInput.value : '').trim();
    if(!lot){ addShiftError = "Enter a name for the custom location."; render(); return; }
  }
  const { date, employeeId } = scheduleEditor;
  const start = startInput.value || '09:00';
  const end = endInput.value || '17:00';
  const positionId = posSel.value || null;
  const open = openCheckbox ? openCheckbox.checked : false;
  const customName = nameInput ? nameInput.value.trim() : '';
  const copy = readCopyOptions('newCustom');

  try{
    const res = await api('/api/shifts', { method:'POST', body: JSON.stringify({ date, lot, customName: customName || null, start, end, employeeId: employeeId || null, open, positionId, ...copy }) });
    shifts.push(res.shift);
    if(res.copies) await refreshShifts();
    addShiftError = null;
    scheduleEditor = null;
  }catch(e){ addShiftError = e.message; }
  render();
}

async function saveSlotEditor(){
  if(!scheduleEditor) return;
  const { date, lot, slotId, start, end } = scheduleEditor;
  const empSel = document.getElementById('slotEditorEmployee');
  const posSel = document.getElementById('slotEditorPosition');
  const employeeId = empSel ? empSel.value : '';
  const positionId = posSel ? (posSel.value || null) : null;
  const copy = readCopyOptions('slotEditor');
  scheduleEditor = null;
  if(!employeeId) await clearSlot(date, lot, slotId);
  else await assignSlot(date, lot, slotId, start, end, employeeId, positionId, copy);
}

function el(html){
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- top-level render ----------
function render(){
  const app = document.getElementById('app');
  if(!loaded){ app.innerHTML = '<div class="loading">Loading shift board…</div>'; return; }

  let html = '';
  html += `<div class="masthead"><img class="masthead-logo" src="/assets/logo-black.png" alt="Xpress Parking" /><div class="titles"><h1>Shift Board</h1></div></div>`;

  if(loadError){
    html += `<div class="err">${loadError}</div>`;
  }

  if(!me && !admin){
    html += renderGate();
  } else if(admin){
    html += renderAdminApp();
  } else {
    html += renderStaffApp();
  }

  html += `<div class="footnote">${admin || me ? 'You\'re signed in — log out to switch accounts.' : 'Sign in to see schedules and availability.'} There\'s no further access control beyond staff vs. admin, so don\'t put anything here you wouldn\'t want a coworker to see.</div>`;

  app.innerHTML = html;
  bindEvents();
}

function renderGate(){
  let html = `<div class="tabs">
    <button class="tab ${authView==='staff'?'active':''}" data-action="setauthview" data-view="staff">Staff</button>
    <button class="tab ${authView==='admin'?'active':''}" data-action="setauthview" data-view="admin">Admin</button>
  </div>`;

  if(authView==='staff'){
    if(loginError) html += `<div class="err">${loginError}</div>`;
    html += `<div class="card">
      <h2>Log in</h2>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>
        <input type="text" id="loginEmail" placeholder="Email" />
      </div>
      <div class="field" style="margin-top:10px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <input type="password" id="loginPassword" placeholder="Password" />
      </div>
      <button class="primary" style="width:100%;margin-top:12px;" id="loginBtn">Log in</button>
    </div>`;

    if(signupError) html += `<div class="err">${signupError}</div>`;
    html += `<div class="card" style="padding:18px;">
      <div class="signup-banner">
        <div class="signup-banner-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg></div>
        <div>
          <div class="signup-banner-title">Join the team</div>
          <div class="signup-banner-sub">New hire or already on the roster — start here</div>
        </div>
      </div>

      <div class="formsection">Your info</div>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <input type="text" id="newEmpName" placeholder="Full name" />
      </div>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>
        <input type="text" id="newEmpEmail" placeholder="Email" />
      </div>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        <input type="text" id="newEmpPhone" placeholder="Phone number" />
      </div>

      <div class="formsection">Create a password</div>
      <p class="empty" style="padding:0 0 8px;">You'll use your email and this password to log in each time.</p>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <input type="password" id="newEmpPassword" placeholder="Password (6+ characters)" />
      </div>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <input type="password" id="newEmpPasswordConfirm" placeholder="Confirm password" />
      </div>

      <button class="primary" style="width:100%;margin-top:14px;" id="addEmpBtn">Sign up</button>
    </div>`;
  } else {
    if(adminLoginError) html += `<div class="err">${adminLoginError}</div>`;
    html += `<div class="card">
      <h2>Admin log in</h2>
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>
        <input type="text" id="adminLoginEmail" placeholder="Email" />
      </div>
      <div class="field" style="margin-top:10px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <input type="password" id="adminLoginPassword" placeholder="Password" />
      </div>
      <button class="primary" style="width:100%;margin-top:12px;" id="adminLoginBtn">Log in</button>
    </div>`;

    if(adminSignupError) html += `<div class="err">${adminSignupError}</div>`;
    html += `<div class="card">
      <h2>New admin sign up</h2>
      <p class="empty" style="padding:0 0 10px;">Requires the admin invite code — ask whoever set up this board.</p>
      <label>Full name</label>
      <input type="text" id="adminName" />
      <label style="margin-top:10px;">Email</label>
      <input type="text" id="adminEmail" />
      <label style="margin-top:10px;">Password</label>
      <input type="password" id="adminPassword" placeholder="6+ characters" />
      <label style="margin-top:10px;">Confirm password</label>
      <input type="password" id="adminPasswordConfirm" />
      <label style="margin-top:10px;">Invite code</label>
      <input type="password" id="adminInviteCode" />
      <button class="primary" style="width:100%;margin-top:12px;" id="adminSignupBtn">Create admin account</button>
    </div>`;
  }

  return html;
}

// ================= STAFF-FACING APP =================
function renderStaffApp(){
  const emp = employees.find(e=>e.id===me.id) || me;

  if(!emp.onboarded){
    return renderOnboarding(emp);
  }

  let html = `<div class="card" style="background:var(--go-bg);border-color:var(--go);">
    <div class="row" style="justify-content:space-between;">
      <span style="font-weight:800;color:var(--go);">Logged in as ${emp.name}</span>
      <button class="ghost" data-action="logout">Log out</button>
    </div>
  </div>`;

  html += `<div class="tabs">
    <button class="tab ${staffTab==='my'?'active':''}" data-action="setstafftab" data-tab="my">My Schedule</button>
    <button class="tab ${staffTab==='schedule'?'active':''}" data-action="setstafftab" data-tab="schedule">Full Schedule</button>
    <button class="tab ${staffTab==='timeoff'?'active':''}" data-action="setstafftab" data-tab="timeoff">Time Off</button>
  </div>`;

  if(staffTab==='my') html += renderMySchedule(emp);
  else if(staffTab==='schedule') html += renderScheduleView({ readOnly:true });
  else html += renderTimeOffStaff(emp);

  return html;
}

function renderOnboarding(emp){
  const onboardDates = getWeekDates(0);
  const empAvailOnboard = availability[emp.id] || {};
  const allSet = onboardDates.every(d=> !!empAvailOnboard[toISO(d)]);

  let html = `<div class="card">
    <h2>One last step — your availability</h2>
    <p class="empty" style="padding:0 0 8px;">Hi ${emp.name} — set your status for each day this week so we know when you can work. You can always change this later.</p>
  </div>`;

  html += '<div class="card">';
  onboardDates.forEach(d=>{
    const iso = toISO(d);
    const state = empAvailOnboard[iso] || null;
    const cls = state ? state : '';
    const label = state ? STATE_LABEL[state] : 'Tap to set';
    html += `<div class="daytile">
      <div class="dinfo"><div class="dname">${fmtDayName(d)}</div><div class="ddate">${fmtDayShort(d)}</div></div>
      <button class="statebtn ${cls}" data-action="toggleday" data-date="${iso}">${icon(state)}<span>${label}</span></button>
    </div>`;
  });
  html += '</div>';

  if(!allSet){
    html += `<div class="card"><p class="empty" style="padding:0;">Set a status for all 7 days to finish signing up.</p></div>`;
  }
  html += `<div class="card">
    <button class="primary" style="width:100%;" data-action="finishonboarding" ${allSet?'':'disabled'}>Finish sign up</button>
  </div>
  <div class="card"><button class="ghost" style="width:100%;" data-action="logout">Log out</button></div>`;
  return html;
}

function renderMySchedule(emp){
  let html = '';
  if(signupError) html += `<div class="err">${signupError}</div>`;
  if(swapError) html += `<div class="err">${swapError}</div>`;

  const incoming = swapRequests.filter(r=>r.toEmployeeId===emp.id);
  if(incoming.length){
    html += `<div class="card"><h2>Shift swaps for you</h2>`;
    html += incoming.map(r=>{
      const shift = shifts.find(s=>s.id===r.shiftId);
      const from = employees.find(e=>e.id===r.fromEmployeeId);
      if(!shift) return '';
      return `<div class="staffcard">
        <div class="staffcard-status" style="margin-top:0;">${from?from.name:'A coworker'} wants you to take:</div>
        <div style="font-weight:700;margin:4px 0 10px;">${describeShift(shift)}</div>
        <div class="row">
          <button class="primary" style="flex:1;" data-action="acceptswap" data-id="${r.id}">Accept</button>
          <button class="ghost" style="flex:1;" data-action="declineswap" data-id="${r.id}">Decline</button>
        </div>
      </div>`;
    }).join('');
    html += `</div>`;
  }

  html += `<div class="card">
    <h2>Your info</h2>
    <label>Full name</label>
    <input type="text" id="myName" value="${emp.name}" />
    <label style="margin-top:10px;">Email</label>
    <input type="text" id="myEmail" value="${emp.email||''}" />
    <label style="margin-top:10px;">Phone number</label>
    <input type="text" id="myPhone" value="${emp.phone||''}" />
    <label style="margin-top:10px;">Home lot</label>
    <select id="myLot">${EMP_HOME_TAGS.map(l=>`<option value="${l}" ${emp.lot===l?'selected':''}>${l}</option>`).join('')}</select>
    <button class="primary" style="width:100%;margin-top:12px;" data-action="saveinfo">Save changes</button>
  </div>`;

  const dates = getWeekDates(weekOffset);
  html += `<div class="card">
    <div class="weeknav">
      <button data-action="week" data-dir="-1">‹</button>
      <div class="label">${fmtWeekLabel(dates)}</div>
      <button data-action="week" data-dir="1">›</button>
    </div>`;

  dates.forEach(d=>{
    const iso = toISO(d);
    const state = (availability[emp.id] && availability[emp.id][iso]) || null;
    const cls = state ? state : '';
    const label = state ? STATE_LABEL[state] : 'Tap to set';
    html += `<div class="daytile">
      <div class="dinfo"><div class="dname">${fmtDayName(d)}</div><div class="ddate">${fmtDayShort(d)}</div></div>
      <button class="statebtn ${cls}" data-action="toggleday" data-date="${iso}">${icon(state)}<span>${label}</span></button>
    </div>`;
  });
  html += `</div>`;

  html += `<div class="card"><h2>Your availability this week</h2>`;
  const empAvail = availability[emp.id] || {};
  const anySet = dates.some(d=>empAvail[toISO(d)]);
  if(!anySet){
    html += `<p class="empty">Nothing set yet — tap each day above and it'll show up here.</p>`;
  } else {
    dates.forEach(d=>{
      const iso = toISO(d);
      const state = empAvail[iso];
      html += `<div class="summaryline"><span>${fmtDayName(d)}, ${fmtDayShort(d)}</span><span class="tag ${state||'unset'}">${state?STATE_LABEL[state]:'Not set'}</span></div>`;
    });
  }
  html += `</div>`;

  const myShifts = shifts.filter(s=>getShiftEmployeeIds(s).includes(emp.id) && dates.some(d=>toISO(d)===s.date))
                          .sort((a,b)=> a.date===b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date));
  html += `<div class="card"><h2>Your shifts this week</h2>`;
  if(!myShifts.length){
    html += `<p class="empty">Nothing assigned to you this week yet.</p>`;
  } else {
    html += myShifts.map(s=>{
      const outgoing = swapRequests.find(r=>r.shiftId===s.id && r.fromEmployeeId===emp.id);
      if(outgoing){
        const to = employees.find(e=>e.id===outgoing.toEmployeeId);
        return `<div class="staffcard">
          <div style="font-weight:700;margin-bottom:8px;">${describeShift(s)}</div>
          <div class="row" style="justify-content:space-between;">
            <span class="empty" style="padding:0;">Swap requested → ${to?to.name:'coworker'}</span>
            <button class="danger" data-action="cancelswap" data-id="${outgoing.id}">Cancel</button>
          </div>
        </div>`;
      }
      const coworkerOptions = employees.filter(e=>e.id!==emp.id).sort((a,b)=>a.name.localeCompare(b.name))
        .map(e=>`<option value="${e.id}">${e.name}</option>`).join('');
      return `<div class="staffcard">
        <div style="font-weight:700;margin-bottom:8px;">${describeShift(s)}</div>
        <select data-action="offerswap" data-shiftid="${s.id}">
          <option value="">Offer this shift to…</option>
          ${coworkerOptions}
        </select>
      </div>`;
    }).join('');
  }
  html += `</div>`;

  const todayIso = toISO(new Date());
  const openShifts = shifts.filter(s=>s.open && !getShiftEmployeeIds(s).length && s.date>=todayIso)
                            .filter(s=>{
                              const st = (availability[emp.id]||{})[s.date];
                              return st !== 'unavailable';
                            })
                            .sort((a,b)=> a.date===b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date));
  html += `<div class="card"><h2>Open shifts</h2>`;
  if(!openShifts.length){
    html += `<p class="empty">No open shifts posted right now.</p>`;
  } else {
    html += openShifts.map(s=>`
      <div class="staffcard">
        <div style="font-weight:700;margin-bottom:8px;">${describeShift(s)}</div>
        <button class="primary" style="width:100%;" data-action="claimshift" data-id="${s.id}">Claim this shift</button>
      </div>
    `).join('');
  }
  html += `</div>`;

  return html;
}

function ptoStatusTag(status){
  const cls = status==='approved' ? 'available' : status==='denied' ? 'unavailable' : 'unset';
  const label = status.charAt(0).toUpperCase()+status.slice(1);
  return `<span class="tag ${cls}">${label}</span>`;
}

function renderTimeOffStaff(emp){
  let html = '';
  if(ptoError) html += `<div class="err">${ptoError}</div>`;

  html += `<div class="card">
    <h2>Request time off</h2>
    <label>Start date</label>
    <input type="date" id="ptoStart" />
    <label style="margin-top:10px;">End date</label>
    <input type="date" id="ptoEnd" />
    <label style="margin-top:10px;">Reason (optional)</label>
    <input type="text" id="ptoReason" placeholder="e.g. Family trip" />
    <button class="primary" style="width:100%;margin-top:12px;" data-action="submitpto">Submit request</button>
  </div>`;

  const mine = ptoRequests.filter(r=>r.employeeId===emp.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  html += `<div class="card"><h2>Your requests</h2>`;
  if(!mine.length){
    html += `<p class="empty">No time-off requests yet.</p>`;
  } else {
    html += mine.map(r=>`
      <div class="staffcard">
        <div class="row" style="justify-content:space-between;">
          <span style="font-weight:700;">${fmtDateShort(r.startDate)} – ${fmtDateShort(r.endDate)}</span>
          ${ptoStatusTag(r.status)}
        </div>
        ${r.reason ? `<div class="staffcard-status" style="margin-top:6px;">${r.reason}</div>` : ''}
        ${r.status==='pending' ? `<button class="danger" style="width:100%;margin-top:10px;" data-action="cancelpto" data-id="${r.id}">Cancel request</button>` : ''}
      </div>
    `).join('');
  }
  html += `</div>`;

  return html;
}

// ================= ADMIN APP =================
function renderAdminApp(){
  let html = `<div class="card" style="background:var(--brand-bg);border-color:var(--brand);">
    <div class="row" style="justify-content:space-between;">
      <span style="font-weight:800;color:var(--brand);">Admin: ${admin.name}</span>
      <button class="ghost" data-action="logout">Log out</button>
    </div>
  </div>`;

  html += `<div class="tabs">
    <button class="tab ${adminTab==='schedule'?'active':''}" data-action="setadmintab" data-tab="schedule">Schedule</button>
    <button class="tab ${adminTab==='staff'?'active':''}" data-action="setadmintab" data-tab="staff">Staff &amp; Availability</button>
    <button class="tab ${adminTab==='timeoff'?'active':''}" data-action="setadmintab" data-tab="timeoff">Time Off</button>
  </div>`;

  if(adminTab==='schedule') html += renderScheduleView({ readOnly:false });
  else if(adminTab==='staff') html += renderManagerView();
  else html += renderTimeOffAdmin();

  return html;
}

function renderTimeOffAdmin(){
  let html = '';
  if(ptoError) html += `<div class="err">${ptoError}</div>`;

  const pending = ptoRequests.filter(r=>r.status==='pending').sort((a,b)=>a.startDate.localeCompare(b.startDate));
  const resolved = ptoRequests.filter(r=>r.status!=='pending').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));

  html += `<div class="card"><h2>Pending requests</h2>`;
  if(!pending.length){
    html += `<p class="empty">Nothing pending.</p>`;
  } else {
    html += pending.map(r=>{
      const e = employees.find(x=>x.id===r.employeeId);
      return `<div class="staffcard">
        <div style="font-weight:700;">${e?e.name:'(removed)'}</div>
        <div class="staffcard-status" style="margin-top:2px;">${fmtDateShort(r.startDate)} – ${fmtDateShort(r.endDate)}${r.reason ? ' · '+r.reason : ''}</div>
        <div class="row" style="margin-top:10px;">
          <button class="primary" style="flex:1;" data-action="approvepto" data-id="${r.id}">Approve</button>
          <button class="ghost" style="flex:1;" data-action="denypto" data-id="${r.id}">Deny</button>
        </div>
      </div>`;
    }).join('');
  }
  html += `</div>`;

  html += `<div class="card"><h2>History</h2>`;
  if(!resolved.length){
    html += `<p class="empty">No resolved requests yet.</p>`;
  } else {
    html += resolved.map(r=>{
      const e = employees.find(x=>x.id===r.employeeId);
      return `<div class="summaryline"><span>${e?e.name:'(removed)'} · ${fmtDateShort(r.startDate)}–${fmtDateShort(r.endDate)}</span>${ptoStatusTag(r.status)}</div>`;
    }).join('');
  }
  html += `</div>`;

  return html;
}

// ---------- schedule grid (row per employee/Open Shifts, column per day) ----------
function buildScheduleRows(dates, filterEmps){
  const weekIso = dates.map(toISO);
  const cells = {};
  function pushBlock(key, iso, block){
    const k = key+'|'+iso;
    if(!cells[k]) cells[k] = [];
    cells[k].push(block);
  }

  dates.forEach(d=>{
    const iso = toISO(d);
    Object.keys(DAILY_TEMPLATES).forEach(location=>{
      DAILY_TEMPLATES[location].forEach(slot=>{
        if(!slotApplies(slot, d)) return;
        const s = shifts.find(x=>x.date===iso && x.lot===location && x.slotId===slot.id);
        const ids = s ? getShiftEmployeeIds(s) : [];
        const key = ids.length ? ids[0] : 'OPEN';
        pushBlock(key, iso, {
          kind:'slot', date: iso, lot: location, slotId: slot.id, start: slot.start, end: slot.end,
          label: location+' — '+slot.label, shift: s||null, color: colorForShift(s)
        });
      });
    });
  });

  shifts.filter(s=>!s.slotId && weekIso.includes(s.date)).forEach(s=>{
    const ids = getShiftEmployeeIds(s);
    const label = s.lot + (s.customName ? ' — '+s.customName : ' — Extra shift');
    if(ids.length===0){
      pushBlock('OPEN', s.date, { kind:'custom', date:s.date, shift:s, label, color: colorForShift(s) });
    } else {
      ids.forEach(id=> pushBlock(id, s.date, { kind:'custom', date:s.date, shift:s, label, color: colorForShift(s) }));
    }
  });

  Object.keys(cells).forEach(k=>{
    cells[k].sort((a,b)=>{
      const as = a.kind==='slot' ? a.start : a.shift.start;
      const bs = b.kind==='slot' ? b.start : b.shift.start;
      return as.localeCompare(bs);
    });
  });

  const rowKeys = [{key:'OPEN', label:'Open Shifts'}].concat(
    filterEmps.map(e=>({key:e.id, label:e.name}))
  );

  return { cells, rowKeys };
}

function renderEmployeeGrid(dates, readOnly, filterEmps){
  const { cells, rowKeys } = buildScheduleRows(dates, filterEmps);

  let html = `<div class="schedgrid-wrap"><table class="schedgrid"><thead><tr><th class="schedgrid-namecol"></th>`;
  dates.forEach(d=> html += `<th>${d.toLocaleDateString('en-US',{weekday:'short'})}<span class="sub">${fmtDayShort(d)}</span></th>`);
  html += `</tr></thead><tbody>`;

  rowKeys.forEach(row=>{
    html += `<tr><td class="schedgrid-namecol${row.key==='OPEN'?' schedgrid-openrow':''}">${row.label}</td>`;
    dates.forEach(d=>{
      const iso = toISO(d);
      const blocks = cells[row.key+'|'+iso] || [];
      html += `<td class="schedgrid-cell">`;
      blocks.forEach(b=>{
        const timeStr = b.kind==='slot' ? `${fmt12(b.start)}–${fmt12(b.end)}` : `${fmt12(b.shift.start)}–${fmt12(b.shift.end)}`;
        const draft = b.kind==='slot' ? (b.shift && b.shift.draft) : b.shift.draft;
        const openTag = (b.kind==='custom' && b.shift.open && !getShiftEmployeeIds(b.shift).length) ? ' <span class="tag unset">OPEN</span>' : '';
        const colorStyle = b.color ? `border-left-color:${b.color};background:${b.color}1A;` : '';
        const action = readOnly ? '' : (b.kind==='slot'
          ? `data-action="openslot" data-date="${b.date}" data-lot="${b.lot}" data-slotid="${b.slotId}" data-start="${b.start}" data-end="${b.end}"`
          : `data-action="openshift" data-shiftid="${b.shift.id}"`);
        html += `<div class="schedchip" ${action} style="${colorStyle}${readOnly?'':'cursor:pointer;'}">
          <div class="schedchip-label">${b.label}${openTag}</div>
          <div class="schedchip-time">${timeStr}${draft?' · Draft':''}</div>
        </div>`;
      });
      if(!readOnly){
        html += `<button class="schedgrid-add" data-action="opennewcustom" data-empid="${row.key==='OPEN'?'':row.key}" data-date="${iso}">+ Add</button>`;
      }
      html += `</td>`;
    });
    html += `</tr>`;
  });

  html += `</tbody></table></div>`;
  return html;
}

function renderSlotEditor(ed){
  const s = shifts.find(x=>x.date===ed.date && x.lot===ed.lot && x.slotId===ed.slotId);
  const assignedId = s ? (getShiftEmployeeIds(s)[0]||'') : '';
  const template = (DAILY_TEMPLATES[ed.lot]||[]).find(sl=>sl.id===ed.slotId);
  const d = new Date(ed.date+'T00:00:00');
  return `<div class="card">
    <h2>${ed.lot} — ${template?template.label:''}</h2>
    <p class="empty" style="padding:0 0 10px;">${fmtDayName(d)}, ${fmtDayShort(d)} · ${fmt12(ed.start)}–${fmt12(ed.end)}</p>
    <label>Assign to</label>
    <select id="slotEditorEmployee">${slotOptionsHtml(ed.date, assignedId)}</select>
    <label style="margin-top:10px;">Position</label>
    <select id="slotEditorPosition">${positionOptionsHtml(s?s.positionId:null)}</select>
    ${renderCopyOptionsHtml('slotEditor')}
    <div class="row" style="margin-top:12px;">
      <button class="ghost" data-action="closeeditor" style="flex:1;">Cancel</button>
      <button class="primary" data-action="saveslot" style="flex:1;">Save</button>
    </div>
  </div>`;
}

function renderShiftEditor(ed){
  const s = shifts.find(x=>x.id===ed.shiftId);
  if(!s) return '';
  const d = new Date(s.date+'T00:00:00');
  const ids = getShiftEmployeeIds(s);
  const chipsInline = ids.map(id=>{
    const e = employees.find(x=>x.id===id);
    return `<span class="achip achip-sm">${e?e.name:'(removed)'} <button type="button" data-action="removeassignee" data-shiftid="${s.id}" data-empid="${id}">×</button></span>`;
  }).join('');
  return `<div class="card">
    <h2>Edit shift</h2>
    <p class="empty" style="padding:0 0 10px;">${s.lot} · ${fmtDayName(d)}, ${fmtDayShort(d)}</p>
    <label>Shift name</label>
    <input type="text" value="${s.customName||''}" placeholder="Optional" data-action="shifttime" data-field="customName" data-shiftid="${s.id}" />
    <label style="margin-top:10px;">Time</label>
    <div class="trow" style="display:flex;gap:8px;">
      <input type="time" value="${s.start}" data-action="shifttime" data-field="start" data-shiftid="${s.id}" />
      <input type="time" value="${s.end}" data-action="shifttime" data-field="end" data-shiftid="${s.id}" />
    </div>
    <label style="margin-top:10px;">Position</label>
    <select data-action="shiftposition" data-shiftid="${s.id}">${positionOptionsHtml(s.positionId)}</select>
    ${ids.length ? `<div class="assignedchips" style="margin-top:10px;">${chipsInline}</div>` : ''}
    <label style="margin-top:10px;">${ids.length?'Add another':'Assign to'}</label>
    <select data-action="addassignee" data-shiftid="${s.id}">${addAssigneeOptionsHtml(s.date, ids)}</select>
    ${ids.length===0 ? `<div class="row" style="margin-top:10px;align-items:center;">
      <input type="checkbox" data-action="toggleopen" data-shiftid="${s.id}" ${s.open?'checked':''} style="width:auto;" />
      <label style="margin:0;">Open for pickup</label>
    </div>` : ''}
    <div class="row" style="margin-top:12px;">
      <button class="ghost" data-action="closeeditor" style="flex:1;">Done</button>
      <button class="danger" data-action="deleteshift" data-shiftid="${s.id}" style="flex:1;">Remove shift</button>
    </div>
  </div>`;
}

function renderNewCustomEditor(ed){
  const d = new Date(ed.date+'T00:00:00');
  const emp = ed.employeeId ? employees.find(e=>e.id===ed.employeeId) : null;
  return `<div class="card">
    <h2>Add shift${emp ? ' for '+emp.name : ''}</h2>
    <p class="empty" style="padding:0 0 10px;">${fmtDayName(d)}, ${fmtDayShort(d)}</p>
    <label>Shift name (optional)</label>
    <input type="text" id="newCustomName" placeholder="e.g. UK Game Day Valet" />
    <label style="margin-top:10px;">Location</label>
    <select id="newCustomLocation">
      ${Object.keys(DAILY_TEMPLATES).map(l=>`<option value="${l}">${l} (extra shift)</option>`).join('')}
      ${LOTS.map(l=>`<option value="${l}">${l}</option>`).join('')}
      <option value="Private Event">Private Event</option>
      <option value="__CUSTOM__">Custom…</option>
    </select>
    <div id="newCustomLocationWrap" style="display:none;margin-top:8px;">
      <input type="text" id="newCustomCustomLocation" placeholder="Type the location name" />
    </div>
    <label style="margin-top:10px;">Time</label>
    <div class="trow" style="display:flex;gap:8px;">
      <input type="time" id="newCustomStart" value="09:00" />
      <input type="time" id="newCustomEnd" value="17:00" />
    </div>
    <label style="margin-top:10px;">Position</label>
    <select id="newCustomPosition">${positionOptionsHtml(emp?emp.defaultPositionId:null)}</select>
    ${!emp ? `<div class="row" style="margin-top:10px;align-items:center;">
      <input type="checkbox" id="newCustomOpen" style="width:auto;" />
      <label style="margin:0;" for="newCustomOpen">Post as open (any available staff can claim it)</label>
    </div>` : ''}
    ${renderCopyOptionsHtml('newCustom')}
    <div class="row" style="margin-top:12px;">
      <button class="ghost" data-action="closeeditor" style="flex:1;">Cancel</button>
      <button class="primary" data-action="savenewcustom" style="flex:1;">Add shift</button>
    </div>
  </div>`;
}

function renderScheduleView(opts){
  const readOnly = !!(opts && opts.readOnly);
  const dates = getWeekDates(weekOffset);
  const weekIso = dates.map(toISO);

  let html = '';

  html += `<div class="card">
    <div class="weeknav">
      <button data-action="week" data-dir="-1">‹</button>
      <div class="label">${fmtWeekLabel(dates)}</div>
      <button data-action="week" data-dir="1">›</button>
    </div>
  </div>`;

  let filterEmps;
  if(readOnly){
    filterEmps = employees.filter(e=>shifts.some(s=>s.date && weekIso.includes(s.date) && getShiftEmployeeIds(s).includes(e.id)))
                           .sort((a,b)=>a.name.localeCompare(b.name));
  } else {
    html += '<div class="card"><h2>Lot</h2>';
    html += `<select id="lotSelect">
      <option value="__ALL__" ${managerLot==='__ALL__'?'selected':''}>All Lots</option>
      ${LOTS.map(l=>`<option value="${l}" ${managerLot===l?'selected':''}>${l}</option>`).join('')}
      <option value="Unassigned" ${managerLot==='Unassigned'?'selected':''}>Unassigned</option>
    </select></div>`;
    filterEmps = employees.filter(e => managerLot==='__ALL__' || e.lot===managerLot)
                           .sort((a,b)=>a.name.localeCompare(b.name));
  }

  html += `<div class="card" style="padding:12px 8px;">
    <h2 style="padding:0 8px;">This Week's Schedule</h2>
    <p class="empty" style="padding:0 8px 6px;">Open Shifts up top, then one row per person. ${readOnly?'':'Click any shift to edit it, or "+ Add" to create one.'}</p>
  </div>`;

  html += `<div class="card" style="padding:8px;">${renderEmployeeGrid(dates, readOnly, filterEmps)}</div>`;

  if(readOnly) return html;

  if(addShiftError){
    html += `<div class="err">${addShiftError}</div>`;
  }

  const draftCount = weekIso.reduce((n,iso)=> n + shifts.filter(s=>s.date===iso && s.draft).length, 0);
  html += `<div class="card">
    <div class="row" style="justify-content:space-between;">
      <span class="empty" style="padding:0;">${draftCount>0 ? draftCount+' shift'+(draftCount===1?'':'s')+" not published yet — your team can't see "+(draftCount===1?'it':'them')+'.' : 'This week is fully published.'}</span>
    </div>
    <button class="primary" style="width:100%;margin-top:10px;" data-action="publishweek" ${draftCount===0?'disabled':''}>Publish week</button>
  </div>`;

  if(scheduleEditor){
    if(scheduleEditor.type==='slot') html += renderSlotEditor(scheduleEditor);
    else if(scheduleEditor.type==='shift'){
      const editorHtml = renderShiftEditor(scheduleEditor);
      if(editorHtml) html += editorHtml; else scheduleEditor = null;
    }
    else if(scheduleEditor.type==='newcustom') html += renderNewCustomEditor(scheduleEditor);
  }

  return html;
}

function renderManagerView(){
  let html = '';

  if(importResultMsg){
    html += `<div class="card" style="background:var(--go-bg);border-color:var(--go);">
      <p class="empty" style="padding:0;color:var(--go);font-weight:700;">${importResultMsg}</p>
    </div>`;
  }

  html += `<div class="card">
    <h2>Import roster</h2>
    <p class="empty" style="padding:0 0 10px;">Adds all active QuickBooks employees to the list below, tagged "Unassigned" until you sort them into lots. Safe to tap more than once — names already on the list are skipped.</p>
    <button class="primary" style="width:100%;" data-action="importroster">Import roster</button>
  </div>`;

  if(positionError) html += `<div class="err">${positionError}</div>`;
  html += `<div class="card">
    <h2>Positions</h2>
    <p class="empty" style="padding:0 0 10px;">Color-coded roles you can tag onto any shift — shows up as a colored accent on the schedule.</p>
    ${positions.length ? positions.map(p=>`
      <div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
        <span class="row" style="gap:8px;"><span style="width:14px;height:14px;border-radius:50%;background:${p.color};display:inline-block;"></span>${p.name}</span>
        <button class="danger" data-action="removeposition" data-id="${p.id}">Remove</button>
      </div>
    `).join('') : '<p class="empty" style="padding:0 0 10px;">No positions yet.</p>'}
    <label style="margin-top:12px;">New position name</label>
    <input type="text" id="newPositionName" placeholder="e.g. Runner" />
    <label style="margin-top:10px;">Color</label>
    <div class="row" style="flex-wrap:wrap;gap:8px;">
      ${POSITION_COLORS.map((c,i)=>`<label style="cursor:pointer;">
        <input type="radio" name="newPositionColor" value="${c}" ${i===0?'checked':''} style="display:none;" />
        <span style="width:24px;height:24px;border-radius:50%;background:${c};display:inline-block;border:2px solid transparent;" class="colorswatch" data-color="${c}"></span>
      </label>`).join('')}
    </div>
    <button class="primary" style="width:100%;margin-top:12px;" data-action="addposition">Add position</button>
  </div>`;

  html += '<div class="card"><h2>Lot</h2>';
  html += `<select id="lotSelect">
    <option value="__ALL__" ${managerLot==='__ALL__'?'selected':''}>All Lots (Admin)</option>
    ${LOTS.map(l=>`<option value="${l}" ${managerLot===l?'selected':''}>${l}</option>`).join('')}
    <option value="Unassigned" ${managerLot==='Unassigned'?'selected':''}>Unassigned</option>
  </select></div>`;

  const dates = getWeekDates(weekOffset);
  const emps = employees.filter(e => managerLot==='__ALL__' || e.lot===managerLot)
                         .sort((a,b)=>a.name.localeCompare(b.name));

  html += `<div class="card">
    <div class="weeknav">
      <button data-action="week" data-dir="-1">‹</button>
      <div class="label">${fmtWeekLabel(dates)}</div>
      <button data-action="week" data-dir="1">›</button>
    </div>`;

  if(emps.length===0){
    html += `<p class="empty">No staff added for this lot yet. Ask them to add themselves under "I'm Staff".</p>`;
  } else {
    html += `<div style="overflow-x:auto;"><table class="schedtable"><thead><tr><th style="text-align:left;">Staff</th>`;
    dates.forEach(d=>{
      const iso = toISO(d);
      html += `<th data-action="opendaybreakdown" data-date="${iso}">${d.toLocaleDateString('en-US',{weekday:'short'})}<br>${d.getDate()}</th>`;
    });
    html += `</tr></thead><tbody>`;
    emps.forEach(emp=>{
      html += `<tr><td class="namecell">${emp.name}${managerLot==='__ALL__'?`<br><span style="font-weight:400;color:var(--ink-muted);font-size:10.5px;">${emp.lot}</span>`:''}</td>`;
      dates.forEach(d=>{
        const iso = toISO(d);
        const state = (availability[emp.id] && availability[emp.id][iso]) || null;
        html += `<td>${state ? `<span class="dot ${state}" title="${STATE_LABEL[state]}"></span>` : '—'}</td>`;
      });
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    html += `<div class="footnote">Tap a day heading below the date to see who's available, needed, or out that day.</div>`;
  }
  html += `</div>`;

  if(openDayKey && emps.length){
    const d = dates.find(dd=>toISO(dd)===openDayKey);
    if(d){
      const groups = {available:[], unavailable:[], unset:[]};
      emps.forEach(emp=>{
        const state = (availability[emp.id] && availability[emp.id][openDayKey]) || 'unset';
        groups[state].push(emp.name);
      });
      html += `<div class="card breakdown">
        <h3>${fmtDayName(d)}, ${fmtDayShort(d)} — ${managerLot==='__ALL__'?'All Lots':managerLot}</h3>
        ${renderGroup('available','Available',groups.available)}
        ${renderGroup('unavailable','Unavailable',groups.unavailable)}
        ${renderGroup('unset',"Haven't responded",groups.unset)}
      </div>`;
    }
  }

  html += renderStaffDirectory(emps);

  return html;
}

function renderStaffDirectory(emps){
  let html = `<div class="card"><h2>Staff Directory</h2>`;
  if(emps.length===0){
    html += `<p class="empty">No staff to show for this lot yet.</p>`;
  } else {
    html += `<div class="staffdirectory-grid">` + emps.map(emp=>`
      <div class="staffcard">
        <div class="staffcard-head">
          <input type="text" class="staffname" value="${emp.name}" data-action="staffedit" data-id="${emp.id}" data-field="name" />
          <button class="danger" data-action="removestaff" data-id="${emp.id}">Remove</button>
        </div>
        <div class="staffcard-fields">
          <input type="text" placeholder="Email" value="${emp.email||''}" data-action="staffedit" data-id="${emp.id}" data-field="email" />
          <input type="text" placeholder="Phone" value="${emp.phone||''}" data-action="staffedit" data-id="${emp.id}" data-field="phone" />
          <select data-action="staffedit" data-id="${emp.id}" data-field="lot">
            ${EMP_HOME_TAGS.map(l=>`<option value="${l}" ${emp.lot===l?'selected':''}>${l}</option>`).join('')}
          </select>
          <select data-action="staffedit" data-id="${emp.id}" data-field="defaultPositionId">${positionOptionsHtml(emp.defaultPositionId)}</select>
        </div>
        <div class="staffcard-status">${emp.onboarded ? 'Signed up' : 'Not signed up yet'}</div>
      </div>
    `).join('') + `</div>`;
  }
  html += `</div>`;
  return html;
}

function renderGroup(key, title, names){
  return `<div class="blist ${key}">
    <div class="btitle">${title.toUpperCase()} (${names.length})</div>
    <div class="names">${names.length ? names.join(', ') : '—'}</div>
  </div>`;
}

function bindEvents(){
  const app = document.getElementById('app');

  app.querySelectorAll('[data-action="setauthview"]').forEach(b=> b.onclick = ()=>{ authView = b.dataset.view; render(); });
  app.querySelectorAll('[data-action="setstafftab"]').forEach(b=> b.onclick = ()=>{ staffTab = b.dataset.tab; openDayKey=null; render(); });
  app.querySelectorAll('[data-action="setadmintab"]').forEach(b=> b.onclick = ()=>{ adminTab = b.dataset.tab; openDayKey=null; scheduleEditor=null; render(); });

  const loginBtn = app.querySelector('#loginBtn');
  if(loginBtn) loginBtn.onclick = ()=>{
    const email = app.querySelector('#loginEmail').value;
    const password = app.querySelector('#loginPassword').value;
    loginEmployee(email, password);
  };

  const addBtn = app.querySelector('#addEmpBtn');
  if(addBtn) addBtn.onclick = ()=>{
    const name = app.querySelector('#newEmpName').value;
    const email = app.querySelector('#newEmpEmail').value;
    const phone = app.querySelector('#newEmpPhone').value;
    const password = app.querySelector('#newEmpPassword').value;
    const passwordConfirm = app.querySelector('#newEmpPasswordConfirm').value;
    addEmployee(name, email, phone, password, passwordConfirm);
  };

  const adminLoginBtn = app.querySelector('#adminLoginBtn');
  if(adminLoginBtn) adminLoginBtn.onclick = ()=>{
    const email = app.querySelector('#adminLoginEmail').value;
    const password = app.querySelector('#adminLoginPassword').value;
    adminLogin(email, password);
  };
  const adminSignupBtn = app.querySelector('#adminSignupBtn');
  if(adminSignupBtn) adminSignupBtn.onclick = ()=>{
    const name = app.querySelector('#adminName').value;
    const email = app.querySelector('#adminEmail').value;
    const password = app.querySelector('#adminPassword').value;
    const passwordConfirm = app.querySelector('#adminPasswordConfirm').value;
    const inviteCode = app.querySelector('#adminInviteCode').value;
    adminSignup(name, email, password, passwordConfirm, inviteCode);
  };

  app.querySelectorAll('[data-action="logout"]').forEach(b=> b.onclick = ()=> logoutEmployee());
  app.querySelectorAll('[data-action="saveinfo"]').forEach(b=> b.onclick = ()=> updateMyInfo());
  app.querySelectorAll('[data-action="finishonboarding"]').forEach(b=> b.onclick = async ()=>{
    try{
      const res = await api('/api/employees/me/onboard', { method:'PUT' });
      me = res.employee;
      const idx = employees.findIndex(e=>e.id===me.id);
      if(idx>=0) employees[idx] = me;
    }catch(e){ loadError = e.message; }
    render();
  });

  app.querySelectorAll('[data-action="acceptswap"]').forEach(b=> b.onclick = ()=> acceptSwap(b.dataset.id));
  app.querySelectorAll('[data-action="declineswap"]').forEach(b=> b.onclick = ()=> declineSwap(b.dataset.id));
  app.querySelectorAll('[data-action="cancelswap"]').forEach(b=> b.onclick = ()=> cancelSwap(b.dataset.id));
  app.querySelectorAll('[data-action="offerswap"]').forEach(sel=> sel.onchange = ()=>{
    if(!sel.value) return;
    requestSwap(sel.dataset.shiftid, sel.value);
  });
  app.querySelectorAll('[data-action="claimshift"]').forEach(b=> b.onclick = ()=> claimShift(b.dataset.id));

  app.querySelectorAll('[data-action="submitpto"]').forEach(b=> b.onclick = ()=> submitPto());
  app.querySelectorAll('[data-action="cancelpto"]').forEach(b=> b.onclick = ()=> cancelPto(b.dataset.id));
  app.querySelectorAll('[data-action="approvepto"]').forEach(b=> b.onclick = ()=> approvePto(b.dataset.id));
  app.querySelectorAll('[data-action="denypto"]').forEach(b=> b.onclick = ()=> denyPto(b.dataset.id));

  const lotSelect = app.querySelector('#lotSelect');
  if(lotSelect) lotSelect.onchange = ()=>{ managerLot = lotSelect.value; openDayKey=null; scheduleEditor=null; render(); };

  app.querySelectorAll('[data-action="importroster"]').forEach(b=> b.onclick = ()=> importRoster());

  app.querySelectorAll('[data-action="addposition"]').forEach(b=> b.onclick = ()=> addPosition());
  app.querySelectorAll('[data-action="removeposition"]').forEach(b=> b.onclick = ()=> removePosition(b.dataset.id));
  app.querySelectorAll('input[name="newPositionColor"]').forEach(radio=>{
    const sync = ()=>{
      app.querySelectorAll('.colorswatch').forEach(sw=>{
        const r = app.querySelector(`input[name="newPositionColor"][value="${sw.dataset.color}"]`);
        sw.style.borderColor = (r && r.checked) ? 'var(--ink)' : 'transparent';
      });
    };
    radio.onchange = sync;
    if(radio.checked) sync();
  });

  app.querySelectorAll('[data-action="publishweek"]').forEach(b=> b.onclick = ()=> publishWeek());

  // schedule grid interactions
  app.querySelectorAll('[data-action="openslot"]').forEach(el=> el.onclick = ()=>{
    scheduleEditor = { type:'slot', date:el.dataset.date, lot:el.dataset.lot, slotId:el.dataset.slotid, start:el.dataset.start, end:el.dataset.end };
    render();
  });
  app.querySelectorAll('[data-action="openshift"]').forEach(el=> el.onclick = ()=>{
    scheduleEditor = { type:'shift', shiftId: el.dataset.shiftid };
    render();
  });
  app.querySelectorAll('[data-action="opennewcustom"]').forEach(el=> el.onclick = ()=>{
    scheduleEditor = { type:'newcustom', employeeId: el.dataset.empid || null, date: el.dataset.date };
    render();
  });
  app.querySelectorAll('[data-action="closeeditor"]').forEach(b=> b.onclick = ()=>{ scheduleEditor = null; addShiftError = null; render(); });
  app.querySelectorAll('[data-action="saveslot"]').forEach(b=> b.onclick = ()=> saveSlotEditor());
  app.querySelectorAll('[data-action="savenewcustom"]').forEach(b=> b.onclick = ()=> saveNewCustomEditor());

  const newCustomLocation = app.querySelector('#newCustomLocation');
  if(newCustomLocation) newCustomLocation.onchange = ()=>{
    const wrap = app.querySelector('#newCustomLocationWrap');
    if(wrap) wrap.style.display = newCustomLocation.value === '__CUSTOM__' ? 'block' : 'none';
  };

  app.querySelectorAll('[data-action="deleteshift"]').forEach(b=> b.onclick = ()=>{
    deleteShift(b.dataset.shiftid);
  });
  app.querySelectorAll('[data-action="shifttime"]').forEach(inp=> inp.onchange = ()=>{
    let val = inp.value;
    if(inp.dataset.field==='customName' && val.trim()==='') val = null;
    updateShift(inp.dataset.shiftid, inp.dataset.field, val);
  });
  app.querySelectorAll('[data-action="shiftposition"]').forEach(sel=> sel.onchange = ()=>{
    updateShift(sel.dataset.shiftid, 'positionId', sel.value || null);
  });
  app.querySelectorAll('[data-action="toggleopen"]').forEach(inp=> inp.onchange = ()=>{
    updateShift(inp.dataset.shiftid, 'open', inp.checked);
  });
  app.querySelectorAll('[data-action="addassignee"]').forEach(sel=> sel.onchange = ()=>{
    if(!sel.value) return;
    addShiftAssignee(sel.dataset.shiftid, sel.value);
  });
  app.querySelectorAll('[data-action="removeassignee"]').forEach(b=> b.onclick = ()=>{
    removeShiftAssignee(b.dataset.shiftid, b.dataset.empid);
  });

  app.querySelectorAll('[data-action="week"]').forEach(b=> b.onclick = ()=>{
    weekOffset += parseInt(b.dataset.dir,10);
    openDayKey = null;
    scheduleEditor = null;
    render();
  });

  app.querySelectorAll('[data-action="toggleday"]').forEach(b=> b.onclick = ()=>{
    if(!me) return;
    const date = b.dataset.date;
    const current = (availability[me.id] && availability[me.id][date]) || null;
    setDayState(me.id, date, cycleState(current));
  });

  app.querySelectorAll('[data-action="opendaybreakdown"]').forEach(th=> th.onclick = ()=>{
    const date = th.dataset.date;
    openDayKey = (openDayKey===date) ? null : date;
    render();
  });

  app.querySelectorAll('[data-action="staffedit"]').forEach(el=> el.onchange = ()=>{
    updateStaffField(el.dataset.id, el.dataset.field, el.value);
  });
  app.querySelectorAll('[data-action="removestaff"]').forEach(b=> b.onclick = ()=>{
    if(confirm('Remove this person? This deletes their profile, availability, and any shift assignments.')){
      removeStaffMember(b.dataset.id);
    }
  });
}

loadAll();
