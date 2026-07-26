#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/Clock.h"
#include "audio_engine/DSPNode.h"
#include "audio_engine/RealtimeControlCommand.h"
#include "audio_engine/instruments/InstrumentNode.h"

namespace daft::audio {

class SceneGraph {
 public:
  /** Construct a graph configured for the platform render callback. */
  explicit SceneGraph(double sampleRate, std::uint32_t framesPerBuffer);

  /** Add or remove uniquely identified DSP nodes while rendering is stopped. */
  bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  void removeNode(const std::string& id);

  /** Connect nodes, including the reserved output-bus destination. */
  bool connect(const std::string& source, const std::string& destination);
  void disconnect(const std::string& source, const std::string& destination);

  /** Render one planar buffer and advance the transport clock. */
  void render(AudioBufferView outputBuffer) noexcept;
  void locate(std::uint64_t frame) noexcept;

  /** Configure a native, half-open transport loop [startFrame, endFrame). */
  void setTransportLoop(std::uint64_t startFrame, std::uint64_t endFrame,
                        bool enabled);

  /** Resolve human-readable identifiers before crossing the realtime boundary. */
  [[nodiscard]] RealtimeNodeId resolveRealtimeNodeId(
      const std::string& nodeId) const noexcept;
  [[nodiscard]] std::optional<NodeParameterId> resolveNodeParameterId(
      RealtimeNodeId nodeId, std::string_view parameter) const noexcept;
  [[nodiscard]] bool validateInstrumentEvent(
      RealtimeNodeId nodeId, const InstrumentEvent& event) const noexcept;

  /** Apply already-resolved control records on the realtime consumer lane. */
  [[nodiscard]] bool applyRealtimeCommand(
      const RealtimeControlCommand& command) noexcept;
  [[nodiscard]] bool applyRealtimeInstrumentBatch(
      RealtimeNodeId nodeId, std::span<const InstrumentEvent> events,
      bool replace) noexcept;

  /** Schedule compact node-parameter automation without callbacks or strings. */
  void scheduleParameterAutomation(const std::string& nodeId,
                                   const std::string& parameter,
                                   std::uint64_t frame, double value);
  [[nodiscard]] bool scheduleParameterAutomation(
      RealtimeNodeId nodeId, NodeParameterId parameterId,
      std::uint64_t frame, double value) noexcept;

  /** Queue bounded, sample-accurate events on an instrument node. */
  void scheduleInstrumentEvents(const std::string& nodeId,
                                std::span<const InstrumentEvent> events,
                                bool replace = false);
  [[nodiscard]] bool scheduleInstrumentEvent(
      RealtimeNodeId nodeId, const InstrumentEvent& event) noexcept;
  void setInstrumentParameter(const std::string& nodeId,
                              std::uint16_t parameter, float value);
  [[nodiscard]] bool setInstrumentParameter(
      RealtimeNodeId nodeId, std::uint16_t parameter,
      float value) noexcept;
  void allNotesOff(const std::string& nodeId);
  [[nodiscard]] bool allNotesOff(RealtimeNodeId nodeId) noexcept;
  void allNotesOff() noexcept;
  void panicInstruments() noexcept;

  [[nodiscard]] double sampleRate() const noexcept { return sampleRate_; }
  [[nodiscard]] std::uint64_t currentFrame() const noexcept {
    return clock_.frameTime();
  }
  [[nodiscard]] std::size_t activeInstrumentVoiceCount() const noexcept;
  [[nodiscard]] std::size_t pendingInstrumentEventCount() const noexcept;
  [[nodiscard]] std::uint64_t realtimeCommandFailureCount() const noexcept {
    return realtimeCommandFailures_.load(std::memory_order_relaxed);
  }

  static constexpr std::string_view kOutputBusId = "__output__";

  static constexpr std::size_t maxSupportedChannels() noexcept {
    return kMaxChannels;
  }
  static constexpr std::size_t maxSupportedFramesPerBuffer() noexcept {
    return kMaxFrames;
  }

 private:
  static constexpr std::size_t kMaxChannels = 4;
  static constexpr std::size_t kMaxFrames = 1024;
  static constexpr std::size_t kParameterAutomationCapacity = 128;

  struct Connection {
    std::string source;
    std::string destination;
  };

  struct ScheduledNodeParameter {
    std::uint64_t frame = 0U;
    RealtimeNodeId nodeId = kInvalidRealtimeNodeId;
    NodeParameterId parameterId = kInvalidNodeParameterId;
    double value = 0.0;
  };

  struct NodeBuffer {
    StackAudioBuffer<kMaxChannels, kMaxFrames> storage{};
    std::array<float*, kMaxChannels> channelPointers{};

    void configure(std::size_t channelCount, std::size_t frameCount) noexcept {
      storage.setFrameCount(frameCount);
      for (std::size_t ch = 0; ch < kMaxChannels; ++ch) {
        channelPointers[ch] =
            ch < channelCount ? storage.channel(ch) : nullptr;
      }
    }

    [[nodiscard]] AudioBufferView view(
        std::size_t channelCount) noexcept {
      return AudioBufferView(channelPointers.data(), channelCount,
                             storage.frameCount());
    }
  };

  [[nodiscard]] DSPNode* nodeForRealtimeId(
      RealtimeNodeId nodeId) const noexcept;
  [[nodiscard]] InstrumentNode* instrumentForRealtimeId(
      RealtimeNodeId nodeId) const noexcept;
  [[nodiscard]] bool setTransportLoopState(
      std::uint64_t startFrame, std::uint64_t endFrame,
      bool enabled) noexcept;
  [[nodiscard]] bool insertParameterAutomation(
      const ScheduledNodeParameter& event) noexcept;
  void dispatchDueParameterAutomation() noexcept;
  void discardAutomationForNode(RealtimeNodeId nodeId) noexcept;

  [[nodiscard]] bool wouldIntroduceCycle(const std::string& source,
                                         const std::string& destination) const;
  void rebuildTopology();
  void ensureNodeBuffers(std::size_t channelCount,
                         std::size_t frameCount) noexcept;
  void renderSection(AudioBufferView outputBuffer, std::size_t frameOffset,
                     std::size_t frameCount) noexcept;
  void rewindTransportLoop() noexcept;

  double sampleRate_;
  std::unordered_map<std::string, std::unique_ptr<DSPNode>> nodes_;
  std::unordered_map<std::string, RealtimeNodeId> realtimeNodeIds_;
  // Index zero is permanently invalid. Removed handles are nulled and never
  // reused, so delayed commands cannot target a replacement with the same name.
  std::vector<DSPNode*> realtimeNodes_{nullptr};
  std::vector<InstrumentNode*> realtimeInstruments_{nullptr};
  std::vector<Connection> connections_;
  RenderClock clock_;
  std::array<ScheduledNodeParameter, kParameterAutomationCapacity>
      parameterAutomation_{};
  std::size_t parameterAutomationCount_ = 0U;
  std::atomic<std::uint64_t> realtimeCommandFailures_{0U};
  std::unordered_map<std::string, NodeBuffer> nodeBuffers_;
  std::vector<std::string> renderOrder_;
  std::unordered_map<std::string, std::vector<std::string>> inboundEdges_;
  std::vector<std::string> outputSources_;
  std::uint64_t loopStartFrame_ = 0;
  std::uint64_t loopEndFrame_ = 0;
  bool transportLoopEnabled_ = false;
};

}  // namespace daft::audio
