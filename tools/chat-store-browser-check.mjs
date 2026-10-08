// Isolated native IndexedDB checks; never opens the user's app origin or DB.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tools/chat-store-browser-check.mjs
// Optional: BROWSERS=chromium,firefox,webkit and <ENGINE>_EXECUTABLE overrides.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const source = await readFile(new URL("../chat-store.js", import.meta.url));
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/chat-store.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/chat-store.js"
      ? source
      : "<!doctype html><title>Isolated chat storage check</title>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const engine of (
    process.env.BROWSERS ?? "chromium,firefox,webkit"
  ).split(",")) {
    let browser;
    try {
      browser = await playwright[engine].launch({
        executablePath:
          process.env[`${engine.toUpperCase()}_EXECUTABLE`] || undefined,
      });
      const page = await browser.newPage();
      await page.goto(origin);
      const evidence = await page.evaluate(async () => {
        const { openChatStore } = await import("/chat-store.js");
        const check = (condition, label) => {
          if (!condition) throw new Error(label);
        };
        const checks = [];
        let store = await openChatStore();
        const raw = JSON.stringify({
          A: Array.from({ length: 10_000 }, (_, i) => ({
            me: i % 2 === 0,
            text: String(i),
            time: "12:34",
          })),
          B: [{ me: false, text: "별도 방" }],
          Broken: [null, { text: "화자 불명" }],
        });
        const start = performance.now();
        const report = await store.migrateLegacy(raw, { importedAt: 123 });
        check(
          report.imported === 10_001 && report.rejected === 2,
          "migration counts",
        );
        check(
          (await store.getMigration()).raw === raw,
          "raw snapshot retained",
        );
        check(
          JSON.stringify(await store.migrateLegacy(raw)) ===
            JSON.stringify(report),
          "idempotent migration",
        );
        checks.push("snapshot-bound migration/quarantine/idempotence");
        const queryStart = performance.now();
        const rows = await store.readMessages("A");
        const queryMs = performance.now() - queryStart;
        check(
          rows.length === 50 &&
            rows[0].seq === 9951 &&
            rows.at(-1).seq === 10_000,
          "recent page",
        );
        check(
          rows[0].createdAt === null && rows[0].sourceKind === "legacy-unknown",
          "unknown dates/source",
        );
        const previous = await store.readMessages("A", {
          before: 9951,
          limit: 3,
        });
        check(
          previous.map((row) => row.seq).join(",") === "9948,9949,9950",
          "previous page",
        );
        check(
          (await store.readMessages("AA")).length === 0,
          "unknown room isolation",
        );
        check(
          (await store.readMessages("B"))[0].text === "별도 방",
          "known room isolation",
        );
        checks.push("10000-message pagination/order/isolation");
        let rejected = false;
        try {
          await store.migrateLegacy("{}");
        } catch (error) {
          rejected = error.name === "ChatStorageConflict";
        }
        check(rejected, "different snapshot conflict");
        store.close();
        store = await openChatStore();
        check(
          (await store.readMessages("A")).length === 50,
          "reopen persistence",
        );
        checks.push("snapshot conflict/reopen persistence");
        const second = await openChatStore();
        const append = (db, id) =>
          db.appendMessage({
            roomId: "Concurrent",
            id,
            speakerType: "user",
            text: id,
            sourceKind: "user-input",
          });
        await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            append(i % 2 ? store : second, `new-${i}`),
          ),
        );
        const concurrent = await store.readMessages("Concurrent");
        check(
          concurrent.map((row) => row.seq).every((seq, i) => seq === i + 1),
          "concurrent sequence",
        );
        const before = await store.getRoom("Concurrent");
        rejected = false;
        try {
          await append(second, "new-0");
        } catch (error) {
          rejected = error.name === "ConstraintError";
        }
        check(rejected, "duplicate rejection");
        check(
          JSON.stringify(await store.getRoom("Concurrent")) ===
            JSON.stringify(before),
          "metadata rollback",
        );
        rejected = false;
        try {
          await store.appendMessage(
            {
              roomId: "Concurrent",
              id: "stale",
              text: "stale",
              speakerType: "user",
              sourceKind: "user-input",
            },
            { expectedRevision: 0 },
          );
        } catch (error) {
          rejected = error.name === "ChatStorageConflict";
        }
        check(rejected, "revision conflict");
        checks.push("concurrent writes/transaction rollback/stale revision");
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("molu-chat-memory", 2);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        });
        rejected = false;
        try {
          await second.listRooms();
        } catch {
          rejected = true;
        }
        check(rejected, "versionchange closes old connection");
        checks.push("native versionchange closes connections");
        const blocker = await new Promise((resolve) => {
          const request = indexedDB.open("blocked");
          request.onsuccess = () => resolve(request.result);
        });
        let notified = false;
        const upgraded = await openChatStore({
          name: "blocked",
          indexedDB: {
            open: (name, version) => indexedDB.open(name, version + 1),
          },
          onBlocked: () => {
            notified = true;
            blocker.close();
          },
        });
        check(notified, "blocked callback");
        upgraded.close();
        checks.push("blocked upgrade notification");
        return {
          checks,
          messageCount: report.imported,
          pageSize: rows.length,
          queryMs: Math.round(queryMs * 100) / 100,
          totalMs: Math.round(performance.now() - start),
        };
      });
      results.push({
        engine,
        version: browser.version(),
        passed: true,
        ...evidence,
      });
    } catch (error) {
      results.push({ engine, passed: false, error: error.message });
      // No automatic launch retry or silent browser substitution.
      break;
    } finally {
      await browser?.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
