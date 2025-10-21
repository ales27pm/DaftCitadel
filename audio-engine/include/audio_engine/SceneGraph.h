#pragma once

#include <array>
#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/DSPNode.h"
#include "audio_engine/Scheduler.h"

namespace daft::audio {

class SceneGraph {
 public:
  explicit SceneGraph(double sampleRate);

  bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  void removeNode(const std::string& id);
  bool connect(const std::string& source, const std::string& destination);
  void disconnect(const std::string& source, const std::string& destination);

  void render(AudioBufferView outputBuffer);
  void scheduleAutomation(const std::string& nodeId, std::function<void(DSPNode&)> cb,
                          std::uint64_t frame);

  [[nodiscard]] double sampleRate() const { return sampleRate_; }

  static constexpr std::string_view kOutputBusId = "__output__";

 private:
  static constexpr std::size_t kMaxChannels = 4;
  static constexpr std::size_t kMaxFrames = 1024;

  struct Connection {
    std::string source;
    std::string destination;
  };

  struct NodeBuffer {
    StackAudioBuffer<kMaxChannels, kMaxFrames> storage{};
    std::array<float*, kMaxChannels> channelPointers{};

    void configure(std::size_t channelCount, std::size_t frameCount) {
      storage.setFrameCount(frameCount);
      for (std::size_t ch = 0; ch < channelCount; ++ch) {
        channelPointers[ch] = storage.channel(ch);
      }
    }

    [[nodiscard]] AudioBufferView view(std::size_t channelCount) {
      return AudioBufferView(channelPointers.data(), channelCount, storage.frameCount());
    }
  };

  double sampleRate_;
  std::unordered_map<std::string, std::unique_ptr<DSPNode>> nodes_;
  std::vector<Connection> connections_;
  RenderClock clock_;
  RealTimeScheduler<128> scheduler_;
  std::unordered_map<std::string, NodeBuffer> nodeBuffers_;
};

}  // namespace daft::audio
