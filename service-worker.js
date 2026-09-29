const BASE_TITLE = "网页双页切换器";
const NATIVE_HOST_NAME = "com.aaronfang.web_pair_switcher";
const DEFAULT_SETTINGS = {
  targetA: { name: "抖音", pattern: "*://*.douyin.com/*" },
  targetB: { name: "哔哩哔哩", pattern: "*://*.bilibili.com/*" },
  globalHotkey: "Alt+Shift+Y"
};

let nativePort = null;
let reconnectScheduled = false;
let lastToggleAt = 0;
let lastToggleSource = "";
let nativeHostError = "正在连接 macOS 常驻助手";
let commandQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const { switchSettings } = await chrome.storage.sync.get("switchSettings");
  if (!switchSettings) {
    await chrome.storage.sync.set({ switchSettings: DEFAULT_SETTINGS });
  }
  connectNativeHost();
});

chrome.runtime.onStartup.addListener(() => {
  connectNativeHost();
});

chrome.alarms.create("native-host-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "native-host-keepalive") return;
  connectNativeHost();
  if (nativePort) {
    try {
      nativePort.postMessage({ type: "ping" });
    } catch (error) {
      console.warn("Could not ping native global hotkey helper", error);
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "settingsChanged") {
    sendNativeSettings(message.settings);
    sendResponse({ ok: true });
  } else if (message?.type === "getNativeHostStatus") {
    sendResponse({ connected: Boolean(nativePort), error: nativeHostError });
  }
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-player") {
    invokeToggle("chrome-command");
  } else {
    void enqueueCommand(command);
  }
});

connectNativeHost();

function invokeToggle(source) {
  const now = Date.now();
  // The native helper and Chrome command can both see the same keystroke when
  // Chrome is focused. Deduplicate only across those two sources; repeated
  // right-Option events from the native helper are real user toggles.
  if (source !== lastToggleSource && now - lastToggleAt < 500) return;
  lastToggleAt = now;
  lastToggleSource = source;
  void enqueueCommand("toggle-player", source);
}

function enqueueCommand(command, source = "command") {
  commandQueue = commandQueue
    .catch(() => {})
    .then(() => handleCommand(command, source));
  return commandQueue;
}

function connectNativeHost() {
  if (nativePort) return;

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    nativeHostError = "";
    port.onMessage.addListener((message) => {
      if (message?.type === "hotkey") invokeToggle("native-hotkey");
      if (message?.type === "configured") nativeHostError = "";
      if (message?.type === "permissionRequired") {
        nativeHostError = message.message || "右 Option 模式需要辅助功能权限";
      }
      if (message?.type === "configurationError") {
        nativeHostError = message.message || "全局快捷键不可用";
        void showProblem(`全局快捷键不可用：${message.message || "请换一个组合键"}`);
      }
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError is required by Chrome and prevents an unchecked
      // runtime.lastError from being emitted for a missing native host.
      const error = chrome.runtime.lastError;
      nativeHostError = error?.message || "macOS 常驻助手已断开";
      if (nativePort === port) nativePort = null;
      scheduleNativeReconnect();
    });
    void sendNativeSettings(undefined, port);
  } catch (error) {
    nativeHostError = error?.message || "macOS 常驻助手不可用";
    nativePort = null;
    scheduleNativeReconnect();
  }
}

function scheduleNativeReconnect() {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  setTimeout(() => {
    reconnectScheduled = false;
    connectNativeHost();
  }, 30000);
}

async function sendNativeSettings(settings, requestedPort = nativePort) {
  if (!requestedPort) return;
  const current = settings || await readSettings();
  if (requestedPort !== nativePort) return;
  try {
    requestedPort.postMessage({
      type: "configure",
      hotkey: current.globalHotkey
    });
  } catch (error) {
    nativeHostError = error?.message || "无法配置全局快捷键";
  }
}

async function handleCommand(command, _source = "command") {
  try {
    const settings = await readSettings();
    const targets = [settings.targetA, settings.targetB];
    const targetTabs = await tabsForTargets(targets);
    const focusedWindow = await chrome.windows.getLastFocused();
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: focusedWindow.id
    });
    const activeTabs = await chrome.tabs.query({ active: true });

    let targetService;
    if (command === "focus-target-a") {
      targetService = "targetA";
    } else if (command === "focus-target-b") {
      targetService = "targetB";
    } else if (command === "toggle-player") {
      const { lastTargetId } = await chrome.storage.local.get("lastTargetId");
      targetService = chooseNextTargetId(
        activeTab,
        activeTabs,
        targetTabs,
        focusedWindow.id,
        lastTargetId
      );
    } else {
      return;
    }

    const target = targets[targetService === "targetA" ? 0 : 1];
    const targetTab = chooseTab(
      targetTabs.find((entry) => entry.id === targetService)?.tabs || [],
      focusedWindow.id
    );

    if (!targetTab) {
      await showProblem(`没有找到已打开的“${target.name}”页面`);
      return;
    }

    // Pause other pages before switching, and again after the Space transition.
    // Some feed players react to visibility/focus changes by
    // resuming after an earlier pause request.
    await pauseOtherTargetTabs(targetTabs, targetTab.id);

    // Activating the Chrome window is the extension API's available way to
    // ask macOS to show a window that belongs to another Space.
    await chrome.tabs.update(targetTab.id, { active: true });
    const refreshedTargetTab = await chrome.tabs.get(targetTab.id);
    await chrome.windows.update(refreshedTargetTab.windowId, { focused: true });
    await chrome.storage.local.set({ lastTargetId: targetService });

    // macOS may still be animating to the target Space after the Chrome APIs
    // resolve. Let the page become foregrounded before asking its player to run.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await pauseOtherTargetTabs(targetTabs, targetTab.id);
    const playback = await controlTab(targetTab.id, "play");
    // A final sweep closes the race where the source page resumes while the
    // destination player is starting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stillPlayingTabs = await pauseOtherTargetTabs(targetTabs, targetTab.id);
    if (stillPlayingTabs.length > 0) {
      await showProblem("已切换，但另一配置页面的视频仍未暂停");
    } else if (playback.state === "playing") {
      await clearProblem();
    } else if (playback.state === "blocked") {
      await showProblem("播放被浏览器拦截；请在目标页手动播放一次后再试");
    } else {
      // Switching is still successful for ordinary pages without a video.
      await clearProblem();
    }
  } catch (error) {
    console.error("Could not switch video tabs", error);
    await showProblem("切换失败；请确认扩展有目标页面权限");
  }
}

function chooseNextTargetId(
  focusedActiveTab,
  activeTabs,
  targetTabs,
  focusedWindowId,
  lastTargetId
) {
  const targetForTab = (tabId) => targetTabs.find(({ tabs }) =>
    tabs.some((tab) => tab.id === tabId)
  )?.id;
  const nextTarget = (currentTargetId) =>
    currentTargetId === "targetA" ? "targetB" : "targetA";

  const focusedTargetId = focusedActiveTab?.windowId === focusedWindowId
    ? targetForTab(focusedActiveTab.id)
    : null;
  if (focusedTargetId) return nextTarget(focusedTargetId);

  const recentActiveTarget = [...(activeTabs || [])]
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map((tab) => targetForTab(tab.id))
    .find(Boolean);
  if (recentActiveTarget) return nextTarget(recentActiveTarget);

  // Chrome may briefly return no active tab while macOS is moving between
  // Spaces. Prefer the last successfully focused target over guessing A.
  if (lastTargetId === "targetA" || lastTargetId === "targetB") {
    return nextTarget(lastTargetId);
  }

  const mostRecentlyAccessedTarget = targetTabs
    .flatMap(({ id, tabs }) => tabs.map((tab) => ({
      id,
      lastAccessed: tab.lastAccessed || 0
    })))
    .sort((a, b) => b.lastAccessed - a.lastAccessed)[0]?.id;
  return mostRecentlyAccessedTarget
    ? nextTarget(mostRecentlyAccessedTarget)
    : "targetA";
}

async function pauseOtherTargetTabs(targetTabs, keepTabId) {
  const otherTabs = uniqueTabs(targetTabs.flatMap((entry) => entry.tabs))
    .filter((tab) => tab.id !== keepTabId);
  const results = await Promise.all(otherTabs.map(async (tab) => {
    try {
      const result = await controlTab(tab.id, "pause");
      return result.state === "still-playing" ? tab : null;
    } catch (error) {
      console.warn("Could not pause video tab", tab.id, error);
      return tab;
    }
  }));
  return results.filter(Boolean);
}

async function readSettings() {
  const { switchSettings } = await chrome.storage.sync.get("switchSettings");
  return {
    ...DEFAULT_SETTINGS,
    ...(switchSettings || {}),
    targetA: { ...DEFAULT_SETTINGS.targetA, ...(switchSettings?.targetA || {}) },
    targetB: { ...DEFAULT_SETTINGS.targetB, ...(switchSettings?.targetB || {}) }
  };
}

async function tabsForTargets(targets) {
  const entries = await Promise.all(targets.map(async (target, index) => {
    try {
      return {
        id: index === 0 ? "targetA" : "targetB",
        target,
        tabs: await chrome.tabs.query({ url: target.pattern })
      };
    } catch (error) {
      console.warn("Invalid target match pattern", target.pattern, error);
      return { id: index === 0 ? "targetA" : "targetB", target, tabs: [] };
    }
  }));
  return entries;
}

function uniqueTabs(tabs) {
  return [...new Map(tabs.map((tab) => [tab.id, tab])).values()];
}

function chooseTab(candidates, focusedWindowId) {
  return candidates.sort((a, b) => {
    const aFocused = a.active && a.windowId === focusedWindowId ? 1 : 0;
    const bFocused = b.active && b.windowId === focusedWindowId ? 1 : 0;
    if (aFocused !== bFocused) return bFocused - aFocused;

    const aActive = a.active ? 1 : 0;
    const bActive = b.active ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;

    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  })[0];
}

async function controlTab(tabId, action) {
  if (action === "pause") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let reports = [];
      try {
        reports = await injectVideoControl(tabId, action, false);
      } catch (error) {
        console.warn("Could not pause the main video frame", tabId, error);
      }
      // Also inspect embedded players, while retaining the main-frame result
      // in case Chrome cannot inject into one of the page's subframes.
      reports.push(...await injectVideoControl(tabId, action, true));
      if (!reports.some((report) => report.state === "playing")) {
        return { state: "paused" };
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 180));
    }
    return { state: "still-playing" };
  }

  // Prefer the page's main frame to avoid playing hidden videos embedded in
  // auxiliary frames. If the player lives in an iframe, search all frames.
  let blocked = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let reports = await injectVideoControl(tabId, "play", false);
    let state = summarizePlayback(reports);
    if (state === "playing") return { state };
    if (state === "blocked") blocked = true;

    reports = await injectVideoControl(tabId, "play", true);
    state = summarizePlayback(reports);
    if (state === "playing") return { state };
    if (state === "blocked") blocked = true;

    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { state: blocked ? "blocked" : "no-video" };
}

async function injectVideoControl(tabId, action, allFrames) {
  try {
    const results = await chrome.scripting.executeScript({
      target: allFrames ? { tabId, allFrames: true } : { tabId },
      injectImmediately: true,
      func: setVideoPlayback,
      args: [action]
    });
    return results.map((entry) => entry.result).filter(Boolean);
  } catch (error) {
    if (!allFrames) throw error;
    console.warn("Could not inspect every frame", tabId, error);
    return [];
  }
}

function summarizePlayback(reports) {
  if (reports.some((report) => report.state === "playing")) return "playing";
  if (reports.some((report) => report.state === "blocked")) return "blocked";
  return "no-video";
}

async function setVideoPlayback(action) {
  const videos = new Set();

  function scan(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element;
    while ((element = walker.nextNode())) {
      if (element instanceof HTMLVideoElement) videos.add(element);
      if (element.shadowRoot) scan(element.shadowRoot);
    }
  }

  scan(document);
  const allVideos = [...videos];

  if (action === "pause") {
    for (const video of allVideos) video.pause();
    return {
      state: allVideos.some((video) => !video.paused && !video.ended)
        ? "playing"
        : "paused",
      count: allVideos.length
    };
  }

  const candidates = allVideos
    .map((video) => {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      const intersectionWidth = Math.max(
        0,
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
      );
      const intersectionHeight = Math.max(
        0,
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
      );
      const visibleArea = intersectionWidth * intersectionHeight;
      const elementArea = rect.width * rect.height;
      const visibleRatio = elementArea > 0 ? visibleArea / elementArea : 0;
      const visible = visibleArea >= 80 * 60 && visibleRatio >= 0.1 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) > 0;
      return { video, visibleArea, visibleRatio, visible };
    })
    .filter((entry) => entry.visible)
    .sort((a, b) =>
      b.visibleArea - a.visibleArea || b.visibleRatio - a.visibleRatio
    );

  const chosen = candidates[0]?.video;
  if (!chosen) return { state: "no-video", count: allVideos.length };

  for (const video of allVideos) {
    if (video !== chosen) video.pause();
  }

  try {
    await chosen.play();
    // A feed player can resolve play() and then immediately pause an inactive
    // item. Confirm the final media state instead of trusting the Promise.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      state: chosen.paused || chosen.ended ? "blocked" : "playing",
      count: allVideos.length
    };
  } catch {
    return { state: "blocked", count: allVideos.length };
  }
}

async function showProblem(message) {
  await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: `${BASE_TITLE} — ${message}` });
}

async function clearProblem() {
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: BASE_TITLE });
}
