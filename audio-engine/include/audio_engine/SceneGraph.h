#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/DSPNode.h"
#include "audio_engine/Scheduler.h"
#include "audio_engine/Clock.h"

namespace daft::audio {

class SceneGraph {
 public:
  /** Construct a graph configured for the platform render callback. */
  explicit SceneGraph(double sampleRate, std::uint32_t framesPerBuffer);

  /** Add or remove uniquely identified DSP nodes. */
  bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  void removeNode(const std::string& id);

  /** Connect nodes, including the reserved output-bus destination. */
  bool connect(const std::string& source, const std::string& destination);
  void disconnect(const std::string& source, const std::string& destination);

  /** Render one planar buffer and advance the transport clock. */
  void render(AudioBufferView outputBuffer);
  void locate(std::uint64_t frame);

  /** Schedule a node lookup and callback at an absolute transport frame. */
  void scheduleAutomation(const std::string& nodeId, std::function<void(DSPNode&)> cb,
                          std::uint64_t frame);

  [[nodiscard]] double sampleRate() const { return sampleRate_; }
  [[nodiscard]] std::uint64_t currentFrame() const { return clock_.frameTime(); }

  static constexpr std::string_view kOutputBusId = "__output__";

  static constexpr std::size_t maxSupportedChannels() { return kMaxChannels; }
  static constexpr std::size_t maxSupportedFramesPerBuffer() { return kMaxFrames; }

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
      for (std::size_t ch = 0; ch < kMaxChannels; ++ch) {
        channelPointers[ch] = ch < channelCount ? storage.channel(ch) : nullptr;
      }
    }

    [[nodiscard]] AudioBufferView view(std::size_t channelCount) {
      return AudioBufferView(channelPointers.data(), channelCount, storage.frameCount());
    }
  };

  double sampleRate_;
  std::unordered_map<std::string, std::unique_ptr<DSPNode>> nodes_;
  // Scheduled callbacks resolve nodes lazily. The incarnation prevents an event
  // queued for a removed node from targeting a later node that reuses its ID.
  std::unordered_map<std::string, std::uint64_t> nodeIncarnations_;
  std::uint64_t nextNodeIncarnation_ = 1;
  std::vector<Connection> connections_;
  RenderClock clock_;
  RealTimeScheduler<128> scheduler_;
  std::unordered_map<std::string, NodeBuffer> nodeBuffers_;
  std::vector<std::string> renderOrder_;
  std::unordered_map<std::string, std::vector<std::string>> inboundEdges_;
  std::vector<std::string> outputSources_;

  [[nodiscard]] bool wouldIntroduceCycle(const std::string& source,
                                         const std::string& destination) const;
  void rebuildTopology();
  void ensureNodeBuffers(std::size_t channelCount, std::size_t frameCount);
};

}  // namespace daft::audio
