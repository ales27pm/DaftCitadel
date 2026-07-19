import AVFoundation
import Foundation
import React

@objc(AudioSampleLoaderModule)
public final class AudioSampleLoaderModule: NSObject {
  private let decodeQueue = DispatchQueue(
    label: "dev.daftcitadel.audio-sample-loader",
    qos: .userInitiated
  )

  @objc
  public static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(decode:resolver:rejecter:)
  public func decode(
    _ filePath: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let normalizedPath = (filePath as String).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedPath.isEmpty else {
      reject("invalid_path", "Audio file path is required", nil)
      return
    }

    decodeQueue.async {
      do {
        let url = try self.resolveURL(normalizedPath)
        let file = try AVAudioFile(
          forReading: url,
          commonFormat: .pcmFormatFloat32,
          interleaved: false
        )
        guard file.length > 0, file.length <= Self.maxFrames else {
          throw DecodeError.invalidFrameCount(file.length)
        }
        let channelCount = Int(file.processingFormat.channelCount)
        guard channelCount > 0, channelCount <= Self.maxChannels else {
          throw DecodeError.invalidChannelCount(channelCount)
        }
        let frameCount = Int(file.length)
        let (sampleCount, sampleCountOverflow) = frameCount.multipliedReportingOverflow(
          by: channelCount
        )
        let (decodedByteCount, byteCountOverflow) = sampleCount.multipliedReportingOverflow(
          by: MemoryLayout<Float>.size
        )
        guard !sampleCountOverflow,
              !byteCountOverflow,
              decodedByteCount <= Self.maxDecodedPCMBytes else {
          throw DecodeError.decodedAudioTooLarge
        }
        let capacity = AVAudioFrameCount(file.length)
        guard let buffer = AVAudioPCMBuffer(
          pcmFormat: file.processingFormat,
          frameCapacity: capacity
        ) else {
          throw DecodeError.bufferAllocationFailed
        }
        try file.read(into: buffer, frameCount: capacity)
        guard buffer.frameLength > 0, let floatData = buffer.floatChannelData else {
          throw DecodeError.unsupportedPCMFormat
        }
        let decodedFrameCount = Int(buffer.frameLength)
        let byteCount = decodedFrameCount * MemoryLayout<Float>.size
        var channels: [String] = []
        channels.reserveCapacity(channelCount)
        for channel in 0..<channelCount {
          channels.append(
            Data(bytes: floatData[channel], count: byteCount).base64EncodedString()
          )
        }
        resolve([
          "sampleRate": buffer.format.sampleRate,
          "channels": channelCount,
          "frames": decodedFrameCount,
          "channelData": channels,
        ])
      } catch {
        reject(
          "decode_failed",
          "Unable to decode '\(normalizedPath)': \(error.localizedDescription)",
          error
        )
      }
    }
  }

  private func resolveURL(_ path: String) throws -> URL {
    if let parsed = URL(string: path), parsed.isFileURL {
      return parsed
    }
    if path.hasPrefix("/") {
      return URL(fileURLWithPath: path)
    }
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent(path),
       FileManager.default.fileExists(atPath: bundled.path) {
      return bundled
    }
    let documents = try FileManager.default.url(
      for: .documentDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    return documents.appendingPathComponent(path)
  }

  private enum DecodeError: LocalizedError {
    case invalidFrameCount(AVAudioFramePosition)
    case invalidChannelCount(Int)
    case decodedAudioTooLarge
    case bufferAllocationFailed
    case unsupportedPCMFormat

    var errorDescription: String? {
      switch self {
      case .invalidFrameCount(let frames):
        return "Audio frame count \(frames) is outside engine limits"
      case .invalidChannelCount(let channels):
        return "Audio channel count \(channels) is outside the 1...\(AudioSampleLoaderModule.maxChannels) mobile limit"
      case .decodedAudioTooLarge:
        return "Decoded audio exceeds the \(AudioSampleLoaderModule.maxDecodedPCMBytes / 1_048_576) MB mobile PCM budget"
      case .bufferAllocationFailed:
        return "Unable to allocate an audio decode buffer"
      case .unsupportedPCMFormat:
        return "The decoded audio format is not non-interleaved Float32 PCM"
      }
    }
  }

  private static let maxFrames: AVAudioFramePosition = 10_000_000
  private static let maxChannels = 8
  private static let maxDecodedPCMBytes = 64 * 1024 * 1024
}
