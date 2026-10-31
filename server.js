const http = require("node:http");
const { createReadStream, promises: fs } = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 80);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = process.env.DATA_FILE || "/data/people.json";
const DATA_VERSION = 2;
const LOCAL_TIME_ZONE = "Asia/Ho_Chi_Minh";
const MAX_BODY_BYTES = 16 * 1024;
const WORK_SPAN_MINUTES = 9 * 60 + 15;
const CHECK_IN_START = 8 * 60 + 30;
const CHECK_IN_END = 9 * 60 + 30;
const NOON_START = 12 * 60 + 30;
const NOON_END = 13 * 60 + 45;
const FLEX_DAY_END = 18 * 60 + 45;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatTime(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function effectiveArrival(minutes) {
  return Math.min(Math.max(minutes, CHECK_IN_START), CHECK_IN_END);
}

function rangesOverlap(start, end, rangeStart, rangeEnd) {
  return start < rangeEnd && end > rangeStart;
}

function validateLeaveRanges(value) {
  if (value === undefined || value === null) return { ranges: [], errors: [] };
  if (!Array.isArray(value)) return { ranges: [], errors: ["Leave ranges must be a list."] };

  const errors = [];
  const ranges = [];

  value.forEach((range, index) => {
    const label = `Leave range ${index + 1}`;
    const startValue = String(range?.start || "").trim();
    const endValue = String(range?.end || "").trim();

    if (!startValue && !endValue) return;
    if (!startValue || !endValue) {
      errors.push(`${label} needs both start and end times.`);
      return;
    }

    const start = parseTime(startValue);
    const end = parseTime(endValue);
    if (start === null || end === null) {
      errors.push(`${label} must use HH:MM times.`);
      return;
    }
    if (end <= start) {
      errors.push(`${label} must end after it starts.`);
      return;
    }
    if (start < CHECK_IN_START || end > FLEX_DAY_END) {
      errors.push(`${label} must stay between 08:30 and 18:45.`);
      return;
    }
    if (rangesOverlap(start, end, NOON_START, NOON_END)) {
      errors.push(`${label} cannot overlap noon break 12:30 to 13:45.`);
      return;
    }

    ranges.push({ start: startValue, end: endValue, startMinutes: start, endMinutes: end });
  });

  const sortedRanges = [...ranges].sort((a, b) => a.startMinutes - b.startMinutes);
  for (let index = 1; index < sortedRanges.length; index += 1) {
    if (sortedRanges[index].startMinutes < sortedRanges[index - 1].endMinutes) {
      errors.push("Leave ranges cannot overlap.");
      break;
    }
  }

  return {
    ranges: sortedRanges.map((range) => ({ start: range.start, end: range.end })),
    errors,
  };
}

function calculateSchedule(arrival, leaveRanges = []) {
  const minutes = parseTime(arrival);
  if (minutes === null) return null;

  const effectiveStart = effectiveArrival(minutes);
  const normalLeaveMinutes = effectiveStart + WORK_SPAN_MINUTES;
  const validRanges = validateLeaveRanges(leaveRanges).ranges;
  const leaveDeductionMinutes = validRanges.reduce((total, range) => {
    const start = parseTime(range.start);
    const end = parseTime(range.end);
    const clippedStart = Math.max(start, effectiveStart);
    const clippedEnd = Math.min(end, normalLeaveMinutes);
    return total + Math.max(0, clippedEnd - clippedStart);
  }, 0);

  return {
    effectiveArrival: formatTime(effectiveStart),
    normalLeave: formatTime(normalLeaveMinutes),
    leave: formatTime(normalLeaveMinutes - leaveDeductionMinutes),
    leaveDeductionMinutes,
    leaveRanges: validRanges,
  };
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function keyForName(name) {
  return name.toLocaleLowerCase("en-US");
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(safeDate).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function createStore(people = []) {
  return {
    version: DATA_VERSION,
    timeZone: LOCAL_TIME_ZONE,
    people,
  };
}

function updateTimestamp(person, value) {
  const nextDate = new Date(value);
  if (Number.isNaN(nextDate.getTime())) return;

  const currentDate = new Date(person.updatedAt || 0);
  if (!person.updatedAt || Number.isNaN(currentDate.getTime()) || nextDate > currentDate) {
    person.updatedAt = nextDate.toISOString();
  }
}

function normalizedRecord(record) {
  const arrival = String(record?.arrival || "");
  if (parseTime(arrival) === null) return null;

  const updatedAt = new Date(record?.updatedAt || Date.now());
  return {
    arrival,
    leaveRanges: validateLeaveRanges(record?.leaveRanges).ranges,
    updatedAt: Number.isNaN(updatedAt.getTime()) ? new Date().toISOString() : updatedAt.toISOString(),
  };
}

function personForMap(peopleByKey, name, updatedAt = new Date().toISOString()) {
  const cleanName = normalizeName(name);
  if (!cleanName) return null;

  const key = keyForName(cleanName);
  if (!peopleByKey.has(key)) {
    peopleByKey.set(key, {
      name: cleanName,
      createdAt: updatedAt,
      updatedAt,
      records: {},
    });
  }

  return peopleByKey.get(key);
}

function normalizeStore(raw) {
  const peopleByKey = new Map();
  let migrated = !raw || raw.version !== DATA_VERSION || !Array.isArray(raw.people);
  const rawPeople = Array.isArray(raw) ? raw : Array.isArray(raw?.people) ? raw.people : [];

  rawPeople.forEach((rawPerson) => {
    const name = normalizeName(rawPerson?.name);
    if (!name) return;

    const fallbackUpdatedAt = new Date(rawPerson?.updatedAt || Date.now());
    const safeUpdatedAt = Number.isNaN(fallbackUpdatedAt.getTime())
      ? new Date().toISOString()
      : fallbackUpdatedAt.toISOString();
    const person = personForMap(peopleByKey, name, safeUpdatedAt);
    if (!person) return;

    if (rawPerson?.records && typeof rawPerson.records === "object") {
      Object.entries(rawPerson.records).forEach(([dateKey, record]) => {
        const cleanRecord = normalizedRecord(record);
        if (!isDateKey(dateKey) || !cleanRecord) return;
        person.records[dateKey] = cleanRecord;
        updateTimestamp(person, cleanRecord.updatedAt);
      });
      return;
    }

    const flatRecord = normalizedRecord(rawPerson);
    if (!flatRecord) return;

    migrated = true;
    const dateKey = localDateKey(flatRecord.updatedAt);
    person.records[dateKey] = flatRecord;
    updateTimestamp(person, flatRecord.updatedAt);
  });

  return { store: createStore([...peopleByKey.values()]), migrated };
}

async function readStore() {
  // Atomic writes (writeStore) mean a reader never sees a half-written file, but
  // keep one retry as a cheap guard against any transient read/parse hiccup.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await fs.readFile(DATA_FILE, "utf8");
      return normalizeStore(JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") return { store: createStore(), migrated: false };
      if (attempt === 0) continue;
      throw error;
    }
  }
}

function orderedStore(store) {
  return createStore([...store.people]
    .map((person) => ({
      ...person,
      records: Object.fromEntries(Object.entries(person.records || {}).sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));
}

let tmpCounter = 0;

async function writeStore(store) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const data = `${JSON.stringify(orderedStore(store), null, 2)}\n`;
  // Write to a temp file in the same directory, then rename. rename(2) is atomic
  // on a single filesystem, so concurrent readers always see a whole file (the old
  // one or the new one) and never a truncated mid-write JSON document.
  const tmpFile = `${DATA_FILE}.tmp-${process.pid}-${tmpCounter++}`;
  try {
    await fs.writeFile(tmpFile, data);
    await fs.rename(tmpFile, DATA_FILE);
  } catch (error) {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    throw error;
  }
}

// Serialize read-modify-write store mutations so two simultaneous saves can't
// clobber each other (lost update). Reads don't need this thanks to atomic writes.
let storeMutation = Promise.resolve();

function withStoreLock(task) {
  const result = storeMutation.then(task, task);
  storeMutation = result.then(() => undefined, () => undefined);
  return result;
}

function publicDailyRecord(date, record) {
  const schedule = calculateSchedule(record.arrival, record.leaveRanges);
  return {
    date,
    arrival: record.arrival,
    normalLeave: schedule.normalLeave,
    leave: schedule.leave,
    adjustedLeave: schedule.leave,
    leaveDeductionMinutes: schedule.leaveDeductionMinutes,
    leaveRanges: schedule.leaveRanges,
    updatedAt: record.updatedAt,
  };
}

function publicPerson(person, todayKey) {
  const todayRecord = person.records?.[todayKey] || null;
  const today = todayRecord ? publicDailyRecord(todayKey, todayRecord) : null;
  const history = Object.entries(person.records || {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .map(([date, record]) => publicDailyRecord(date, record));

  return {
    name: person.name,
    today: todayKey,
    hasToday: Boolean(today),
    arrival: today?.arrival || null,
    normalLeave: today?.normalLeave || null,
    leave: today?.leave || null,
    adjustedLeave: today?.leave || null,
    leaveDeductionMinutes: today?.leaveDeductionMinutes || 0,
    leaveRanges: today?.leaveRanges || [],
    updatedAt: today?.updatedAt || person.updatedAt,
    lastRecord: history[0] || null,
    history,
  };
}

function publicPeople(store, todayKey) {
  return store.people
    .map((person) => publicPerson(person, todayKey))
    .sort((a, b) => {
      if (a.hasToday !== b.hasToday) return a.hasToday ? -1 : 1;
      if (a.hasToday && b.hasToday) {
        const leaveDiff = parseTime(a.leave) - parseTime(b.leave);
        if (leaveDiff !== 0) return leaveDiff;
      }
      return a.name.localeCompare(b.name);
    });
}

function dashboardPerson(person) {
  const records = Object.entries(person.records || {})
    .filter(([date]) => isDateKey(date))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, record]) => {
      const schedule = calculateSchedule(record.arrival, record.leaveRanges);
      return {
        date,
        arrival: record.arrival,
        arrivalMinutes: parseTime(record.arrival),
        leave: schedule ? schedule.leave : null,
        leaveDeductionMinutes: schedule ? schedule.leaveDeductionMinutes : 0,
      };
    });

  const minutes = records.map((record) => record.arrivalMinutes).filter((value) => value !== null);
  const days = minutes.length;
  const total = minutes.reduce((sum, value) => sum + value, 0);
  const average = days ? Math.round(total / days) : null;
  const earliest = days ? Math.min(...minutes) : null;
  const latest = days ? Math.max(...minutes) : null;
  const onTimeCount = minutes.filter((value) => value <= CHECK_IN_END).length;

  return {
    name: person.name,
    records,
    stats: {
      days,
      avgArrivalMinutes: average,
      avgArrival: average === null ? null : formatTime(average),
      earliestMinutes: earliest,
      earliest: earliest === null ? null : formatTime(earliest),
      latestMinutes: latest,
      latest: latest === null ? null : formatTime(latest),
      onTimeCount,
      onTimeRate: days ? onTimeCount / days : null,
      lastDate: records.length ? records[records.length - 1].date : null,
    },
  };
}

function findPerson(store, name) {
  const key = keyForName(name);
  return store.people.find((person) => keyForName(person.name) === key);
}

function upsertPerson(store, name, updatedAt) {
  const existing = findPerson(store, name);
  if (existing) return existing;

  const person = {
    name,
    createdAt: updatedAt,
    updatedAt,
    records: {},
  };
  store.people.push(person);
  return person;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJsonBody(request) {
  // Collect raw bytes and decode once: `body += chunk` decoded each chunk on its
  // own, so a Vietnamese letter split across two TCP chunks was stored as U+FFFD junk.
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large."), { status: 413 });
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
  // `null`, numbers, strings and arrays are valid JSON but not a request; `null`
  // used to crash on body.name (500).
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("JSON body must be an object."), { status: 400 });
  }
  return body;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// decodeURIComponent throws URIError on a stray "%"; that is the client's fault (400).
function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, "Malformed URL.");
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/people") {
    const { store, migrated } = await readStore();
    if (migrated) await withStoreLock(() => writeStore(store));

    const today = localDateKey();
    sendJson(response, 200, { today, timeZone: LOCAL_TIME_ZONE, people: publicPeople(store, today) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/stats") {
    const { store, migrated } = await readStore();
    if (migrated) await withStoreLock(() => writeStore(store));

    const today = localDateKey();
    const people = store.people.map(dashboardPerson);
    const dates = [...new Set(people.flatMap((person) => person.records.map((record) => record.date)))].sort();
    sendJson(response, 200, { today, timeZone: LOCAL_TIME_ZONE, dates, people });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/people") {
    const body = await readJsonBody(request);
    const name = normalizeName(body.name);
    const arrival = String(body.arrival || "");

    if (!name) {
      sendError(response, 400, "Name is required.");
      return;
    }
    if (parseTime(arrival) === null) {
      sendError(response, 400, "Come in time must use HH:MM.");
      return;
    }
    const leaveRangesResult = validateLeaveRanges(body.leaveRanges);
    if (leaveRangesResult.errors.length) {
      sendError(response, 400, leaveRangesResult.errors[0]);
      return;
    }

    const payload = await withStoreLock(async () => {
      const { store } = await readStore();
      const updatedAt = new Date().toISOString();
      const today = localDateKey(updatedAt);
      const person = upsertPerson(store, name, updatedAt);
      person.name = name;
      person.updatedAt = updatedAt;
      person.records[today] = {
        arrival,
        leaveRanges: leaveRangesResult.ranges,
        updatedAt,
      };

      await writeStore(store);
      return {
        today,
        timeZone: LOCAL_TIME_ZONE,
        person: publicPerson(person, today),
        people: publicPeople(store, today),
      };
    });
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/people/")) {
    const name = normalizeName(decodePathPart(url.pathname.slice("/api/people/".length)));
    const payload = await withStoreLock(async () => {
      const { store } = await readStore();
      store.people = store.people.filter((person) => keyForName(person.name) !== keyForName(name));
      await writeStore(store);

      const today = localDateKey();
      return { today, timeZone: LOCAL_TIME_ZONE, people: publicPeople(store, today) };
    });
    sendJson(response, 200, payload);
    return;
  }

  sendError(response, 404, "Not found.");
}

async function serveStatic(request, response, url) {
  const decodedPath = decodePathPart(url.pathname);
  const requestPath = decodedPath === "/"
    ? "/index.html"
    : decodedPath === "/dashboard"
      ? "/dashboard.html"
      : decodedPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));

  // Compare against "public/" (with the separator): a bare prefix check also
  // matched siblings such as /app/public-old via "/..%2Fpublic-old%2F...".
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });

    const extension = path.extname(filePath);
    // Send headers only once the file is open, and handle stream errors: an
    // unhandled 'error' event (file unreadable or removed after stat) used to
    // crash the whole process.
    const stream = createReadStream(filePath);
    stream.once("open", () => {
      response.writeHead(200, {
        "Content-Type": contentTypes[extension] || "application/octet-stream",
        "Cache-Control": extension === ".html" ? "no-store" : "no-cache",
        "Referrer-Policy": "no-referrer-when-downgrade",
        "X-Content-Type-Options": "nosniff",
      });
      stream.pipe(response);
    });
    stream.on("error", (error) => {
      if (response.headersSent) {
        response.destroy();
      } else if (error.code === "ENOENT") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
      } else {
        console.error(`Static file error for ${requestPath}:`, error.code || error.message);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Server error");
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error.status) {
      sendError(response, error.status, error.message);
      return;
    }
    // Unexpected: log it, but don't hand internal error text to the client.
    console.error("Request failed:", error);
    sendError(response, 500, "Server error.");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Go Home Time listening on ${PORT}`);
});
