#include "audio_engine/RealtimeControlPlane.h"

#include <chrono>
#include <limits>
#include <thread>

#include "audio_engine/SceneGraph.h"

namespace daft::audio {
namespace {

class RenderReaderLease final {
 public:
  explicit RenderReaderLease(
      std::atomic<std::uint32_t>& readers) noexcept
      : readers_(readers) {
    readers_.fetch_add(1U, std::memory_order_acq_rel);
  }

  ~RenderReaderLease() noexcept {
    readers_.fetch_sub(1U, std::memory_order_acq_rel);
  }

  RenderReaderLease(const RenderReaderLease&) = delete;
  RenderReaderLease& operator=(const RenderReaderLease&) = delete;

 private:
  std::atomic<std::uint32_t>& readers_;
};

[[nodiscard]] std::uint64_t SaturatingAdd(std::uint64_t value,
                                           std::uint64_t increment) noexcept {
  const auto maximum = std::numeric_limits<std::uint64_t>::max();
  return increment > maximum - value ? maximum : value + increment;
}

}  // namespace

void RealtimeControlPlane::publishGraph(
    SceneGraph* graph, std::uint64_t publicationToken) noexcept {
  publishedGraph_.store(graph, std::memory_order_relaxed);
  publicationToken_.store(publicationToken, std::memory_order_release);
}

void RealtimeControlPlane::setPlaying(bool playing) noexcept {
  playing_.store(playing, std::memory_order_release);
}

bool RealtimeControlPlane::isPlaying() const noexcept {
  return playing_.load(std::memory_order_acquire);
}

bool RealtimeControlPlane::enqueue(
    const RealtimeControlCommand& command) noexcept {
  if (commandQueue_.tryPush(command)) {
    return true;
  }
  commandQueueOverflows_.fetch_add(1U, std::memory_order_relaxed);
  return false;
}

bool RealtimeControlPlane::enqueueBatch(
    std::span<const RealtimeControlCommand> commands) noexcept {
  if (commandQueue_.tryPushBatch(commands)) {
    return true;
  }
  commandQueueOverflows_.fetch_add(
      static_cast<std::uint64_t>(commands.size()),
      std::memory_order_relaxed);
  return false;
}

bool RealtimeControlPlane::consumeInstrumentBatch(
    SceneGraph& graph, const RealtimeControlCommand& header) noexcept {
  const auto eventCount = static_cast<std::size_t>(header.batchSize);
  if (header.nodeId == kInvalidRealtimeNodeId || eventCount == 0U ||
      eventCount > instrumentBatchScratch_.size()) {
    commandQueue_.discardPublishedFromConsumer();
    return false;
  }

  bool valid = true;
  for (std::size_t index = 0U; index < eventCount; ++index) {
    RealtimeControlCommand eventCommand{};
    if (!commandQueue_.tryPop(eventCommand)) {
      commandQueue_.discardPublishedFromConsumer();
      return false;
    }
    if (eventCommand.type !=
            RealtimeCommandType::kScheduleInstrumentEvent ||
        eventCommand.nodeId != header.nodeId) {
      valid = false;
      continue;
    }

    InstrumentEvent event = eventCommand.instrumentEvent;
    event.frame = eventCommand.frameIsRelative
                      ? SaturatingAdd(graph.currentFrame(), eventCommand.frame)
                      : eventCommand.frame;
    if (eventCommand.frameIsRelative) {
      event.retainAcrossPanic = false;
    }
    instrumentBatchScratch_[index] = event;
  }

  return valid && graph.applyRealtimeInstrumentBatch(
                      header.nodeId,
                      std::span<const InstrumentEvent>(
                          instrumentBatchScratch_.data(), eventCount),
                      header.replace);
}

void RealtimeControlPlane::render(
    AudioBufferView outputBuffer,
    std::uint64_t expectedPublicationToken) noexcept {
  outputBuffer.fill(0.0F);
  RenderReaderLease reader(renderReaders_);
  if (publicationToken_.load(std::memory_order_acquire) !=
          expectedPublicationToken ||
      !playing_.load(std::memory_order_acquire)) {
    return;
  }

  SceneGraph* const graph = publishedGraph_.load(std::memory_order_acquire);
  if (graph == nullptr) {
    xruns_.fetch_add(1U, std::memory_order_relaxed);
    return;
  }

  const auto started = std::chrono::steady_clock::now();
  RealtimeControlCommand command{};
  while (commandQueue_.tryPop(command)) {
    const bool applied =
        command.type == RealtimeCommandType::kScheduleInstrumentBatch
            ? consumeInstrumentBatch(*graph, command)
            : graph->applyRealtimeCommand(command);
    if (!applied) {
      commandFailures_.fetch_add(1U, std::memory_order_relaxed);
    }
  }

  graph->render(outputBuffer);
  const auto finished = std::chrono::steady_clock::now();
  const auto elapsedNanos =
      std::chrono::duration_cast<std::chrono::nanoseconds>(finished - started)
          .count();
  const auto elapsedMicros = static_cast<std::uint64_t>(
      elapsedNanos <= 0 ? 0 : (elapsedNanos + 999) / 1000);

  lastRenderMicros_.store(elapsedMicros, std::memory_order_relaxed);
  renderStatistics_.record(elapsedMicros);
  activeVoices_.store(graph->activeInstrumentVoiceCount(),
                      std::memory_order_relaxed);
  pendingInstrumentEvents_.store(graph->pendingInstrumentEventCount(),
                                 std::memory_order_relaxed);

  const double sampleRate = graph->sampleRate();
  if (sampleRate > 0.0) {
    const double callbackBudgetMicros =
        static_cast<double>(outputBuffer.frameCount()) / sampleRate *
        1'000'000.0;
    if (static_cast<double>(elapsedMicros) > callbackBudgetMicros) {
      xruns_.fetch_add(1U, std::memory_order_relaxed);
    }
  }
}

void RealtimeControlPlane::waitUntilRenderIdle() const noexcept {
  while (renderReaders_.load(std::memory_order_acquire) != 0U) {
    std::this_thread::yield();
  }
}

void RealtimeControlPlane::resetQuiescent() noexcept {
  commandQueue_.resetQuiescent();
  xruns_.store(0U, std::memory_order_relaxed);
  lastRenderMicros_.store(0U, std::memory_order_relaxed);
  commandQueueOverflows_.store(0U, std::memory_order_relaxed);
  commandFailures_.store(0U, std::memory_order_relaxed);
  activeVoices_.store(0U, std::memory_order_relaxed);
  pendingInstrumentEvents_.store(0U, std::memory_order_relaxed);
  renderStatistics_.resetQuiescent();
}

void RealtimeControlPlane::discardCommandsQuiescent() noexcept {
  commandQueue_.resetQuiescent();
}

RealtimeControlDiagnostics RealtimeControlPlane::diagnostics() const noexcept {
  RealtimeControlDiagnostics result{};
  result.xruns = xruns_.load(std::memory_order_acquire);
  result.lastRenderMicros =
      lastRenderMicros_.load(std::memory_order_acquire);
  result.commandQueueDepth = commandQueue_.sizeApprox();
  result.commandQueueOverflows =
      commandQueueOverflows_.load(std::memory_order_acquire);
  result.commandFailures =
      commandFailures_.load(std::memory_order_acquire);
  result.activeVoices = activeVoices_.load(std::memory_order_acquire);
  result.pendingInstrumentEvents =
      pendingInstrumentEvents_.load(std::memory_order_acquire);
  result.renderStatistics = renderStatistics_.snapshot();
  return result;
}

}  // namespace daft::audio
