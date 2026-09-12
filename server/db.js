const fs = require('fs');
const path = require('path');

// DATA_DIR can be overridden (e.g. to a mounted persistent disk path on a
// host like Render) so deployment doesn't depend on the project's own layout.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

function defaultData() {
  return {
    employees: [], availability: {}, weeklyAvailability: {}, availabilityChangeLog: [], shifts: [], weekLots: {}, swapRequests: [],
    admins: [], ptoRequests: [], positions: [], shiftTemplates: [], timeEntries: [], groups: [], payRates: [],
    qbCustomerOverrides: {}
  };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return Object.assign(defaultData(), JSON.parse(raw));
  } catch (e) {
    return defaultData();
  }
}

const data = load();
let writeChain = Promise.resolve();

// Writes are serialized so overlapping requests can't interleave and
// corrupt the file; each write always saves the latest in-memory state.
function persist() {
  ensureDir();
  writeChain = writeChain.then(() => {
    const snapshot = JSON.stringify(data, null, 2);
    return fs.promises.writeFile(DB_PATH, snapshot);
  }).catch(err => {
    console.error('Failed to persist data/db.json:', err);
  });
  return writeChain;
}

module.exports = { data, persist };
