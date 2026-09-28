// Renders a simple train-emoji app icon to a 1024x1024 PNG.
// Run with: swift tools/make_icon.swift <output.png>
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

let bgRect = NSRect(x: 0, y: 0, width: size, height: size)
let bgPath = NSBezierPath(roundedRect: bgRect, xRadius: size * 0.22, yRadius: size * 0.22)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.15, green: 0.47, blue: 0.95, alpha: 1.0),
    NSColor(calibratedRed: 0.04, green: 0.18, blue: 0.52, alpha: 1.0)
])
gradient?.draw(in: bgPath, angle: -90)

let emoji = "🚆"
let font = NSFont.systemFont(ofSize: size * 0.55)
let attrs: [NSAttributedString.Key: Any] = [.font: font]
let str = NSAttributedString(string: emoji, attributes: attrs)
let strSize = str.size()
let point = NSPoint(x: (size - strSize.width) / 2, y: (size - strSize.height) / 2 - size * 0.02)
str.draw(at: point)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("Failed to render icon\n".data(using: .utf8)!)
    exit(1)
}

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
try png.write(to: URL(fileURLWithPath: outputPath))
print("wrote \(outputPath)")
