import AppKit
import CoreGraphics
import Foundation

// Each Node environment owns at most one session, accessed on that environment's JS thread.
private final class MacInputSession {
    let display: CGDirectDisplayID
    let source: CGEventSource

    init(display: CGDirectDisplayID, source: CGEventSource) {
        self.display = display
        self.source = source
        source.localEventsSuppressionInterval = 0
    }

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

    func process(_ line: String) {
        let parts = line.split(separator: " ")
        guard let action = parts.first else { return }
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
}

// C entry points used by the Node-API module in the CC Connect main process.
@_cdecl("cc_input_access")
public func ccInputAccess(_ request: Int32) -> Int32 {
    if CGPreflightPostEventAccess() { return 1 }
    if request == 0 { return 0 }
    _ = CGRequestPostEventAccess()
    return CGPreflightPostEventAccess() ? 1 : 0
}

@_cdecl("cc_input_start")
public func ccInputStart(_ display: UInt32, _ output: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32 {
    guard display != 0, CGDisplayIsActive(display) != 0 else { return 1 }
    guard CGPreflightPostEventAccess() else { return 2 }
    guard let source = CGEventSource(stateID: .privateState) else { return 3 }
    let session = MacInputSession(display: display, source: source)
    output.pointee = Unmanaged.passRetained(session).toOpaque()
    return 0
}

@_cdecl("cc_input_send")
public func ccInputSend(_ handle: UnsafeMutableRawPointer, _ input: UnsafePointer<CChar>) -> Int32 {
    let session = Unmanaged<MacInputSession>.fromOpaque(handle).takeUnretainedValue()
    guard CGDisplayIsActive(session.display) != 0 else { return 1 }
    let line = String(cString: input)
    if line == "check-access" { return CGPreflightPostEventAccess() ? 0 : 2 }
    session.process(line)
    return 0
}

@_cdecl("cc_input_stop")
public func ccInputStop(_ handle: UnsafeMutableRawPointer) {
    let session = Unmanaged<MacInputSession>.fromOpaque(handle).takeRetainedValue()
    session.releaseHeld()
}
