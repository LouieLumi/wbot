import Foundation
import Vision
import AppKit
import CryptoKit

// Local Vision OCR. Image bytes arrive on stdin and never leave this Mac.
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
let barcodes = VNDetectBarcodesRequest()
barcodes.symbologies = [.qr]
try VNImageRequestHandler(cgImage: image).perform([request, barcodes])
let result = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let best = observation.topCandidates(1).first else { return nil }
    let b = observation.boundingBox
    return ["text": best.string, "confidence": best.confidence,
            "bounds": [b.minX * Double(image.width), (1-b.maxY) * Double(image.height),
                       b.maxX * Double(image.width), (1-b.minY) * Double(image.height)]]
}
let hashes = (barcodes.results ?? []).compactMap { item -> String? in
    guard let value = item.payloadStringValue else { return nil }
    return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}
let json = try JSONSerialization.data(withJSONObject: ["width": image.width, "height": image.height, "items": result, "qr_hashes": hashes], options: [.sortedKeys])
FileHandle.standardOutput.write(json)
