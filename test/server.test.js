// Black-box tests for server.js: each suite copies server.js into a temp dir
// next to a small public/ folder (like the Docker image's /app), starts it as
// a child process on a free port with its own DATA_FILE, and talks HTTP.
// Run: node --test test/*.test.js   (on Node 25, `node --test test/` fails: "Cannot find module")
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");

const SERVER_JS = path.join(__dirname, "..", "server.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// options.dataFile: share a data file across restarts (default: inside dir).
// options.env: extra environment, e.g. GO_HOME_TIME_TEST_NOW to fix the clock.
async function startServer(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "go-home-time-test-"));
  await fs.copyFile(SERVER_JS, path.join(dir, "server.js"));
  await fs.mkdir(path.join(dir, "public"));
  await fs.writeFile(path.join(dir, "public", "index.html"), "<!doctype html><title>index</title>");
  // A sibling whose name starts with "public": must never be reachable.
  await fs.mkdir(path.join(dir, "public-secret"));
  await fs.writeFile(path.join(dir, "public-secret", "secret.txt"), "TOP SECRET");

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "server.js")], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATA_FILE: options.dataFile || path.join(dir, "data", "people.json"),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  for (let i = 0; i < 100; i += 1) {
    if (output.includes("listening")) break;
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    await new Promise((r) => setTimeout(r, 30));
  }
  return {
    dir,
    port,
    child,
    exited,
    output: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

// Raw request so the path is sent exactly as written (no client-side normalising),
// and the body can be sent in several writes.
function request(port, method, rawPath, bodyParts = [], gapMs = 0) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: rawPath, headers: bodyParts.length ? { "Content-Type": "application/json" } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    (async () => {
      for (const part of bodyParts) {
        req.write(part);
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
      req.end();
    })();
  });
}

const postJson = (port, body) => request(port, "POST", "/api/people", [typeof body === "string" ? body : JSON.stringify(body)]);

describe("go-home calculation and board", () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test("health check", async () => {
    const res = await request(s.port, "GET", "/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });

  test("go-home = come-in clamped to 08:30–09:30, plus 9h15m", async () => {
    for (const [arrival, leave] of [["08:00", "17:45"], ["08:30", "17:45"], ["09:00", "18:15"], ["09:30", "18:45"], ["10:15", "18:45"]]) {
      const res = await postJson(s.port, { name: "Calc", arrival });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.person.leave, leave, arrival);
    }
  });

  test("rejects bad input with 400, not 500", async () => {
    assert.equal((await postJson(s.port, { name: "A", arrival: "25:00" })).status, 400);
    assert.equal((await postJson(s.port, { arrival: "09:00" })).status, 400);
    assert.equal((await postJson(s.port, "{\"name\":")).status, 400);
    for (const body of ["null", "42", "\"text\"", "[]", "true"]) {
      const res = await postJson(s.port, body);
      assert.equal(res.status, 400, `body ${body}: ${res.text}`);
    }
  });

  test("a Vietnamese name survives a body split mid-character", async () => {
    const body = Buffer.from(JSON.stringify({ name: "Nguyễn Ánh", arrival: "09:00" }));
    const cut = body.indexOf(Buffer.from("ễ")) + 1; // inside the 3-byte "ễ"
    const res = await request(s.port, "POST", "/api/people", [body.subarray(0, cut), body.subarray(cut)], 50);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.person.name, "Nguyễn Ánh");
  });

  test("oversized body is refused with 413", async () => {
    const res = await postJson(s.port, { name: "x".repeat(20000), arrival: "09:00" });
    assert.equal(res.status, 413);
  });

  test("delete removes a person", async () => {
    await postJson(s.port, { name: "Gone Soon", arrival: "09:00" });
    const res = await request(s.port, "DELETE", `/api/people/${encodeURIComponent("Gone Soon")}`);
    assert.equal(res.status, 200);
    assert.ok(!res.json.people.some((p) => p.name === "Gone Soon"));
    assert.equal(res.json.deleted.name, "Gone Soon");
  });
});

const restore = (port, name) => request(port, "POST", `/api/people/${encodeURIComponent(name)}/restore`);
const del = (port, name) => request(port, "DELETE", `/api/people/${encodeURIComponent(name)}`);
const readData = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

describe("soft delete and restore", () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test("delete then restore brings back the full history", async () => {
    const dataFile = path.join(s.dir, "data", "people.json");
    await postJson(s.port, { name: "Lan", arrival: "09:00" });
    // Give Lan an older day too, written straight into the file.
    const data = await readData(dataFile);
    const lan = data.people.find((p) => p.name === "Lan");
    lan.records["2026-01-02"] = { arrival: "08:45", leaveRanges: [], updatedAt: "2026-01-02T01:45:00.000Z" };
    await fs.writeFile(dataFile, JSON.stringify(data));
    const before = (await request(s.port, "GET", "/api/people")).json.people.find((p) => p.name === "Lan");
    assert.equal(before.history.length, 2);

    const gone = await del(s.port, "lan");
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.deleted.name, "Lan");
    assert.ok(gone.json.deleted.deletedAt);

    const res = await restore(s.port, "LAN");
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.person.name, "Lan");
    assert.deepEqual(res.json.person.history, before.history);
    assert.ok(res.json.people.some((p) => p.name === "Lan"));
    assert.equal((await readData(dataFile)).deleted.length, 0);
  });

  test("GET /api/people and /api/stats hide deleted people", async () => {
    await postJson(s.port, { name: "Hidden", arrival: "09:00" });
    await del(s.port, "Hidden");
    const people = (await request(s.port, "GET", "/api/people")).json.people;
    assert.ok(!people.some((p) => p.name === "Hidden"));
    const stats = (await request(s.port, "GET", "/api/stats")).json.people;
    assert.ok(!stats.some((p) => p.name === "Hidden"));
    const data = await readData(path.join(s.dir, "data", "people.json"));
    assert.ok(data.deleted.some((p) => p.name === "Hidden" && p.deletedAt));
  });

  test("restore is 404 for a name not in recently deleted", async () => {
    assert.equal((await restore(s.port, "Never Existed")).status, 404);
    await postJson(s.port, { name: "Still Here", arrival: "09:00" });
    assert.equal((await restore(s.port, "Still Here")).status, 404);
    assert.equal((await request(s.port, "POST", "/api/people/%E0%A4%A/restore")).status, 400);
  });

  test("restore is 409 when the name was re-added meanwhile, and the entry stays", async () => {
    await postJson(s.port, { name: "Minh", arrival: "09:00" });
    await del(s.port, "Minh");
    await postJson(s.port, { name: "minh", arrival: "09:15" });
    const res = await restore(s.port, "Minh");
    assert.equal(res.status, 409, res.text);
    const data = await readData(path.join(s.dir, "data", "people.json"));
    assert.ok(data.deleted.some((p) => p.name === "Minh"));
  });
});

describe("recently deleted purge after 7 days", () => {
  let dataDir;
  before(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "go-home-time-data-")); });
  after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

  async function at(iso, task) {
    const s = await startServer({ dataFile: path.join(dataDir, "people.json"), env: { GO_HOME_TIME_TEST_NOW: iso } });
    try { await task(s); } finally { await s.stop(); }
  }

  test("kept for 7 days, purged on the next write after that", async () => {
    await at("2026-03-01T02:00:00.000Z", async (s) => {
      await postJson(s.port, { name: "Old One", arrival: "09:00" });
      await postJson(s.port, { name: "Older One", arrival: "09:00" });
      assert.equal((await del(s.port, "Old One")).json.deleted.deletedAt, "2026-03-01T02:00:00.000Z");
      await del(s.port, "Older One");
    });
    // Day 6: still restorable.
    await at("2026-03-07T02:00:00.000Z", async (s) => {
      assert.equal((await restore(s.port, "Old One")).status, 200);
    });
    // Day 8: a read does not purge, the next write does.
    await at("2026-03-09T02:00:00.000Z", async (s) => {
      await request(s.port, "GET", "/api/people");
      assert.equal((await readData(path.join(dataDir, "people.json"))).deleted.length, 1);
      await postJson(s.port, { name: "Someone", arrival: "09:00" });
      assert.equal((await readData(path.join(dataDir, "people.json"))).deleted.length, 0);
      assert.equal((await restore(s.port, "Older One")).status, 404);
    });
  });
});

describe("data files written before soft delete", () => {
  let s;
  const oldFile = {
    version: 2,
    timeZone: "Asia/Ho_Chi_Minh",
    people: [
      {
        name: "Veteran",
        createdAt: "2026-01-05T01:00:00.000Z",
        updatedAt: "2026-01-06T01:00:00.000Z",
        records: {
          "2026-01-05": { arrival: "08:50", leaveRanges: [], updatedAt: "2026-01-05T01:00:00.000Z" },
          "2026-01-06": { arrival: "09:10", leaveRanges: [], updatedAt: "2026-01-06T01:00:00.000Z" },
        },
      },
    ],
  };
  before(async () => {
    s = await startServer();
    await fs.mkdir(path.join(s.dir, "data"), { recursive: true });
    await fs.writeFile(path.join(s.dir, "data", "people.json"), `${JSON.stringify(oldFile, null, 2)}\n`);
  });
  after(async () => { await s.stop(); });

  test("load unchanged (no \`deleted\` key), and delete/restore works on them", async () => {
    const dataFile = path.join(s.dir, "data", "people.json");
    const original = await fs.readFile(dataFile, "utf8");
    const res = await request(s.port, "GET", "/api/people");
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.people.map((p) => [p.name, p.history.length]), [["Veteran", 2]]);
    assert.equal((await request(s.port, "GET", "/api/stats")).json.people[0].stats.days, 2);
    assert.equal(await fs.readFile(dataFile, "utf8"), original, "a GET must not rewrite the file");

    assert.equal((await del(s.port, "Veteran")).status, 200);
    const restored = await restore(s.port, "Veteran");
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.person.history.length, 2);
  });
});

describe("static files and URL handling", () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test("serves public files", async () => {
    const res = await request(s.port, "GET", "/");
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>index<\/title>/);
  });

  test("encoded ../ cannot reach files outside public/", async () => {
    assert.equal((await request(s.port, "GET", "/..%2Fserver.js")).status, 403);
  });

  test("encoded ../ cannot reach a sibling folder whose name starts with 'public'", async () => {
    const res = await request(s.port, "GET", "/..%2Fpublic-secret%2Fsecret.txt");
    assert.notEqual(res.text, "TOP SECRET");
    assert.equal(res.status, 403);
  });

  test("malformed percent-encoding is a 400, not a 500", async () => {
    assert.equal((await request(s.port, "GET", "/%E0%A4%A")).status, 400);
    assert.equal((await request(s.port, "DELETE", "/api/people/%E0%A4%A")).status, 400);
  });

  test("paths that can't name a file are 404 or 400, not 500", async () => {
    assert.equal((await request(s.port, "GET", "/index.html/x")).status, 404);
    assert.equal((await request(s.port, "GET", "/" + "a".repeat(300) + ".css")).status, 404);
    assert.equal((await request(s.port, "GET", "/index%00.html")).status, 400);
    assert.ok(s.alive(), `server died:\n${s.output()}`);
  });

  test("an unreadable file does not crash the server", { skip: process.getuid?.() === 0 && "root can read mode-000 files" }, async () => {
    const locked = path.join(s.dir, "public", "locked.css");
    await fs.writeFile(locked, "body{}");
    await fs.chmod(locked, 0o000);
    await request(s.port, "GET", "/locked.css").catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(s.alive(), `server died:\n${s.output()}`);
    assert.equal((await request(s.port, "GET", "/api/health")).status, 200);
  });
});

describe("board size limit", () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test("refuses new people past 100, still updates existing ones", async () => {
    for (let i = 0; i < 100; i += 1) {
      const res = await postJson(s.port, { name: `Person ${i}`, arrival: "09:00" });
      assert.equal(res.status, 200, `person ${i}: ${res.text}`);
    }
    const full = await postJson(s.port, { name: "One Too Many", arrival: "09:00" });
    assert.equal(full.status, 409, full.text);
    const update = await postJson(s.port, { name: "person 5", arrival: "08:45" });
    assert.equal(update.status, 200, update.text);
    const people = (await request(s.port, "GET", "/api/people")).json.people;
    assert.equal(people.length, 100);
  });

  test("recently deleted people don't count toward the cap; restore respects it", async () => {
    assert.equal((await del(s.port, "Person 0")).status, 200);
    const added = await postJson(s.port, { name: "Newcomer", arrival: "09:00" });
    assert.equal(added.status, 200, added.text);
    const res = await restore(s.port, "Person 0");
    assert.equal(res.status, 409, res.text);
    assert.match(res.json.error, /full/);
  });
});
