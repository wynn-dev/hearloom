// Hearloom speaker-diarization sidecar (macOS, Core ML on the Neural Engine via FluidAudio).
//
// Long-running: loads the offline diarizer once, then answers one JSON request per stdin line:
//   {"id": "...", "audio": "/path/to/samples.f32", "minSpeakers"?: n, "maxSpeakers"?: n}
// where the file holds raw little-endian float32 mono samples at 16 kHz. Replies one JSON line:
//   {"id": "...", "segments": [{"speaker": "S1", "start": 0.0, "end": 1.2}], "speakers": {"S1": [embedding]}}
// or {"id": "...", "error": "..."}. Prints {"ready": true} once models are loaded.
import FluidAudio
import Foundation

struct Request: Decodable {
    let id: String
    let audio: String
    let minSpeakers: Int?
    let maxSpeakers: Int?
}

struct Segment: Encodable {
    let speaker: String
    let start: Double
    let end: Double
}

struct Reply: Encodable {
    let id: String
    var segments: [Segment]? = nil
    var speakers: [String: [Float]]? = nil
    var error: String? = nil
}

func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func readSamples(_ path: String) throws -> [Float] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return data.withUnsafeBytes { raw in
        Array(raw.bindMemory(to: Float.self))
    }
}

@main
struct Main {
    static func main() async {
        var base = OfflineDiarizerConfig.default
        let manager = OfflineDiarizerManager(config: base)
        do {
            try await manager.prepareModels()
        } catch {
            emit(StartupFailure(error: "\(error)"))
            exit(1)
        }
        FileHandle.standardOutput.write(Data("{\"ready\":true}\n".utf8))

        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
            guard let req = try? JSONDecoder().decode(Request.self, from: data) else {
                emit(Reply(id: "", error: "bad request"))
                continue
            }
            do {
                let samples = try readSamples(req.audio)
                var runner = manager
                if req.minSpeakers != nil || req.maxSpeakers != nil {
                    base = OfflineDiarizerConfig.default
                    base.clustering.minSpeakers = req.minSpeakers
                    base.clustering.maxSpeakers = req.maxSpeakers
                    runner = OfflineDiarizerManager(config: base)
                    try await runner.prepareModels()
                }
                let result = try await runner.process(audio: samples)
                let segments = result.segments.map {
                    Segment(speaker: $0.speakerId, start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds))
                }
                emit(Reply(id: req.id, segments: segments, speakers: result.speakerDatabase))
            } catch {
                emit(Reply(id: req.id, error: "\(error)"))
            }
        }
    }
}

struct StartupFailure: Encodable {
    var ready = false
    let error: String
}
