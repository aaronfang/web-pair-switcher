const DEFAULT_SETTINGS = {
  targetA: { name: "抖音", pattern: "*://*.douyin.com/*" },
  targetB: { name: "哔哩哔哩", pattern: "*://*.bilibili.com/*" },
  globalHotkey: "Alt+Shift+Y"
};

const fields = {
  targetAName: document.querySelector("#targetAName"),
  targetAPattern: document.querySelector("#targetAPattern"),
  targetBName: document.querySelector("#targetBName"),
  targetBPattern: document.querySelector("#targetBPattern"),
  globalHotkey: document.querySelector("#globalHotkey"),
  nativeStatus: document.querySelector("#nativeStatus"),
  debugMode: document.querySelector("#debugMode"),
  debugModeStatus: document.querySelector("#debugModeStatus"),
  diagnosticLogs: document.querySelector("#diagnosticLogs"),
  diagnosticStatus: document.querySelector("#diagnosticStatus"),
  refreshDiagnostics: document.querySelector("#refreshDiagnostics"),
  copyDiagnostics: document.querySelector("#copyDiagnostics"),
  clearDiagnostics: document.querySelector("#clearDiagnostics"),
  save: document.querySelector("#save"),
  message: document.querySelector("#message")
};

document.addEventListener("DOMContentLoaded", () => {
  void loadSettings();
  fields.globalHotkey.addEventListener("keydown", captureHotkey);
  fields.globalHotkey.addEventListener("click", () => {
    fields.nativeStatus.textContent = "请按下新的组合键…";
  });
  fields.save.addEventListener("click", () => void saveSettings());
  fields.refreshDiagnostics.addEventListener("click", () => void loadDiagnosticLogs());
  fields.copyDiagnostics.addEventListener("click", () => void copyDiagnosticLogs());
  fields.clearDiagnostics.addEventListener("click", () => void clearDiagnosticLogs());
  fields.debugMode.addEventListener("change", () => void saveDebugMode());
  void updateNativeStatus();
  void loadDebugMode();
  void loadDiagnosticLogs();
});

async function loadDebugMode() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getDebugMode" });
    fields.debugMode.checked = Boolean(result?.enabled);
    fields.debugModeStatus.textContent = result?.enabled
      ? "正在收集调试日志"
      : "已关闭；不会记录新的调试日志";
  } catch (error) {
    fields.debugModeStatus.textContent = `读取状态失败：${error.message || error}`;
  }
}

async function saveDebugMode() {
  fields.debugMode.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "setDebugMode",
      enabled: fields.debugMode.checked
    });
    if (result?.error) throw new Error(result.error);
    fields.debugModeStatus.textContent = result.enabled
      ? "正在收集调试日志"
      : "已关闭；不会记录新的调试日志";
    await loadDiagnosticLogs();
  } catch (error) {
    fields.debugMode.checked = !fields.debugMode.checked;
    fields.debugModeStatus.textContent = `保存状态失败：${error.message || error}`;
  } finally {
    fields.debugMode.disabled = false;
  }
}

async function loadDiagnosticLogs() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getDiagnosticLogs" });
    if (result?.error) throw new Error(result.error);
    const logs = result?.logs || [];
    fields.diagnosticLogs.value = logs.map((entry) =>
      `${entry.time} ${entry.event} ${JSON.stringify(entry, (key, value) => key === "time" || key === "event" ? undefined : value)}`
    ).join("\n");
    fields.diagnosticStatus.textContent = `${logs.length} 条记录`;
    fields.diagnosticLogs.scrollTop = fields.diagnosticLogs.scrollHeight;
  } catch (error) {
    fields.diagnosticStatus.textContent = `读取记录失败：${error.message || error}`;
  }
}

async function copyDiagnosticLogs() {
  try {
    await navigator.clipboard.writeText(fields.diagnosticLogs.value);
    fields.diagnosticStatus.textContent = "诊断记录已复制";
  } catch {
    fields.diagnosticLogs.focus();
    fields.diagnosticLogs.select();
    fields.diagnosticStatus.textContent = "无法自动复制；记录已选中，请手动复制";
  }
}

async function clearDiagnosticLogs() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "clearDiagnosticLogs" });
    if (result?.error) throw new Error(result.error);
    fields.diagnosticLogs.value = "";
    fields.diagnosticStatus.textContent = "记录已清空";
  } catch (error) {
    fields.diagnosticStatus.textContent = `清空失败：${error.message || error}`;
  }
}

async function loadSettings() {
  const { switchSettings } = await chrome.storage.sync.get("switchSettings");
  const settings = mergeSettings(switchSettings);
  fields.targetAName.value = settings.targetA.name;
  fields.targetAPattern.value = settings.targetA.pattern;
  fields.targetBName.value = settings.targetB.name;
  fields.targetBPattern.value = settings.targetB.pattern;
  setHotkeyValue(settings.globalHotkey);
}

function mergeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    targetA: { ...DEFAULT_SETTINGS.targetA, ...(settings?.targetA || {}) },
    targetB: { ...DEFAULT_SETTINGS.targetB, ...(settings?.targetB || {}) }
  };
}

function captureHotkey(event) {
  event.preventDefault();
  if (event.code === "AltRight") {
    setHotkeyValue("RightAlt");
    fields.nativeStatus.textContent = "已选择右侧 Option；保存后按一下右 Option 即可切换";
    return;
  }
  if (event.code === "AltLeft") {
    fields.nativeStatus.textContent = "左侧 Option 不会被设置为单键快捷键";
    return;
  }
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;

  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Command");

  const key = keyName(event);
  if (!key || modifiers.length === 0) {
    fields.nativeStatus.textContent = "请至少包含一个 Control、Alt、Shift 或 Command 修饰键";
    return;
  }

  setHotkeyValue([...modifiers, key].join("+"));
  fields.nativeStatus.textContent = "快捷键已记录，点击保存后生效";
}

function setHotkeyValue(value) {
  fields.globalHotkey.dataset.hotkey = value;
  fields.globalHotkey.value = value === "RightAlt" ? "右侧 Option（单击）" : value;
}

function keyName(event) {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  const codes = {
    Space: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Escape",
    Enter: "Return",
    Tab: "Tab",
    Backspace: "Delete",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/"
  };
  return codes[code] || null;
}

async function saveSettings() {
  fields.message.classList.remove("error");
  const settings = {
    targetA: {
      name: fields.targetAName.value.trim() || "页面 A",
      pattern: normalizePattern(fields.targetAPattern.value)
    },
    targetB: {
      name: fields.targetBName.value.trim() || "页面 B",
      pattern: normalizePattern(fields.targetBPattern.value)
    },
    globalHotkey: fields.globalHotkey.dataset.hotkey || DEFAULT_SETTINGS.globalHotkey
  };

  try {
    validatePattern(settings.targetA.pattern);
    validatePattern(settings.targetB.pattern);
    const origins = [...new Set([settings.targetA.pattern, settings.targetB.pattern])];
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error("未授予网页访问权限");

    await chrome.storage.sync.set({ switchSettings: settings });
    await chrome.runtime.sendMessage({ type: "settingsChanged", settings });
    fields.message.textContent = "设置已保存。全局快捷键会在 Chrome 不在前台时继续工作。";
    fields.nativeStatus.textContent = "已发送到 macOS 常驻助手";
    setTimeout(() => void updateNativeStatus(), 500);
  } catch (error) {
    fields.message.textContent = error.message || "保存失败";
    fields.message.classList.add("error");
  }
}

function normalizePattern(value) {
  const pattern = value.trim();
  if (!pattern || pattern.includes("*")) return pattern;
  try {
    const url = new URL(pattern);
    return `${url.protocol}//${url.host}${url.pathname || "/"}*`;
  } catch {
    return pattern;
  }
}

function validatePattern(pattern) {
  if (!pattern || !/^(\*|https?|file):\/\//i.test(pattern)) {
    throw new Error("URL 匹配规则必须是 Chrome match pattern，例如 https://example.com/*");
  }
}

async function updateNativeStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "getNativeHostStatus" });
    fields.nativeStatus.textContent = status?.connected
      ? status?.error
        ? `macOS 常驻助手已连接；${status.error}`
        : "macOS 常驻助手已连接"
      : `macOS 常驻助手未连接：${status?.error || "请先运行 native-host/install-native-host.sh"}`;
  } catch {
    fields.nativeStatus.textContent = "无法检查 macOS 常驻助手状态";
  }
}
