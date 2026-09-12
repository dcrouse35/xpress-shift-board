const { LOTS, EMP_HOME_TAGS, STATE_ORDER, STATE_LABEL, DAILY_TEMPLATES, slotApplies } = window.APP_CONSTANTS;

let employees = [];
let availability = {}; // { employeeId: { 'YYYY-MM-DD': state } }
let shifts = []; // [ {id, date, employeeIds, lot, slotId?, customName?, start, end, draft} ]
let swapRequests = []; // [ {id, shiftId, fromEmployeeId, toEmployeeId, createdAt} ]
let swapError = null;
let role = "employee"; // employee | schedule | manager
let me = null; // current logged-in employee (sanitized, no password)
let currentEmployeeId = null;
let loggedInId = null;
let managerLot = LOTS[0];
let editingShiftId = null;
let addShiftError = null;
let signupError = null;
let loginError = null;
let importResultMsg = null;
let weekOffset = 0; // 0 = this week
let openDayKey = null; // for manager breakdown panel
let loaded = false;
let loadError = null;

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
    const [empRes, availRes, shiftRes, meRes, swapRes] = await Promise.all([
      api('/api/employees'), api('/api/availability'), api('/api/shifts'), api('/api/me'), api('/api/swaps')
    ]);
    employees = empRes.employees;
    availability = availRes.availability;
    shifts = shiftRes.shifts;
    me = meRes.employee;
    currentEmployeeId = me ? me.id : null;
    loggedInId = currentEmployeeId;
    swapRequests = swapRes.swaps;
  }catch(e){
    loadError = "Couldn't load the shift board — check your connection and reload.";
  }
  loaded = true;
  render();
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
    currentEmployeeId = me.id;
    loggedInId = me.id;
    signupError = null;
    const empRes = await api('/api/employees');
    employees = empRes.employees;
  }catch(e){ signupError = e.message; }
  render();
}

async function loginEmployee(email, password){
  try{
    const res = await api('/api/auth/login', { method:'POST', body: JSON.stringify({email,password}) });
    me = res.employee;
    currentEmployeeId = me.id;
    loggedInId = me.id;
    loginError = null;
  }catch(e){ loginError = e.message; }
  render();
}

async function logoutEmployee(){
  try{ await api('/api/auth/logout', { method:'POST' }); }catch(e){}
  me = null;
  currentEmployeeId = null;
  loggedInId = null;
  loginError = null;
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

// ---------- shifts ----------
function getShiftEmployeeIds(s){ return s.employeeIds || []; }

function findShift(shiftId){
  const shift = shifts.find(s=>s.id===shiftId);
  return shift ? { dateISO: shift.date, shift } : null;
}

async function submitCustomShift(){
  const nameInput = document.getElementById('newShiftName');
  const locSelect = document.getElementById('newShiftLocation');
  const customLocInput = document.getElementById('newShiftCustomLocation');
  const dateSelect = document.getElementById('newShiftDate');
  const startInput = document.getElementById('newShiftStart');
  const endInput = document.getElementById('newShiftEnd');
  const assignSelect = document.getElementById('newShiftAssign');
  if(!locSelect || !dateSelect) return;

  let lot = locSelect.value;
  if(lot === '__CUSTOM__'){
    lot = (customLocInput ? customLocInput.value : '').trim();
    if(!lot){
      addShiftError = "Enter a name for the custom location.";
      render();
      return;
    }
  }
  const date = dateSelect.value;
  const start = startInput.value || '09:00';
  const end = endInput.value || '17:00';
  const employeeId = assignSelect && assignSelect.value ? assignSelect.value : null;
  const customName = nameInput ? nameInput.value.trim() : '';

  try{
    const res = await api('/api/shifts', { method:'POST', body: JSON.stringify({ date, lot, customName: customName || null, start, end, employeeId }) });
    shifts.push(res.shift);
    addShiftError = null;
  }catch(e){ addShiftError = e.message; }
  render();
}

async function assignSlot(dateISO, lot, slotId, start, end, employeeId){
  try{
    const res = await api('/api/shifts/slot-assign', { method:'POST', body: JSON.stringify({ date:dateISO, lot, slotId, start, end, employeeId }) });
    const idx = shifts.findIndex(s=>s.date===dateISO && s.lot===lot && s.slotId===slotId);
    if(idx>=0) shifts[idx] = res.shift; else shifts.push(res.shift);
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
    editingShiftId = null;
  }catch(e){ loadError = e.message; }
  render();
}

function el(html){
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function render(){
  const app = document.getElementById('app');
  if(!loaded){ app.innerHTML = '<div class="loading">Loading shift board…</div>'; return; }

  let html = '';
  html += `<div class="masthead"><div class="mark">X</div><div class="titles"><div class="kicker">Xpress Parking Services</div><h1>Shift Board</h1></div></div>`;

  if(loadError){
    html += `<div class="err">${loadError}</div>`;
  }

  html += `<div class="tabs">
    <button class="tab ${role==='employee'?'active':''}" data-action="setrole" data-role="employee">I'm Staff</button>
    <button class="tab ${role==='schedule'?'active':''}" data-action="setrole" data-role="schedule">Schedule</button>
    <button class="tab ${role==='manager'?'active':''}" data-action="setrole" data-role="manager">Availability</button>
  </div>`;

  if(role==='employee'){
    html += renderEmployeeView();
  } else if(role==='schedule'){
    html += renderScheduleView();
  } else {
    html += renderManagerView();
  }

  html += `<div class="footnote">Anyone with this link can view schedules and availability for the whole team. Staff sign in with their own email and password to set their own availability — there's no further access control, so don't put anything here you wouldn't want a coworker to see.</div>`;

  app.innerHTML = html;
  bindEvents();
}

function renderEmployeeView(){
  let html = '';

  if(loginError){
    html += `<div class="err">${loginError}</div>`;
  }

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

  if(signupError){
    html += `<div class="err">${signupError}</div>`;
  }

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

  if(!currentEmployeeId){
    html += '<div class="card"><p class="empty">Log in or sign up above to see and set your availability.</p></div>';
    return html;
  }

  const emp = employees.find(e=>e.id===currentEmployeeId);
  if(!emp){ currentEmployeeId=null; return renderEmployeeView(); }

  if(!emp.onboarded){
    const onboardDates = getWeekDates(0);
    const empAvailOnboard = availability[emp.id] || {};
    const allSet = onboardDates.every(d=> !!empAvailOnboard[toISO(d)]);

    html += `<div class="card">
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
    </div>`;
    return html;
  }

  html += `<div class="card" style="background:var(--go-bg);border-color:var(--go);">
    <div class="row" style="justify-content:space-between;">
      <span style="font-weight:800;color:var(--go);">Logged in as ${emp.name}</span>
      <button class="ghost" data-action="logout">Log out</button>
    </div>
  </div>`;

  if(signupError){
    html += `<div class="err">${signupError}</div>`;
  }
  if(swapError){
    html += `<div class="err">${swapError}</div>`;
  }

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

  // live summary list
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

  return html;
}

function renderScheduleView(){
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

  html += `<div class="card" style="padding:12px 8px;">
    <h2 style="padding:0 8px;">This Week's Schedule</h2>
    <p class="empty" style="padding:0 8px 6px;">Tony's + Dudley's fixed shifts, plus any events or church lots you add below — all sorted by start time, per day.</p>
  </div>`;

  html += renderDailyColumns(dates);

  if(addShiftError){
    html += `<div class="err">${addShiftError}</div>`;
  }

  html += `<div class="card">
    <h2>Add a shift</h2>
    <label>Shift name (optional)</label>
    <input type="text" id="newShiftName" placeholder="e.g. UK Game Day Valet" />

    <label style="margin-top:10px;">Location</label>
    <select id="newShiftLocation">
      ${Object.keys(DAILY_TEMPLATES).map(l=>`<option value="${l}">${l} (extra shift)</option>`).join('')}
      ${LOTS.map(l=>`<option value="${l}">${l}</option>`).join('')}
      <option value="Private Event">Private Event</option>
      <option value="__CUSTOM__">Custom…</option>
    </select>
    <div id="newShiftCustomWrap" style="display:none;margin-top:8px;">
      <input type="text" id="newShiftCustomLocation" placeholder="Type the location name" />
    </div>

    <label style="margin-top:10px;">Date</label>
    <select id="newShiftDate">
      ${dates.map(d=>`<option value="${toISO(d)}">${fmtDayName(d)}, ${fmtDayShort(d)}</option>`).join('')}
    </select>

    <label style="margin-top:10px;">Time</label>
    <div class="trow" style="display:flex;gap:8px;">
      <input type="time" id="newShiftStart" value="09:00" />
      <input type="time" id="newShiftEnd" value="17:00" />
    </div>

    <label style="margin-top:10px;">Assign to (optional)</label>
    <select id="newShiftAssign">${slotOptionsHtml(toISO(dates[0]), '')}</select>

    <button class="primary" style="width:100%;margin-top:12px;" data-action="addcustomshift">Add shift</button>
  </div>`;

  const draftCount = weekIso.reduce((n,iso)=> n + shifts.filter(s=>s.date===iso && s.draft).length, 0);
  html += `<div class="card">
    <div class="row" style="justify-content:space-between;">
      <span class="empty" style="padding:0;">${draftCount>0 ? draftCount+' shift'+(draftCount===1?'':'s')+" not published yet — your team can't see "+(draftCount===1?'it':'them')+'.' : 'This week is fully published.'}</span>
    </div>
    <button class="primary" style="width:100%;margin-top:10px;" data-action="publishweek" ${draftCount===0?'disabled':''}>Publish week</button>
  </div>`;

  if(editingShiftId){
    const found = findShift(editingShiftId);
    if(found){
      const d = new Date(found.dateISO+'T00:00:00');
      html += `<div class="card">
        <h2>Edit shift</h2>
        <p class="empty" style="padding:0 0 10px;">${found.shift.lot} · ${fmtDayName(d)}, ${fmtDayShort(d)}</p>
        <div class="shiftedit" style="padding:0;border:none;">
          <label>Shift name</label>
          <input type="text" value="${found.shift.customName||''}" placeholder="Optional" data-action="shifttime" data-field="customName" data-shiftid="${found.shift.id}" />
          <label style="margin-top:10px;">Time</label>
          <div class="trow">
            <input type="time" value="${found.shift.start}" data-action="shifttime" data-field="start" data-shiftid="${found.shift.id}" />
            <input type="time" value="${found.shift.end}" data-action="shifttime" data-field="end" data-shiftid="${found.shift.id}" />
          </div>
          <div class="actions">
            <button class="ghost" data-action="closeedit">Done</button>
            <button class="danger" data-action="deleteshift" data-shiftid="${found.shift.id}">Remove shift</button>
          </div>
        </div>
      </div>`;
    } else {
      editingShiftId = null;
    }
  }

  return html;
}

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

function renderDailyColumns(dates){
  const locationClass = { "Tony's":"tonys", "Dudley's":"dudleys" };

  const columns = dates.map(d=>{
    const iso = toISO(d);
    const rows = [];
    Object.keys(DAILY_TEMPLATES).forEach(location=>{
      DAILY_TEMPLATES[location].forEach(slot=>{
        if(!slotApplies(slot, d)) return;
        rows.push({type:'template', location, slot, start:slot.start});
      });
    });
    shifts.filter(s=>s.date===iso && !s.slotId).forEach(s=>{
      rows.push({type:'custom', location:s.lot, shift:s, start:s.start});
    });
    rows.sort((a,b)=> a.start.localeCompare(b.start));

    const rowsHtml = rows.map(row=>{
      if(row.type==='template'){
        const { location, slot } = row;
        const s = shifts.find(x=>x.date===iso && x.lot===location && x.slotId===slot.id);
        const assignedId = s ? (getShiftEmployeeIds(s)[0] || '') : '';
        return `<div class="slotrow ${locationClass[location]||''}">
          <div class="slabel">${location} — ${slot.label}</div>
          <div class="stime3">${fmt12(slot.start)}–${fmt12(slot.end)}</div>
          <select class="slotselect ${s&&s.draft?'draft':''}" data-action="slotassign" data-date="${iso}" data-lot="${location}" data-slotid="${slot.id}" data-start="${slot.start}" data-end="${slot.end}">
            ${slotOptionsHtml(iso, assignedId)}
          </select>
        </div>`;
      } else {
        const s = row.shift;
        const ids = getShiftEmployeeIds(s);
        const chipsInline = ids.map(id=>{
          const e = employees.find(x=>x.id===id);
          return `<span class="achip achip-sm">${e?e.name:'(removed)'} <button type="button" data-action="removeassignee" data-shiftid="${s.id}" data-empid="${id}">×</button></span>`;
        }).join('');
        return `<div class="slotrow ${locationClass[row.location]||''}">
          <div class="slabel" data-action="editshift" data-shiftid="${s.id}" style="cursor:pointer;">${row.location}${s.customName? ' — '+s.customName : ' — Extra shift'}</div>
          <div class="stime3">${fmt12(s.start)}–${fmt12(s.end)}${s.draft?' · Draft':''}</div>
          ${chipsInline ? `<div class="assignedchips" style="margin-bottom:6px;">${chipsInline}</div>` : ''}
          <select class="slotselect" data-action="addassignee" data-shiftid="${s.id}">
            ${addAssigneeOptionsHtml(iso, ids)}
          </select>
        </div>`;
      }
    }).join('');

    return `<div class="daycolumn">
      <div class="daycolumn-head">${d.toLocaleDateString('en-US',{weekday:'short'})}<span class="sub">${fmtDayShort(d)}</span></div>
      <div class="daycolumn-body">${rowsHtml || '<p class="empty" style="padding:4px 0;">Nothing scheduled here</p>'}</div>
    </div>`;
  }).join('');

  return `<div class="dailycolumns">${columns}</div>`;
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
    html += emps.map(emp=>`
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
        </div>
        <div class="staffcard-status">${emp.onboarded ? 'Signed up' : 'Not signed up yet'}</div>
      </div>
    `).join('');
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

  const roleBtns = app.querySelectorAll('[data-action="setrole"]');
  roleBtns.forEach(b=> b.onclick = ()=>{ role = b.dataset.role; openDayKey=null; render(); });

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

  const lotSelect = app.querySelector('#lotSelect');
  if(lotSelect) lotSelect.onchange = ()=>{ managerLot = lotSelect.value; openDayKey=null; render(); };

  app.querySelectorAll('[data-action="importroster"]').forEach(b=> b.onclick = ()=> importRoster());

  app.querySelectorAll('[data-action="publishweek"]').forEach(b=> b.onclick = ()=> publishWeek());
  app.querySelectorAll('[data-action="slotassign"]').forEach(sel=> sel.onchange = ()=>{
    const { date, lot, slotid, start, end } = sel.dataset;
    if(sel.value){
      assignSlot(date, lot, slotid, start, end, sel.value);
    } else {
      clearSlot(date, lot, slotid);
    }
  });

  const newShiftLocation = app.querySelector('#newShiftLocation');
  if(newShiftLocation) newShiftLocation.onchange = ()=>{
    const wrap = app.querySelector('#newShiftCustomWrap');
    if(wrap) wrap.style.display = newShiftLocation.value === '__CUSTOM__' ? 'block' : 'none';
  };
  const newShiftDate = app.querySelector('#newShiftDate');
  if(newShiftDate) newShiftDate.onchange = ()=>{
    const assignSelect = app.querySelector('#newShiftAssign');
    if(assignSelect) assignSelect.innerHTML = slotOptionsHtml(newShiftDate.value, '');
  };
  app.querySelectorAll('[data-action="addcustomshift"]').forEach(b=> b.onclick = ()=> submitCustomShift());

  app.querySelectorAll('[data-action="editshift"]').forEach(b=> b.onclick = ()=>{
    editingShiftId = (editingShiftId===b.dataset.shiftid) ? null : b.dataset.shiftid;
    render();
  });
  app.querySelectorAll('[data-action="closeedit"]').forEach(b=> b.onclick = ()=>{ editingShiftId = null; render(); });
  app.querySelectorAll('[data-action="deleteshift"]').forEach(b=> b.onclick = ()=>{
    deleteShift(b.dataset.shiftid);
  });
  app.querySelectorAll('[data-action="shifttime"]').forEach(inp=> inp.onchange = ()=>{
    let val = inp.value;
    if(inp.dataset.field==='customName' && val.trim()==='') val = null;
    updateShift(inp.dataset.shiftid, inp.dataset.field, val);
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
    render();
  });

  app.querySelectorAll('[data-action="toggleday"]').forEach(b=> b.onclick = ()=>{
    const emp = employees.find(e=>e.id===currentEmployeeId);
    if(!emp) return;
    const date = b.dataset.date;
    const current = (availability[emp.id] && availability[emp.id][date]) || null;
    setDayState(emp.id, date, cycleState(current));
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
