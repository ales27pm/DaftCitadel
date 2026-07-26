#pragma once

#include <jni.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include "audio_engine/RealtimeControlPlane.h"
#include "audio_engine/SceneGraph.h"

namespace daft::audio::bridge {

class AudioEngineBridge {
 public:
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

  static void initialize(JNIEnv* env, double sampleRate,
                         std::uint32_t framesPerBuffer);
  static void shutdown();
  static void render(float** outputs, std::size_t channelCount,
                     std::size_t frameCount) noexcept;
  static void startTransport();
  static void stopTransport();
  static void locateTransport(std::uint64_t frame);
  static void setTransportLoop(std::uint64_t startFrame,
                               std::uint64_t endFrame, bool enabled);
  static TransportState getTransportState();

  static bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  static void removeNode(const std::string& id);
  static bool connect(const std::string& source,
                      const std::string& destination);
  static void disconnect(const std::string& source,
                         const std::string& destination);
  static void scheduleParameterAutomation(const std::string& nodeId,
                                          const std::string& parameter,
                                          std::uint64_t frame, double value);
  static void scheduleInstrumentEventFromNow(const std::string& nodeId,
                                             InstrumentEvent event,
                                             std::uint64_t frameOffset);
  static void scheduleInstrumentEvents(const std::string& nodeId,
                                       std::span<const InstrumentEvent> events,
                                       bool replace);
  static void allNotesOff(const std::string& nodeId);
  static bool registerClipBuffer(
      const std::string& key, double sampleRate, std::size_t channelCount,
      std::size_t frameCount,
      std::vector<std::vector<float>> channelData);
  static bool unregisterClipBuffer(const std::string& key);
  static std::shared_ptr<const ClipBuffer> clipBufferForKey(
      const std::string& key);
  static RenderDiagnostics getDiagnostics();

 private:
  struct ClipBufferEntry {
    std::shared_ptr<ClipBuffer> buffer;
    std::size_t referenceCount = 0;
    std::size_t byteSize = 0;
  };

  static void requireInitializedLocked();
  static void requireTransportStoppedLocked();
  static void stopRealtimePlaneLocked() noexcept;
  [[nodiscard]] static RealtimeNodeId requireRealtimeNodeLocked(
      const std::string& nodeId);
  [[nodiscard]] static bool enqueueLocked(
      const RealtimeControlCommand& command) noexcept;

  static std::unique_ptr<SceneGraph> graph_;
  static std::mutex mutex_;
  static RealtimeControlPlane realtimePlane_;
  static std::atomic<std::uint64_t> publicationToken_;
  static std::unordered_map<std::string, ClipBufferEntry> clipBuffers_;
};

}  // namespace daft::audio::bridge
