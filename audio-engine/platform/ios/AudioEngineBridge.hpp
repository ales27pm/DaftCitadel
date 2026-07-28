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

#include "audio_engine/GraphTransactionHost.h"
#include "audio_engine/RealtimeControlPlane.h"
#include "audio_engine/SceneGraph.h"

namespace daft::audio::bridge {

class AudioEngineBridge {
 public:
  using EngineGeneration = std::uint64_t;

  struct RenderDiagnostics {
    std::uint64_t xruns = 0U;
    double lastRenderDurationMicros = 0.0;
    std::size_t clipBufferBytes = 0U;
    bool initialized = false;
    std::size_t activeVoices = 0U;
    std::size_t pendingInstrumentEvents = 0U;
    std::size_t realtimeQueueDepth = 0U;
    std::uint64_t realtimeQueueOverflows = 0U;
    std::uint64_t realtimeCommandFailures = 0U;
    std::uint64_t renderCount = 0U;
    double averageRenderDurationMicros = 0.0;
    double maximumRenderDurationMicros = 0.0;
    double p50RenderDurationMicros = 0.0;
    double p95RenderDurationMicros = 0.0;
    double p99RenderDurationMicros = 0.0;
  };

  struct TransportState {
    std::uint64_t currentFrame;
    bool isPlaying;
  };

  struct ClipBuffer {
    double sampleRate = 0.0;
    std::size_t frameCount = 0;
    std::vector<std::vector<float>> channelSamples;

    [[nodiscard]] std::size_t channelCount() const noexcept {
      return channelSamples.size();
    }
    [[nodiscard]] std::span<const float> channel(
        std::size_t index) const noexcept {
      if (index >= channelSamples.size()) {
        return {};
      }
      return std::span<const float>(channelSamples[index].data(),
                                    channelSamples[index].size());
    }
  };

  static EngineGeneration initialize(double sampleRate,
                                     std::uint32_t framesPerBuffer);
  static GraphApplyResult initializeGraphTransactions(
      EngineGeneration generation, double sampleRate,
      std::uint32_t framesPerBuffer);
  static GraphDescription describeGraph(
      EngineGeneration generation);
  static GraphApplyResult applyGraph(EngineGeneration generation,
                                     GraphApplyRequest request);
  static GraphApplyResult recoverAfterAudioConfigurationChange(
      EngineGeneration generation);
  static bool invalidateGraphTransactions(
      EngineGeneration generation) noexcept;
  static bool shutdownIfOwner(EngineGeneration generation) noexcept;
  static bool isInitialized(EngineGeneration generation);
  static void render(EngineGeneration generation, float** outputs,
                     std::size_t channelCount,
                     std::size_t frameCount) noexcept;
  static void startTransport(EngineGeneration generation);
  static void stopTransport(EngineGeneration generation);
  static void locateTransport(EngineGeneration generation,
                              std::uint64_t frame);
  static void setTransportLoop(EngineGeneration generation,
                               std::uint64_t startFrame,
                               std::uint64_t endFrame, bool enabled);
  static TransportState getTransportState(EngineGeneration generation);

  static bool addNode(EngineGeneration generation, const std::string& id,
                      std::unique_ptr<DSPNode> node);
  static void removeNode(EngineGeneration generation, const std::string& id);
  static bool connect(EngineGeneration generation, const std::string& source,
                      const std::string& destination);
  static void disconnect(EngineGeneration generation,
                         const std::string& source,
                         const std::string& destination);
  static void scheduleParameterAutomation(EngineGeneration generation,
                                          const std::string& nodeId,
                                          const std::string& parameter,
                                          std::uint64_t frame, double value);
  static void scheduleInstrumentEventFromNow(EngineGeneration generation,
                                             const std::string& nodeId,
                                             InstrumentEvent event,
                                             std::uint64_t frameOffset);
  static void scheduleInstrumentEvents(EngineGeneration generation,
                                       const std::string& nodeId,
                                       std::span<const InstrumentEvent> events,
                                       bool replace);
  static void allNotesOff(EngineGeneration generation,
                          const std::string& nodeId);
  static bool registerClipBuffer(EngineGeneration generation,
                                 const std::string& key, double sampleRate,
                                 std::size_t channelCount,
                                 std::size_t frameCount,
                                 std::vector<std::vector<float>> channelData);
  static bool unregisterClipBuffer(EngineGeneration generation,
                                   const std::string& key);
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
  static void requireTransportStoppedLocked();
  static void requireLegacyGraphMutationLocked();
  static void stopRealtimePlaneLocked() noexcept;
  [[nodiscard]] static RealtimeNodeId requireRealtimeNodeLocked(
      const std::string& nodeId);
  [[nodiscard]] static bool enqueueLocked(
      const RealtimeControlCommand& command) noexcept;

  static std::unique_ptr<SceneGraph> legacyGraph_;
  static std::unique_ptr<GraphTransactionHost> transactionHost_;
  static SceneGraph* graph_;
  static std::mutex mutex_;
  static RealtimeControlPlane realtimePlane_;
  static std::atomic<EngineGeneration> generation_;
  static std::unordered_map<std::string, ClipBufferEntry> clipBuffers_;
};

}  // namespace daft::audio::bridge
