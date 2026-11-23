import AppKit
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
for (label, size) in [("16x16",16),("16x16@2x",32),("32x32",32),("32x32@2x",64),("128x128",128),("128x128@2x",256),("256x256",256),("256x256@2x",512),("512x512",512),("512x512@2x",1024)] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
    let transform = NSAffineTransform()
    transform.scale(by:CGFloat(size)/128)
    transform.concat()
    let bg = NSBezierPath(roundedRect:NSRect(x:7,y:7,width:114,height:114), xRadius:27,yRadius:27)
    NSGradient(starting:NSColor(srgbRed:0.10,green:0.34,blue:0.39,alpha:1),ending:NSColor(srgbRed:0.03,green:0.12,blue:0.22,alpha:1))!.draw(in:bg,angle:-55)
    func bubble(_ x:CGFloat,_ y:CGFloat,_ color:NSColor) {
        color.setFill()
        NSBezierPath(roundedRect:NSRect(x:x,y:y,width:53,height:39),xRadius:13,yRadius:13).fill()
        let tail = NSBezierPath(); tail.move(to:NSPoint(x:x+8,y:y+5)); tail.line(to:NSPoint(x:x+8,y:y-7));tail.line(to:NSPoint(x:x+24,y:y+2));tail.close();tail.fill()
    }
    bubble(54,36,NSColor(srgbRed:0.38,green:0.86,blue:0.75,alpha:1))
    bubble(24,57,NSColor(srgbRed:0.93,green:1,blue:0.97,alpha:1))
    NSColor(srgbRed:0.12,green:0.32,blue:0.34,alpha:1).setFill()
    for x in [36,48,60] { NSBezierPath(ovalIn:NSRect(x:x,y:74,width:6,height:6)).fill() }
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using:.png,properties:[:])!.write(to:dir.appendingPathComponent("icon_"+label+".png"))
}
