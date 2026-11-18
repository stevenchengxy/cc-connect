import AppKit
import CoreGraphics
import Foundation

func reply(_ message: String) {
    print(message)
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    reply("ERROR " + message)
    exit(1)
}

func isActiveDisplay(_ display: CGDirectDisplayID) -> Bool {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
    var displays = Array(repeating: CGDirectDisplayID(0), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
    return displays.prefix(Int(count)).contains(display)
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--check"] {
    reply(CGPreflightPostEventAccess() ? "ALLOWED" : "DENIED")
    exit(0)
}
if arguments == ["--request-access"] {
    reply(CGPreflightPostEventAccess() || CGRequestPostEventAccess() ? "ALLOWED" : "DENIED")
    exit(0)
}
guard arguments.count == 1, let display = CGDirectDisplayID(arguments[0]),
      isActiveDisplay(display) else {
    fail("所选显示器不可用。")
}
guard CGPreflightPostEventAccess() else {
    fail("control-permission")
}
guard let source = CGEventSource(stateID: .privateState) else {
    fail("无法创建系统输入会话。")
}
source.localEventsSuppressionInterval = 0
var pressedKeys: Set<CGKeyCode> = []
var pressedButtons: [Int] = []
var location = CGPoint.zero
var lastClick: (button: Int, point: CGPoint, time: TimeInterval, count: Int)?
var clickCounts: [Int: Int64] = [:]
let modifierFlags: [CGKeyCode: CGEventFlags] = [
    54: .maskCommand, 55: .maskCommand, 56: .maskShift, 60: .maskShift,
    58: .maskAlternate, 61: .maskAlternate, 59: .maskControl, 62: .maskControl,
]
let mouseButtons: [CGMouseButton] = [.left, .center, .right]
let downTypes: [CGEventType] = [.leftMouseDown, .otherMouseDown, .rightMouseDown]
let upTypes: [CGEventType] = [.leftMouseUp, .otherMouseUp, .rightMouseUp]
let dragTypes: [CGEventType] = [.leftMouseDragged, .otherMouseDragged, .rightMouseDragged]

func flags() -> CGEventFlags {
    var result = CGEventSource.flagsState(.combinedSessionState).intersection(.maskAlphaShift)
    for key in pressedKeys {
        if let flag = modifierFlags[key] { result.insert(flag) }
    }
    return result
}

func keyboard(_ key: CGKeyCode, _ down: Bool) {
    let held = pressedKeys.contains(key)
    guard down || held else { return }
    if down { pressedKeys.insert(key) } else { pressedKeys.remove(key) }
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { return }
    event.flags = flags()
    if held && down {
        event.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
    }
    event.post(tap: .cghidEventTap)
}

func mouse(_ type: CGEventType, button: Int, point: CGPoint) {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                              mouseCursorPosition: point, mouseButton: mouseButtons[button]) else { return }
    event.flags = flags()
    event.setIntegerValueField(.mouseEventClickState, value: clickCounts[button] ?? 1)
    event.post(tap: .cghidEventTap)
    location = point
}

func setButton(_ button: Int, down: Bool, at point: CGPoint) {
    guard pressedButtons.contains(button) != down else { return }
    if down {
        let now = ProcessInfo.processInfo.systemUptime
        var count = 1
        if let previous = lastClick, previous.button == button,
           now - previous.time <= NSEvent.doubleClickInterval,
           hypot(point.x - previous.point.x, point.y - previous.point.y) <= 4 {
            count = previous.count % 3 + 1
        }
        lastClick = (button, point, now, count)
        clickCounts[button] = Int64(count)
        pressedButtons.append(button)
    } else {
        pressedButtons.removeAll { $0 == button }
    }
    mouse(down ? downTypes[button] : upTypes[button], button: button, point: point)
}

func move(_ point: CGPoint) {
    let held = pressedButtons.last
    mouse(held.map { dragTypes[$0] } ?? .mouseMoved, button: held ?? 0, point: point)
}

func releaseHeld() {
    for button in Array(pressedButtons.reversed()) { setButton(button, down: false, at: location) }
    // Release ordinary keys before their modifiers.
    for key in Array(pressedKeys).sorted(by: { (modifierFlags[$0] == nil ? 0 : 1) < (modifierFlags[$1] == nil ? 0 : 1) }) {
        keyboard(key, false)
    }
}

func normalizedPoint(_ x: Substring, _ y: Substring) -> CGPoint? {
    guard let nx = Double(x), let ny = Double(y), (0...1).contains(nx), (0...1).contains(ny) else { return nil }
    let rect = CGDisplayBounds(display)
    return CGPoint(x: rect.minX + nx * max(0, rect.width - 1),
                   y: rect.minY + ny * max(0, rect.height - 1))
}

reply("READY")
while let line = readLine() {
    if !isActiveDisplay(display) { break }
    let parts = line.split(separator: " ")
    guard let action = parts.first else { continue }
    switch action {
    case "reset":
        releaseHeld()
    case "key":
        if parts.count == 3, let key = CGKeyCode(parts[1]), key < 128 {
            keyboard(key, parts[2] == "1")
        }
    case "move":
        if parts.count == 3, let point = normalizedPoint(parts[1], parts[2]) { move(point) }
    case "button":
        if parts.count == 5, let button = Int(parts[1]), (0...2).contains(button),
           let point = normalizedPoint(parts[3], parts[4]) {
            setButton(button, down: parts[2] == "1", at: point)
        }
    case "wheel":
        if parts.count == 5, let dx = Int32(parts[1]), let dy = Int32(parts[2]),
           (-1000...1000).contains(dx), (-1000...1000).contains(dy),
           let point = normalizedPoint(parts[3], parts[4]),
           let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                               wheel1: -dy, wheel2: -dx, wheel3: 0) {
            event.location = point
            event.flags = flags()
            event.post(tap: .cghidEventTap)
        }
    default:
        break
    }
}
releaseHeld()
