#include "audio_engine/RealtimeControlPlane.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

#include "audio_engine/SceneGraph.h"
#include "audio_engine/instruments/juno/Juno106Node.h"

namespace daft::audio::tests {
namespace {

using juno::Juno106Node;
using juno::ParameterId;

class DynamicStereoBuffer final {
 public:
  explicit DynamicStereoBuffer(std::size_t frameCount)
      : left_(frameCount, 0.0F),
        right_(frameCount, 0.0F),
        channels_{left_.data(), right_.data()} {}

  [[nodiscard]] AudioBufferView view() noexcept {
    return {channels_.data(), channels_.size(), left_.size()};
  }

  [[nodiscard]] bool allFinite() const noexcept {
    const auto finite = [](float sample) { return std::isfinite(sample); };
    return std::all_of(left_.begin(), left_.end(), finite) &&
           std::all_of(right_.begin(), right_.end(), finite);
  }

  [[nodiscard]] bool isSilent() const noexcept {
    const auto silent = [](float sample) { return sample == 0.0F; };
    return std::all_of(left_.begin(), left_.end(), silent) &&
           std::all_of(right_.begin(), right_.end(), silent);
  }

 private:
  std::vector<float> left_;
  std::vector<float> right_;
  std::array<float*, 2U> channels_{};
};

[[nodiscard]] RealtimeControlCommand InstrumentCommand(
    RealtimeNodeId nodeId, InstrumentEventType type, std::uint64_t offset,
    std::uint8_t channel, std::uint8_t data, float value,
    std::uint16_t parameter = 0U) noexcept {
  RealtimeControlCommand command{};
  command.type = RealtimeCommandType::kScheduleInstrumentEvent;
  command.nodeId = nodeId;
  command.frame = offset;
  command.frameIsRelative = true;
  command.instrumentEvent.type = type;
  command.instrumentEvent.channel = channel;
  command.instrumentEvent.data = data;
  command.instrumentEvent.value = value;
  command.instrumentEvent.parameter = parameter;
  command.instrumentEvent.retainAcrossPanic = false;
  return command;
}

void EnqueueEventually(RealtimeControlPlane& plane,
                       const RealtimeControlCommand& command,
                       const std::atomic<bool>& failed) {
  while (!plane.enqueue(command)) {
    if (failed.load(std::memory_order_acquire)) {
      return;
    }
    std::this_thread::yield();
  }
}

void RunConcurrentRealtimeStress(std::size_t blockFrames) {
  constexpr std::size_t kBlockCount = 256U;
  SceneGraph graph(48000.0, static_cast<std::uint32_t>(blockFrames));
  auto juno = std::make_unique<Juno106Node>(
      static_cast<std::uint32_t>(blockFrames), 6U);
  if (!juno->setParameter(ParameterId::kReleaseSeconds, 0.0005F) ||
      !juno->setParameter(ParameterId::kOutputGain, 0.2F) ||
      !graph.addNode("juno", std::move(juno)) ||
      !graph.connect("juno", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Unable to build realtime control-plane stress graph");
  }
  const auto nodeId = graph.resolveRealtimeNodeId("juno");
  if (nodeId == kInvalidRealtimeNodeId) {
    throw std::runtime_error("Realtime stress node did not receive a numeric handle");
  }

  RealtimeControlPlane plane;
  plane.publishGraph(&graph, 1U);
  plane.setPlaying(true);

  std::atomic<std::size_t> producedBlocks{0U};
  std::atomic<std::size_t> renderedBlocks{0U};
  std::atomic<bool> failed{false};

  std::thread producer([&]() {
    for (std::size_t block = 0U; block < kBlockCount; ++block) {
      while (renderedBlocks.load(std::memory_order_acquire) < block) {
        if (failed.load(std::memory_order_acquire)) {
          return;
        }
        std::this_thread::yield();
      }

      const auto channel = static_cast<std::uint8_t>(block % 4U);
      const auto note = static_cast<std::uint8_t>(48U + block % 24U);
      const auto releaseOffset =
          static_cast<std::uint64_t>(std::max<std::size_t>(1U, blockFrames / 2U));
      const float pressure = static_cast<float>(block % 11U) / 10.0F;
      const float bend =
          static_cast<float>(static_cast<int>(block % 17U) - 8) / 8.0F;

      const std::array<RealtimeControlCommand, 8U> commands = {{
          InstrumentCommand(nodeId, InstrumentEventType::kControlChange, 0U,
                            channel, 64U, 1.0F),
          InstrumentCommand(nodeId, InstrumentEventType::kNoteOn, 1U,
                            channel, note, 0.8F),
          InstrumentCommand(nodeId, InstrumentEventType::kPitchBend, 2U,
                            channel, 0U, bend),
          InstrumentCommand(nodeId,
                            InstrumentEventType::kChannelAftertouch, 3U,
                            channel, 0U, pressure),
          InstrumentCommand(nodeId, InstrumentEventType::kPolyAftertouch, 4U,
                            channel, note, 1.0F - pressure),
          InstrumentCommand(
              nodeId, InstrumentEventType::kParameter, 5U, 0U, 0U,
              200.0F + static_cast<float>(block % 100U) * 100.0F,
              static_cast<std::uint16_t>(ParameterId::kCutoffHz)),
          InstrumentCommand(nodeId, InstrumentEventType::kNoteOff,
                            releaseOffset, channel, note, 0.0F),
          InstrumentCommand(nodeId, InstrumentEventType::kControlChange,
                            releaseOffset + 1U, channel, 64U, 0.0F),
      }};
      for (const auto& command : commands) {
        EnqueueEventually(plane, command, failed);
        if (failed.load(std::memory_order_acquire)) {
          return;
        }
      }
      producedBlocks.store(block + 1U, std::memory_order_release);
    }
  });

  DynamicStereoBuffer buffer(blockFrames);
  for (std::size_t block = 0U; block < kBlockCount; ++block) {
    while (producedBlocks.load(std::memory_order_acquire) <= block) {
      if (failed.load(std::memory_order_acquire)) {
        break;
      }
      std::this_thread::yield();
    }
    plane.render(buffer.view(), 1U);
    if (!buffer.allFinite()) {
      failed.store(true, std::memory_order_release);
      break;
    }
    renderedBlocks.store(block + 1U, std::memory_order_release);
  }
  producer.join();

  if (failed.load(std::memory_order_acquire)) {
    throw std::runtime_error(
        "Concurrent realtime control stress produced invalid audio");
  }

  RealtimeControlCommand panic{};
  panic.type = RealtimeCommandType::kPanicAllInstruments;
  if (!plane.enqueue(panic)) {
    throw std::runtime_error("Realtime panic command was rejected");
  }
  plane.render(buffer.view(), 1U);
  const auto diagnostics = plane.diagnostics();
  if (!buffer.isSilent() || diagnostics.activeVoices != 0U ||
      diagnostics.pendingInstrumentEvents != 0U ||
      diagnostics.commandFailures != 0U ||
      diagnostics.renderStatistics.renderCount != kBlockCount + 1U) {
    throw std::runtime_error(
        "Realtime panic did not leave the instrument in a clean state");
  }

  const double bufferBudgetMicros =
      static_cast<double>(blockFrames) / 48000.0 * 1'000'000.0;
  std::cout << "REALTIME_CONTROL_P99_US="
            << diagnostics.renderStatistics.p99RenderMicros
            << " block_frames=" << blockFrames
            << " budget_us=" << bufferBudgetMicros
            << " xruns=" << diagnostics.xruns << '\n';

  plane.setPlaying(false);
  plane.waitUntilRenderIdle();
  const auto stoppedFrame = graph.currentFrame();
  plane.render(buffer.view(), 1U);
  if (!buffer.isSilent() || graph.currentFrame() != stoppedFrame) {
    throw std::runtime_error(
        "Stopped realtime control plane touched the graph or emitted audio");
  }
}

void TestControlledQueueSaturation() {
  SceneGraph graph(48000.0, 128U);
  RealtimeControlPlane plane;
  plane.publishGraph(&graph, 7U);
  plane.setPlaying(true);

  RealtimeControlCommand command{};
  command.type = RealtimeCommandType::kPanicAllInstruments;
  for (std::size_t index = 0U;
       index < RealtimeControlPlane::kCommandCapacity; ++index) {
    if (!plane.enqueue(command)) {
      throw std::runtime_error(
          "Realtime command queue rejected an in-capacity command");
    }
  }
  if (plane.enqueue(command)) {
    throw std::runtime_error(
        "Realtime command queue accepted a command beyond fixed capacity");
  }
  const auto saturated = plane.diagnostics();
  if (saturated.commandQueueDepth !=
          RealtimeControlPlane::kCommandCapacity ||
      saturated.commandQueueOverflows != 1U) {
    throw std::runtime_error(
        "Realtime command queue saturation diagnostics are incorrect");
  }

  plane.setPlaying(false);
  plane.waitUntilRenderIdle();
  plane.discardCommandsQuiescent();
  if (plane.diagnostics().commandQueueDepth != 0U) {
    throw std::runtime_error(
        "Realtime command queue did not clear while quiescent");
  }
}

void TestStalePublicationTokenCannotRenderReplacementGraph() {
  SceneGraph graph(48000.0, 128U);
  RealtimeControlPlane plane;
  plane.publishGraph(&graph, 11U);
  plane.setPlaying(true);

  DynamicStereoBuffer buffer(128U);
  plane.render(buffer.view(), 10U);
  if (!buffer.isSilent() || graph.currentFrame() != 0U) {
    throw std::runtime_error(
        "Stale publication token rendered the replacement graph");
  }
}

}  // namespace

void RunRealtimeControlPlaneTests() {
  RunConcurrentRealtimeStress(128U);
  RunConcurrentRealtimeStress(256U);
  TestControlledQueueSaturation();
  TestStalePublicationTokenCannotRenderReplacementGraph();
}

}  // namespace daft::audio::tests
