// Black-box tests for server.js: each suite copies server.js into a temp dir
// next to a small public/ folder (like the Docker image's /app), starts it as
// a child process on a free port with its own DATA_FILE, and talks HTTP.
// Run: node --test test/
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

async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "go-home-time-test-"));
  await fs.copyFile(SERVER_JS, path.join(dir, "server.js"));
  await fs.mkdir(path.join(dir, "public"));
  await fs.writeFile(path.join(dir, "public", "index.html"), "<!doctype html><title>index</title>");
  // A sibling whose name starts with "public": must never be reachable.
  await fs.mkdir(path.join(dir, "public-secret"));
  await fs.writeFile(path.join(dir, "public-secret", "secret.txt"), "TOP SECRET");

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "server.js")], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_FILE: path.join(dir, "data", "people.json") },
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
});
