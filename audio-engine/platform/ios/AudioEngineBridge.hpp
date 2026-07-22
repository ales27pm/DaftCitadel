#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include "audio_engine/SceneGraph.h"

namespace daft::audio::bridge {

class AudioEngineBridge {
 public:
  using EngineGeneration = std::uint64_t;

  struct RenderDiagnostics {
    std::uint64_t xruns;
    double lastRenderDurationMicros;
    std::size_t clipBufferBytes;
    bool initialized;
  };

  struct TransportState {
    std::uint64_t currentFrame;
    bool isPlaying;
  };

  struct ClipBuffer {
    double sampleRate = 0.0;
    std::size_t frameCount = 0;
    std::vector<std::vector<float>> channelSamples;

    [[nodiscard]] std::size_t channelCount() const { return channelSamples.size(); }
    [[nodiscard]] std::span<const float> channel(std::size_t index) const {
      if (index >= channelSamples.size()) {
        return {};
      }
      return std::span<const float>(channelSamples[index].data(), channelSamples[index].size());
    }
  };

  static EngineGeneration initialize(double sampleRate, std::uint32_t framesPerBuffer);
  static bool shutdownIfOwner(EngineGeneration generation) noexcept;
  static bool isInitialized(EngineGeneration generation);
  static void render(EngineGeneration generation, float** outputs, std::size_t channelCount,
                     std::size_t frameCount);
  static void startTransport(EngineGeneration generation);
  static void stopTransport(EngineGeneration generation);
  static void locateTransport(EngineGeneration generation, std::uint64_t frame);
  static TransportState getTransportState(EngineGeneration generation);

  static bool addNode(EngineGeneration generation, const std::string& id,
                      std::unique_ptr<DSPNode> node);
  static void removeNode(EngineGeneration generation, const std::string& id);
  static bool connect(EngineGeneration generation, const std::string& source,
                      const std::string& destination);
  static void disconnect(EngineGeneration generation, const std::string& source,
                         const std::string& destination);
  static void scheduleParameterAutomation(EngineGeneration generation,
                                          const std::string& nodeId,
                                          const std::string& parameter,
                                          std::uint64_t frame, double value);
  static bool registerClipBuffer(EngineGeneration generation, const std::string& key,
                                 double sampleRate, std::size_t channelCount,
                                 std::size_t frameCount,
                                 std::vector<std::vector<float>> channelData);
  static bool unregisterClipBuffer(EngineGeneration generation, const std::string& key);
  static std::shared_ptr<const ClipBuffer> clipBufferForKey(EngineGeneration generation,
                                                            const std::string& key);
  static RenderDiagnostics getDiagnostics(EngineGeneration generation);

 private:
  struct ClipBufferEntry {
    std::shared_ptr<ClipBuffer> buffer;
    std::size_t referenceCount = 0;
    std::size_t byteSize = 0;
  };

  static bool ownsGenerationLocked(EngineGeneration generation) noexcept;
  static void requireGenerationLocked(EngineGeneration generation);

  static std::unique_ptr<SceneGraph> graph_;
  static std::mutex mutex_;
  static std::atomic<std::uint64_t> xruns_;
  static std::atomic<double> lastRenderDurationMicros_;
  static bool isPlaying_;
  static std::atomic<EngineGeneration> generation_;
  static std::unordered_map<std::string, ClipBufferEntry> clipBuffers_;
};

}  // namespace daft::audio::bridge
