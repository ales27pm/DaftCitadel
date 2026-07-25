#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/RealtimeControlCommand.h"
#include "audio_engine/RealtimeControlQueue.h"

namespace daft::audio {

class SceneGraph;

struct RealtimeControlDiagnostics {
  std::uint64_t xruns = 0U;
  std::uint64_t lastRenderMicros = 0U;
  std::size_t commandQueueDepth = 0U;
  std::uint64_t commandQueueOverflows = 0U;
  std::uint64_t commandFailures = 0U;
  std::size_t activeVoices = 0U;
  std::size_t pendingInstrumentEvents = 0U;
  RealtimeRenderStatisticsSnapshot renderStatistics{};
};

// One graph publication point and one fixed SPSC command boundary shared by the
// platform bridges. The callback never locks, allocates, logs, performs I/O, or
// handles exceptions. Control-side callers serialize producers with their
// existing platform mutex, preserving the single-producer contract.
class RealtimeControlPlane final {
 public:
  static constexpr std::size_t kCommandCapacity = 4096U;

  void publishGraph(SceneGraph* graph,
                    std::uint64_t publicationToken) noexcept;
  void setPlaying(bool playing) noexcept;
  [[nodiscard]] bool isPlaying() const noexcept;

  [[nodiscard]] bool enqueue(const RealtimeControlCommand& command) noexcept;
  [[nodiscard]] bool enqueueBatch(
      std::span<const RealtimeControlCommand> commands) noexcept;

  void render(AudioBufferView outputBuffer,
              std::uint64_t expectedPublicationToken) noexcept;

  // Control-thread lifecycle helpers. Call setPlaying(false) first; readers that
  // entered before the transition drain naturally, while later callbacks see
  // the stopped state and return silence without touching the graph.
  void waitUntilRenderIdle() const noexcept;
  void resetQuiescent() noexcept;
  void discardCommandsQuiescent() noexcept;

  [[nodiscard]] RealtimeControlDiagnostics diagnostics() const noexcept;

 private:
  RealtimeSpscQueue<RealtimeControlCommand, kCommandCapacity> commandQueue_{};
  std::atomic<SceneGraph*> publishedGraph_{nullptr};
  std::atomic<std::uint64_t> publicationToken_{0U};
  std::atomic<bool> playing_{false};
  std::atomic<std::uint32_t> renderReaders_{0U};
  std::atomic<std::uint64_t> xruns_{0U};
  std::atomic<std::uint64_t> lastRenderMicros_{0U};
  std::atomic<std::uint64_t> commandQueueOverflows_{0U};
  std::atomic<std::uint64_t> commandFailures_{0U};
  std::atomic<std::size_t> activeVoices_{0U};
  std::atomic<std::size_t> pendingInstrumentEvents_{0U};
  RealtimeRenderStatistics renderStatistics_{};
};

}  // namespace daft::audio
