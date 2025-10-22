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
  struct RenderDiagnostics {
    std::uint64_t xruns;
    double lastRenderDurationMicros;
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

  static void initialize(double sampleRate, std::uint32_t framesPerBuffer);
  static void shutdown();
  static void render(float** outputs, std::size_t channelCount, std::size_t frameCount);

  static bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  static void removeNode(const std::string& id);
  static bool connect(const std::string& source, const std::string& destination);
  static void disconnect(const std::string& source, const std::string& destination);
  static void scheduleParameterAutomation(const std::string& nodeId, const std::string& parameter,
                                          std::uint64_t frame, double value);
  static bool registerClipBuffer(const std::string& key, double sampleRate, std::size_t channelCount,
                                 std::size_t frameCount, std::vector<std::vector<float>> channelData);
  static std::shared_ptr<const ClipBuffer> clipBufferForKey(const std::string& key);
  static RenderDiagnostics getDiagnostics();

 private:
  static std::unique_ptr<SceneGraph> graph_;
  static std::mutex mutex_;
  static std::atomic<std::uint64_t> xruns_;
  static std::atomic<double> lastRenderDurationMicros_;
  static std::unordered_map<std::string, std::shared_ptr<ClipBuffer>> clipBuffers_;
};

}  // namespace daft::audio::bridge
