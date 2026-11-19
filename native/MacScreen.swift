import AppKit
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit

private let maximumJPEGBytes = 2 * 1024 * 1024

private func outputSize(_ size: CGSize) -> (width: Int, height: Int)? {
    let longest = max(size.width, size.height)
    let shortest = min(size.width, size.height)
    guard shortest >= 1, longest.isFinite, longest <= 65536 else { return nil }
    let scale = min(1, 1920 / longest, 1080 / shortest)
    return (max(1, Int((size.width * scale).rounded())), max(1, Int((size.height * scale).rounded())))
}

private func writeAll(_ bytes: Data) -> Bool {
    return bytes.withUnsafeBytes { buffer in
        guard let address = buffer.baseAddress else { return false }
        var offset = 0
        while offset < buffer.count {
            let written = Darwin.write(STDOUT_FILENO, address.advanced(by: offset), buffer.count - offset)
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }
}

// Each record carries the system-selected display identity and exactly one JPEG.
// The encoder runs serially, with at most one image in flight to the parent.
private final class FrameWriter {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    func write(image: CIImage, display: CGDirectDisplayID, width: Int, height: Int) -> Bool {
        guard Int(image.extent.width) == width, Int(image.extent.height) == height else { return false }
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [quality: 0.8]),
              !jpeg.isEmpty, jpeg.count <= maximumJPEGBytes else { return false }
        let fields = [display, UInt32(width), UInt32(height), UInt32(jpeg.count)].map { $0.bigEndian }
        return writeAll(fields.withUnsafeBytes { Data($0) }) && writeAll(jpeg)
    }
}

@available(macOS 15.2, *)
private final class PickedScreen: NSObject, NSApplicationDelegate, SCContentSharingPickerObserver, SCStreamDelegate {
    private var showCursor: Bool
    private var captureConfiguration: SCStreamConfiguration?
    private var stream: SCStream?
    private var selectedID: CGDirectDisplayID?
    private var selectedBounds = CGRect.zero
    private var finishing = false
    private let sampleQueue = DispatchQueue(label: "app.jianping.screen.samples", qos: .userInitiated)
    private var output: ScreenFrames?

    init(showCursor: Bool) {
        self.showCursor = showCursor
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Close the stream even if the parent disappears while the picker is open.
        FileHandle.standardInput.readabilityHandler = { handle in
            let bytes = handle.availableData
            if bytes.isEmpty {
                handle.readabilityHandler = nil
                DispatchQueue.main.async { self.finish(0) }
            } else if bytes.contains(1) {
                // The parent downgraded control to viewing. Restore the host's
                // pointer in the video without prompting for the display again.
                DispatchQueue.main.async {
                    self.showCursor = true
                    if let config = self.captureConfiguration, let stream = self.stream {
                        config.showsCursor = true
                        stream.updateConfiguration(config) { _ in }
                    }
                }
            }
        }
        let picker = SCContentSharingPicker.shared
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleDisplay]
        configuration.allowsChangingSelectedContent = false
        picker.defaultConfiguration = configuration
        picker.maximumStreamCount = 1
        picker.add(self)
        picker.isActive = true
        NSApp.activate()
        picker.present(using: .display)
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for existing: SCStream?) {
        DispatchQueue.main.async {
            guard !self.finishing else { return }
            guard self.stream == nil, existing == nil else { self.finish(5); return }
            guard filter.style == .display, filter.includedDisplays.count == 1,
                  let display = filter.includedDisplays.first, display.displayID != 0,
                  CGDisplayIsActive(display.displayID) != 0 else { self.finish(4); return }
            let bounds = CGDisplayBounds(display.displayID)
            let area = filter.contentRect.size
            // Control coordinates refer to the complete chosen screen in display points.
            guard abs(area.width - bounds.width) <= 1, abs(area.height - bounds.height) <= 1 else {
                self.finish(4); return
            }
            let scale = CGFloat(filter.pointPixelScale)
            guard let size = outputSize(CGSize(width: area.width * scale, height: area.height * scale)) else {
                self.finish(4); return
            }
            let config = SCStreamConfiguration()
            config.width = size.width
            config.height = size.height
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            config.queueDepth = 3
            config.showsCursor = self.showCursor
            config.capturesAudio = false
            config.pixelFormat = kCVPixelFormatType_32BGRA
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            let output = ScreenFrames(id: display.displayID, width: size.width, height: size.height) { code in
                DispatchQueue.main.async { self.finish(code) }
            }
            self.selectedID = display.displayID
            self.selectedBounds = bounds
            self.stream = stream
            self.captureConfiguration = config
            self.output = output
            do {
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: self.sampleQueue)
                stream.startCapture { error in
                    if error != nil { DispatchQueue.main.async { self.finish(4) } }
                }
            } catch { self.finish(4) }
        }
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) {
        guard let id = selectedID else { return }
        if CGDisplayIsActive(id) == 0 || CGDisplayBounds(id) != selectedBounds { finish(5) }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor existing: SCStream?) {
        DispatchQueue.main.async { self.finish(self.stream == nil ? 3 : 5) }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        DispatchQueue.main.async { self.finish(4) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { self.finish(5) }
    }

    private func finish(_ code: Int32) {
        guard !finishing else { return }
        finishing = true
        let picker = SCContentSharingPicker.shared
        picker.remove(self)
        picker.isActive = false
        // Process termination releases the system grant and closes the frame pipe.
        exit(code)
    }
}

@available(macOS 15.2, *)
private final class ScreenFrames: NSObject, SCStreamOutput {
    private let id: CGDirectDisplayID
    private let width: Int
    private let height: Int
    private let finish: (Int32) -> Void
    private let encoder = FrameWriter()
    private let encodeQueue = DispatchQueue(label: "app.jianping.screen.jpeg", qos: .userInitiated)
    private let frameLock = NSLock()
    private var encoding = false
    private var latestFrame: CVPixelBuffer?

    init(id: CGDirectDisplayID, width: Int, height: Int, finish: @escaping (Int32) -> Void) {
        self.id = id
        self.width = width
        self.height = height
        self.finish = finish
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid,
              let items = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = items.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return }
        if status == .blank || status == .suspended || status == .stopped { finish(5); return }
        guard status == .complete, let buffer = sample.imageBuffer else { return }
        frameLock.lock()
        if encoding {
            // ScreenCaptureKit may send only idle notifications after this update.
            // Keep the newest complete frame while a slow consumer drains the pipe.
            latestFrame = buffer
            frameLock.unlock()
            return
        }
        encoding = true
        frameLock.unlock()
        encodeQueue.async { self.writeFrames(startingWith: buffer) }
    }

    private func writeFrames(startingWith first: CVPixelBuffer) {
        var next: CVPixelBuffer? = first
        while let buffer = next {
            let delivered = autoreleasepool {
                encoder.write(image: CIImage(cvPixelBuffer: buffer), display: id, width: width, height: height)
            }
            guard delivered else { finish(4); return }
            frameLock.lock()
            next = latestFrame
            latestFrame = nil
            if next == nil { encoding = false }
            frameLock.unlock()
        }
    }
}

signal(SIGPIPE, SIG_IGN)
#if CC_SCREEN_FIXTURE
// Separate test-only build. No picker, permissions, display access or user input.
let synthetic = CIImage(color: CIColor(red: 0.1, green: 0.4, blue: 0.8)).cropped(to: CGRect(x: 0, y: 0, width: 160, height: 90))
guard outputSize(CGSize(width: 2160, height: 3840))?.width == 1080,
      outputSize(CGSize(width: 3840, height: 2160))?.width == 1920 else { exit(1) }
exit(FrameWriter().write(image: synthetic, display: 42, width: 160, height: 90) ? 0 : 4)
#else
let arguments = Array(CommandLine.arguments.dropFirst())
let showCursor = arguments == ["--pick-display"]
guard showCursor || arguments == ["--pick-display", "--omit-cursor"] else { exit(2) }
if #available(macOS 15.2, *) {
    let app = NSApplication.shared
    let delegate = PickedScreen(showCursor: showCursor)
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { app.run() }
} else { exit(2) }
#endif
