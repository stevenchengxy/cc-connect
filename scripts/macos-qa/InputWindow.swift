import AppKit
import CoreGraphics

func report(_ text: String) {
    print(text)
    fflush(stdout)
}

let hosted = CommandLine.arguments.contains("--hosted")
let environment = ProcessInfo.processInfo.environment
if hosted && (environment["GITHUB_ACTIONS"] != "true" || environment["RUNNER_ENVIRONMENT"] != "github-hosted" ||
              environment["RUNNER_OS"] != "macOS") { exit(2) }

let app = NSApplication.shared
app.setActivationPolicy(hosted ? .regular : .prohibited)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 180),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "CC Connect native input test"
window.isReleasedWhenClosed = false
let button = NSButton(title: "Test click", target: nil, action: nil)
button.frame = NSRect(x: 90, y: 85, width: 180, height: 40)
let field = NSTextField(frame: NSRect(x: 60, y: 25, width: 240, height: 32))
window.contentView!.addSubview(button)
window.contentView!.addSubview(field)

final class Receiver: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let sender = getppid()
    var monitor: Any?

    @objc func clicked(_ source: Any?) {
        report("BUTTON")
        window.makeFirstResponder(field)
    }

    func controlTextDidChange(_ notification: Notification) {
        if field.stringValue == "a" { report("TEXT") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        button.target = self
        button.action = #selector(clicked(_:))
        field.delegate = self
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .keyDown, .keyUp]) { event in
            // Only observe events created by this test runner. Never log typed content.
            guard event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(self.sender) else { return event }
            switch event.type {
            case .leftMouseDown: report("MOUSE_DOWN")
            case .leftMouseUp: report("MOUSE_UP")
            case .keyDown where event.keyCode == 0 && event.charactersIgnoringModifiers?.lowercased() == "a": report("KEY_DOWN")
            case .keyUp where event.keyCode == 0: report("KEY_UP")
            default: break
            }
            return event
        }
        if hosted {
            window.center()
            window.makeKeyAndOrderFront(nil)
            app.activate(ignoringOtherApps: true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            let display = CGMainDisplayID()
            let bounds = CGDisplayBounds(display)
            let point = window.convertPoint(toScreen: NSPoint(x: button.frame.midX, y: button.frame.midY))
            let x = hosted ? (point.x - bounds.minX) / max(1, bounds.width - 1) : 0.5
            let y = hosted ? (bounds.height - point.y) / max(1, bounds.height - 1) : 0.5
            if hosted && (!window.isKeyWindow || !app.isActive || NSWorkspace.shared.frontmostApplication?.processIdentifier != getpid()) {
                report("NO_FRONTMOST_WINDOW")
                exit(3)
            }
            report("READY \(display) \(x) \(y)")
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                if line == "focus" {
                    DispatchQueue.main.async {
                        report(window.isKeyWindow && app.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() ? "FOCUSED" : "NOT_FOCUSED")
                    }
                }
            }
            exit(0)
        }
    }
}

let receiver = Receiver()
app.delegate = receiver
app.run()
