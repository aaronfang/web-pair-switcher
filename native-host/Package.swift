// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WebPairSwitcherGlobalHotkeyHost",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "web-pair-switcher-global-hotkey", targets: ["GlobalHotkeyHost"])
    ],
    targets: [
        .executableTarget(name: "GlobalHotkeyHost")
    ]
)
