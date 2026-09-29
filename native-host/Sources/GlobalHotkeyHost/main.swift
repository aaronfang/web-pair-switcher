import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

private let defaultHotkey = "Alt+Shift+Y"

private struct Message: Decodable {
    let type: String
    let hotkey: String?
}

private final class NativeMessagingHost {
    private let input = FileHandle.standardInput
    private let output = FileHandle.standardOutput
    private let outputLock = NSLock()
    private var eventHandler: EventHandlerRef?
    private var hotKey: EventHotKeyRef?
    private var globalMonitor: Any?
    private var rightAltDown = false
    private var rightAltChorded = false
    private var spec = parseHotkey(defaultHotkey)

    func start() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        installEventHandler()
        if let spec { register(spec) }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.readMessages()
        }

        send(["type": "ready"])
        NSApplication.shared.run()
    }

    private func installEventHandler() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            globalHotkeyHandler,
            1,
            &eventType,
            context,
            &eventHandler
        )
        if status != noErr {
            send(["type": "configurationError", "message": "Could not install the macOS hotkey event handler"])
        }
    }

    func handleHotkeyEvent(_ event: EventRef?) -> OSStatus {
        guard let event, let current = spec else { return noErr }
        var pressedID = EventHotKeyID()
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &pressedID
        )
        guard status == noErr, pressedID.id == current.identifier else { return noErr }
        send(["type": "hotkey"])
        return noErr
    }

    private func readMessages() {
        while let data = readMessage() {
            guard let message = try? JSONDecoder().decode(Message.self, from: data) else { continue }
            if message.type == "configure", let hotkey = message.hotkey, let parsed = parseHotkey(hotkey) {
                DispatchQueue.main.async { [weak self] in
                    self?.register(parsed)
                }
            } else if message.type == "configure", message.hotkey != nil {
                send(["type": "configurationError", "message": "Unsupported shortcut key"])
            } else if message.type == "ping" {
                send(["type": "pong"])
            }
        }

        DispatchQueue.main.async {
            self.unregisterCurrentHotkey()
            Foundation.exit(0)
        }
    }

    private func register(_ newSpec: HotkeySpec) {
        unregisterCurrentHotkey()

        if newSpec.mode == .rightAlt {
            registerRightAlt(newSpec)
            return
        }

        registerCarbonHotkey(newSpec)
    }

    private func registerCarbonHotkey(_ newSpec: HotkeySpec) {
        let hotKeyID = EventHotKeyID(signature: OSType(0x434F4445), id: newSpec.identifier)
        var registeredHotKey: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(newSpec.keyCode),
            newSpec.carbonModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &registeredHotKey
        )
        guard status == noErr else {
            send(["type": "configurationError", "message": "Shortcut is already in use or unavailable"])
            return
        }

        spec = newSpec
        hotKey = registeredHotKey
        send(["type": "configured", "hotkey": newSpec.label])
    }

    private func registerRightAlt(_ newSpec: HotkeySpec) {
        let promptOptions = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
        ] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(promptOptions)

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { [weak self] event in
            self?.handleGlobalEvent(event)
        }
        guard globalMonitor != nil else {
            send(["type": "configurationError", "message": "Could not start the right Option listener"])
            return
        }

        spec = newSpec
        rightAltDown = false
        rightAltChorded = false
        send(["type": "configured", "hotkey": newSpec.label])
        if !trusted {
            send([
                "type": "permissionRequired",
                "message": "右 Option 模式需要在系统设置的辅助功能中允许全局快捷键助手，然后重新加载扩展"
            ])
        }
    }

    private func handleGlobalEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            if rightAltDown { rightAltChorded = true }
            return
        }

        guard event.type == .flagsChanged, event.keyCode == 61 else { return }
        let isDown = event.modifierFlags.contains(.option)
        if isDown, !rightAltDown {
            rightAltDown = true
            rightAltChorded = false
        } else if !isDown, rightAltDown {
            let shouldTrigger = !rightAltChorded
            rightAltDown = false
            rightAltChorded = false
            if shouldTrigger { send(["type": "hotkey"]) }
        }
    }

    private func unregisterCurrentHotkey() {
        if let hotKey {
            UnregisterEventHotKey(hotKey)
            self.hotKey = nil
        }
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        rightAltDown = false
        rightAltChorded = false
    }

    private func readMessage() -> Data? {
        guard let header = try? input.read(upToCount: 4), header.count == 4 else { return nil }
        let bytes = [UInt8](header)
        let length = UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24)
        guard length > 0, length < 1_048_576 else { return nil }

        var body = Data()
        while body.count < Int(length) {
            guard let chunk = try? input.read(upToCount: Int(length) - body.count), !chunk.isEmpty else { return nil }
            body.append(chunk)
        }
        return body
    }

    private func send(_ object: [String: String]) {
        guard let body = try? JSONSerialization.data(withJSONObject: object) else { return }
        let length = UInt32(body.count)
        var packet = Data([
            UInt8(length & 0xff),
            UInt8((length >> 8) & 0xff),
            UInt8((length >> 16) & 0xff),
            UInt8((length >> 24) & 0xff)
        ])
        packet.append(body)
        outputLock.lock()
        defer { outputLock.unlock() }
        try? output.write(contentsOf: packet)
    }
}

private let globalHotkeyHandler: EventHandlerProcPtr = { _, event, userData in
    guard let userData else { return noErr }
    let host = Unmanaged<NativeMessagingHost>.fromOpaque(userData).takeUnretainedValue()
    return host.handleHotkeyEvent(event)
}

private func parseHotkey(_ value: String) -> HotkeySpec? {
    if value.caseInsensitiveCompare("RightAlt") == .orderedSame {
        return HotkeySpec(
            mode: .rightAlt,
            keyCode: 0,
            carbonModifiers: 0,
            label: "RightAlt"
        )
    }

    let parts = value.split(separator: "+").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let keyName = parts.last, !keyName.isEmpty else { return nil }

    var modifiers = UInt32(0)
    for part in parts.dropLast() {
        switch part.lowercased() {
        case "alt", "option": modifiers |= UInt32(optionKey)
        case "control", "ctrl": modifiers |= UInt32(controlKey)
        case "command", "cmd", "meta": modifiers |= UInt32(cmdKey)
        case "shift": modifiers |= UInt32(shiftKey)
        default: return nil
        }
    }
    guard modifiers != 0, let keyCode = keyCode(for: String(keyName)) else { return nil }
    return HotkeySpec(
        mode: .carbon,
        keyCode: keyCode,
        carbonModifiers: modifiers,
        label: value
    )
}

private enum HotkeyMode {
    case carbon
    case rightAlt
}

private struct HotkeySpec {
    static let identifier: UInt32 = 1
    let mode: HotkeyMode
    let keyCode: UInt16
    let carbonModifiers: UInt32
    let label: String
    var identifier: UInt32 { Self.identifier }
}

private func keyCode(for name: String) -> UInt16? {
    let key = name.uppercased()
    let codes: [String: UInt16] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
        "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45,
        "M": 46, "SPACE": 49, "TAB": 48, "RETURN": 36, "ENTER": 36, "ESCAPE": 53, "DELETE": 51,
        "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47, "[": 33, "]": 30, "`": 50,
        "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126, "F1": 122, "F2": 120, "F3": 99,
        "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
        "F11": 103, "F12": 111
    ]
    return codes[key]
}

NativeMessagingHost().start()
