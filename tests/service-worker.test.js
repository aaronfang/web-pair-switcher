const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workerPath = path.join(__dirname, "..", "service-worker.js");
const workerSource = fs.readFileSync(workerPath, "utf8");

function createWorkerContext() {
  const localData = {};
  const context = vm.createContext({
    setTimeout,
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener(listener) { context.runtimeMessageListener = listener; } },
        connectNative() {
          return {
            onMessage: { addListener() {} },
            onDisconnect: { addListener() {} },
            postMessage() {}
          };
        }
      },
      commands: { onCommand: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: {
        sync: { get: async () => ({}) },
        local: {
          get: async (key) => key ? { [key]: localData[key] } : { ...localData },
          set: async (values) => Object.assign(localData, values),
          remove: async (key) => { delete localData[key]; }
        }
      }
    }
  });
  vm.runInContext(workerSource, context, { filename: workerPath });
  return context;
}

function createSwitchHarness({ focusFailures = 0 } = {}) {
  const events = [];
  let focusedWindowId = 1;
  const tabs = [
    {
      id: 10,
      windowId: 1,
      active: true,
      lastAccessed: 200,
      url: "https://www.douyin.com/video/1"
    },
    {
      id: 20,
      windowId: 2,
      active: true,
      lastAccessed: 100,
      url: "https://www.bilibili.com/video/2"
    }
  ];
  const context = vm.createContext({
    console: { warn() {}, error() {} },
    setTimeout,
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener() {} },
        connectNative() {
          return {
            onMessage: { addListener() {} },
            onDisconnect: { addListener() {} },
            postMessage() {}
          };
        }
      },
      commands: { onCommand: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: {
        sync: { get: async () => ({}) },
        local: {
          get: async () => ({}),
          set: async () => {}
        }
      },
      windows: {
        getLastFocused: async () => ({ id: focusedWindowId }),
        update: async (windowId) => {
          events.push({ type: "focus", windowId });
          if (focusFailures > 0) {
            focusFailures -= 1;
          } else {
            focusedWindowId = windowId;
          }
        }
      },
      tabs: {
        query: async (query) => {
          if (query.url) {
            const pattern = Array.isArray(query.url) ? query.url[0] : query.url;
            const host = pattern.includes("douyin.com") ? "douyin.com" : "bilibili.com";
            return tabs.filter((tab) => tab.url.includes(host));
          }
          const active = tabs.filter((tab) => tab.active);
          return query.windowId
            ? active.filter((tab) => tab.windowId === query.windowId)
            : active;
        },
        update: async (tabId) => {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          tab.active = true;
          events.push({ type: "activate-tab", tabId });
        },
        get: async (tabId) => tabs.find((tab) => tab.id === tabId)
      },
      scripting: {
        executeScript: async ({ target, args }) => {
          const action = args[0];
          events.push({ type: action, tabId: target.tabId });
          return [{ result: { state: action === "play" ? "playing" : "paused" } }];
        }
      },
      action: {
        setBadgeBackgroundColor: async () => {},
        setBadgeText: async () => {},
        setTitle: async () => {}
      }
    }
  });
  vm.runInContext(workerSource, context, { filename: workerPath });
  return { context, events };
}

test("toggle chooses the other page when Chrome has no active-tab result", () => {
  const context = createWorkerContext();
  const targets = [
    { id: "targetA", tabs: [{ id: 10, lastAccessed: 200 }] },
    { id: "targetB", tabs: [{ id: 20, lastAccessed: 100 }] }
  ];

  assert.equal(
    context.chooseNextTargetId(null, [], targets, 1, null),
    "targetB"
  );
});

test("the focused page wins over a stale last-target value", () => {
  const context = createWorkerContext();
  const targets = [
    { id: "targetA", tabs: [{ id: 10, lastAccessed: 200 }] },
    { id: "targetB", tabs: [{ id: 20, lastAccessed: 100 }] }
  ];

  assert.equal(
    context.chooseNextTargetId({ id: 10, windowId: 1 }, [], targets, 1, "targetB"),
    "targetB"
  );
});

test("last successful target wins over stale active tabs when the focused tab is unrelated", () => {
  const context = createWorkerContext();
  const targets = [
    { id: "targetA", tabs: [{ id: 10, lastAccessed: 100 }] },
    { id: "targetB", tabs: [{ id: 20, lastAccessed: 200 }] }
  ];

  assert.equal(
    context.chooseNextTargetId(
      { id: 99, windowId: 1 },
      [{ id: 20, windowId: 2, lastAccessed: 200 }, { id: 10, windowId: 3, lastAccessed: 100 }],
      targets,
      1,
      "targetA"
    ),
    "targetB"
  );
});

test("switching to B pauses A again after the target window is focused", async () => {
  const { context, events } = createSwitchHarness();

  await context.handleCommand("toggle-player");

  const focusIndex = events.findIndex((event) => event.type === "focus");
  const postFocusPause = events.findIndex((event, index) =>
    index > focusIndex && event.type === "pause" && event.tabId === 10
  );
  assert.ok(focusIndex >= 0, "target window should be focused");
  assert.ok(
    postFocusPause > focusIndex,
    `The source page should be paused after focus changes: ${JSON.stringify(events)}`
  );
  assert.ok(events.some((event) => event.type === "play" && event.tabId === 20));
});

test("a missed window focus is detected and retried", async () => {
  const { context, events } = createSwitchHarness({ focusFailures: 1 });

  await context.handleCommand("toggle-player");

  assert.deepEqual(
    events.filter((event) => event.type === "focus").map((event) => event.windowId),
    [2, 2]
  );
});

test("rapid right-Option presses queue two switches instead of dropping one", async () => {
  const { context, events } = createSwitchHarness();

  context.invokeToggle("native-hotkey");
  context.invokeToggle("native-hotkey");
  await vm.runInContext("commandQueue", context);

  assert.deepEqual(
    events.filter((event) => event.type === "focus").map((event) => event.windowId),
    [2, 1]
  );
});

test("a Chrome command duplicate is deduplicated against the native event", () => {
  const context = createWorkerContext();
  const calls = [];
  context.enqueueCommand = (command, source) => {
    calls.push({ command, source });
    return Promise.resolve();
  };

  context.invokeToggle("native-hotkey");
  context.invokeToggle("chrome-command");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "native-hotkey");
});

test("diagnostic logs persist locally and retain only the newest 300 entries", async () => {
  const context = createWorkerContext();
  await new Promise((resolve) => {
    context.runtimeMessageListener({ type: "setDebugMode", enabled: true }, {}, resolve);
  });

  for (let index = 0; index < 305; index += 1) {
    await context.recordDiagnostic("test.event", { index });
  }

  const response = await new Promise((resolve) => {
    context.runtimeMessageListener({ type: "getDiagnosticLogs" }, {}, resolve);
  });
  assert.equal(response.logs.length, 300);
  assert.equal(response.logs[0].index, 5);
  assert.equal(response.logs.at(-1).index, 304);

  await new Promise((resolve) => {
    context.runtimeMessageListener({ type: "clearDiagnosticLogs" }, {}, resolve);
  });
  const cleared = await new Promise((resolve) => {
    context.runtimeMessageListener({ type: "getDiagnosticLogs" }, {}, resolve);
  });
  assert.equal(cleared.logs.length, 0);
});

test("diagnostics are disabled by default and follow the persisted debug setting", async () => {
  const context = createWorkerContext();

  await context.recordDiagnostic("ignored.event");
  assert.equal((await context.chrome.storage.local.get("diagnosticLogs")).diagnosticLogs, undefined);

  const setDebugMode = (enabled) => new Promise((resolve) => {
    context.runtimeMessageListener({ type: "setDebugMode", enabled }, {}, resolve);
  });
  await setDebugMode(true);
  await context.recordDiagnostic("captured.event");
  await setDebugMode(false);
  await context.recordDiagnostic("ignored.after-disable");

  const { diagnosticLogs } = await context.chrome.storage.local.get("diagnosticLogs");
  assert.equal(Array.from(diagnosticLogs, ({ event }) => event).join(","), "debug.enabled,captured.event");
  assert.equal((await new Promise((resolve) => {
    context.runtimeMessageListener({ type: "getDebugMode" }, {}, resolve);
  })).enabled, false);
});
