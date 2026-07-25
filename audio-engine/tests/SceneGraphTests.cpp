#include "audio_engine/SceneGraph.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

#include "audio_engine/instruments/juno/Juno106Node.h"

namespace daft::audio::tests {
namespace {

class SilentNode final : public DSPNode {
 public:
  void process(AudioBufferView) noexcept override {}
  void setParameter(const std::string&, double) override {}
};

class ConstantNode final : public DSPNode {
 public:
  explicit ConstantNode(float value) : value_(value) {}

  void process(AudioBufferView buffer) noexcept override { buffer.fill(value_); }
  void setParameter(const std::string&, double value) override {
    value_ = static_cast<float>(value);
  }

 private:
  float value_;
};

class ParameterProbeNode final : public DSPNode {
 public:
  explicit ParameterProbeNode(int& updateCount) : updateCount_(updateCount) {}

  void process(AudioBufferView buffer) noexcept override { buffer.fill(value_); }
  void setParameter(const std::string& name, double value) override {
    const auto parameter = resolveParameterId(name);
    if (parameter) {
      (void)setParameterById(*parameter, value);
    }
  }
  [[nodiscard]] std::optional<NodeParameterId> resolveParameterId(
      std::string_view name) const noexcept override {
    return name == "value" ? std::optional<NodeParameterId>(1U)
                           : std::nullopt;
  }
  [[nodiscard]] bool setParameterById(NodeParameterId parameter,
                                      double value) noexcept override {
    if (parameter != 1U || !std::isfinite(value)) {
      return false;
    }
    value_ = static_cast<float>(value);
    ++updateCount_;
    return true;
  }

 private:
  int& updateCount_;
  float value_ = 0.0F;
};

class LocationTrackingNode final : public DSPNode {
 public:
  void locate(std::uint64_t frame) noexcept override { locatedFrame = frame; }
  void process(AudioBufferView) noexcept override {}
  void setParameter(const std::string&, double) override {}

  std::uint64_t locatedFrame = 0;
};

class LoopProbeInstrument final : public InstrumentNode {
 public:
  void setParameter(const std::string&, double) override {}
  void allNotesOff() noexcept override { value_ = 0.0F; }

  [[nodiscard]] std::size_t noteOnCount(std::uint8_t note) const noexcept {
    return noteOnCounts_[note];
  }

 protected:
  void prepareInstrument(double) override { value_ = 0.0F; }
  void resetInstrument() noexcept override { value_ = 0.0F; }

  void renderInstrument(AudioBufferView buffer, std::size_t frameOffset,
                        std::size_t frameCount) noexcept override {
    for (std::size_t channel = 0U; channel < buffer.channelCount(); ++channel) {
      std::fill(buffer.channel(channel).begin() +
                    static_cast<std::ptrdiff_t>(frameOffset),
                buffer.channel(channel).begin() +
                    static_cast<std::ptrdiff_t>(frameOffset + frameCount),
                value_);
    }
  }

  void handleInstrumentEvent(const InstrumentEvent& event) noexcept override {
    if (event.type == InstrumentEventType::kNoteOn) {
      ++noteOnCounts_[event.data];
      value_ = event.value;
    } else if (event.type == InstrumentEventType::kNoteOff ||
               event.type == InstrumentEventType::kAllNotesOff) {
      value_ = 0.0F;
    }
  }

 private:
  std::array<std::size_t, 128U> noteOnCounts_{};
  float value_ = 0.0F;
};

AudioBufferView MakeMonoView(std::array<float, 64>& samples) {
  static std::array<float*, 1> channels{};
  channels[0] = samples.data();
  return AudioBufferView(channels.data(), channels.size(), samples.size());
}

void TestAutomationDoesNotOutliveNode() {
  SceneGraph graph(48000.0, 64U);
  int updateCount = 0;
  if (!graph.addNode("target",
                     std::make_unique<ParameterProbeNode>(updateCount))) {
    throw std::runtime_error("Failed to add automation target");
  }
  graph.scheduleParameterAutomation("target", "value", 64U, 0.5);
  graph.removeNode("target");

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  graph.render(MakeMonoView(samples));
  if (updateCount != 0) {
    throw std::runtime_error(
        "Numeric automation ran after its target was removed");
  }
}

void TestAutomationDoesNotTargetReusedId() {
  SceneGraph graph(48000.0, 64U);
  int removedUpdateCount = 0;
  int replacementUpdateCount = 0;
  graph.addNode("target",
                std::make_unique<ParameterProbeNode>(removedUpdateCount));
  const auto removedId = graph.resolveRealtimeNodeId("target");
  graph.scheduleParameterAutomation("target", "value", 64U, 0.75);
  graph.removeNode("target");
  graph.addNode("target",
                std::make_unique<ParameterProbeNode>(replacementUpdateCount));
  const auto replacementId = graph.resolveRealtimeNodeId("target");

  if (removedId == kInvalidRealtimeNodeId ||
      replacementId == kInvalidRealtimeNodeId || removedId == replacementId) {
    throw std::runtime_error("Realtime node handles were reused");
  }

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  graph.render(MakeMonoView(samples));
  if (removedUpdateCount != 0 || replacementUpdateCount != 0) {
    throw std::runtime_error(
        "Automation targeted a replacement node with a reused string ID");
  }
}

void TestResolvedRealtimeInstrumentCommandUsesIntraBufferOffset() {
  SceneGraph graph(48000.0, 8U);
  auto instrument = std::make_unique<LoopProbeInstrument>();
  if (!graph.addNode("probe", std::move(instrument)) ||
      !graph.connect("probe", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Failed to build realtime command probe graph");
  }
  const auto nodeId = graph.resolveRealtimeNodeId("probe");
  InstrumentEvent noteOn{};
  noteOn.type = InstrumentEventType::kNoteOn;
  noteOn.channel = 0U;
  noteOn.data = 60U;
  noteOn.value = 0.5F;
  noteOn.retainAcrossPanic = false;

  RealtimeControlCommand command{};
  command.type = RealtimeCommandType::kScheduleInstrumentEvent;
  command.nodeId = nodeId;
  command.frame = 3U;
  command.frameIsRelative = true;
  command.instrumentEvent = noteOn;
  if (!graph.applyRealtimeCommand(command)) {
    throw std::runtime_error("Resolved realtime note command was rejected");
  }

  std::array<float, 8U> samples{};
  std::array<float*, 1U> channels{samples.data()};
  graph.render(AudioBufferView(channels.data(), channels.size(), samples.size()));
  for (std::size_t frame = 0U; frame < samples.size(); ++frame) {
    const float expected = frame < 3U ? 0.0F : 0.5F;
    if (std::fabs(samples[frame] - expected) > 1.0e-6F) {
      throw std::runtime_error(
          "Realtime note command lost its intra-buffer frame offset");
    }
  }
}

void TestMixerProcessesGraphInputs() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("left", std::make_unique<ConstantNode>(0.25F));
  graph.addNode("right", std::make_unique<ConstantNode>(0.5F));
  auto mixer = std::make_unique<MixerNode>(2);
  mixer->setParameter("gain", 2.0);
  graph.addNode("mixer", std::move(mixer));

  if (!graph.connect("left", "mixer") || !graph.connect("right", "mixer") ||
      !graph.connect("mixer", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Failed to build mixer graph");
  }

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  for (const auto sample : samples) {
    if (std::fabs(sample - 1.5F) > 1e-6F) {
      throw std::runtime_error(
          "Mixer discarded or incorrectly scaled graph input");
    }
  }
}

void TestGraphClockCanLocate() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("source", std::make_unique<ConstantNode>(0.25F));
  graph.connect("source", std::string(SceneGraph::kOutputBusId));

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  if (graph.currentFrame() != 64) {
    throw std::runtime_error("Graph clock did not advance after rendering");
  }

  graph.locate(4096);
  if (graph.currentFrame() != 4096) {
    throw std::runtime_error("Graph clock did not locate to the requested frame");
  }
}

void TestTransportLoopWrapsExactlyAndReplaysTimelineInstrumentEvents() {
  SceneGraph graph(48000.0, 8U);
  graph.locate(2U);
  auto instrument = std::make_unique<LoopProbeInstrument>();
  auto* instrumentPtr = instrument.get();
  if (!graph.addNode("loop-probe", std::move(instrument)) ||
      !graph.connect("loop-probe", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Failed to build transport-loop probe graph");
  }

  graph.setTransportLoop(2U, 6U, true);
  const std::array<InstrumentEvent, 3U> events = {{
      {3U, InstrumentEventType::kNoteOn, 0U, 0U, 60U, 0.5F, true},
      {3U, InstrumentEventType::kNoteOn, 0U, 0U, 61U, 0.25F, false},
      {5U, InstrumentEventType::kNoteOff, 0U, 0U, 60U, 0.0F, true},
  }};
  graph.scheduleInstrumentEvents("loop-probe", events);

  std::array<float, 8U> samples{};
  std::array<float*, 1U> channels{samples.data()};
  graph.render(AudioBufferView(channels.data(), channels.size(), samples.size()));

  if (graph.currentFrame() != 2U) {
    throw std::runtime_error(
        "Transport loop did not wrap on the exact render boundary");
  }
  if (instrumentPtr->noteOnCount(60U) != 2U) {
    throw std::runtime_error(
        "Retained instrument timeline note did not replay each loop pass");
  }
  if (instrumentPtr->noteOnCount(61U) != 1U) {
    throw std::runtime_error(
        "Transient live instrument note replayed after loop wrap");
  }
  const std::array<float, 8U> expected = {
      0.0F, 0.25F, 0.25F, 0.0F, 0.0F, 0.5F, 0.5F, 0.0F};
  for (std::size_t frame = 0U; frame < samples.size(); ++frame) {
    if (std::fabs(samples[frame] - expected[frame]) > 1.0e-6F) {
      throw std::runtime_error(
          "Loop render split dispatched an event at the wrong frame");
    }
  }

  graph.setTransportLoop(0U, 0U, false);
  std::array<float, 4U> afterLoop{};
  std::array<float*, 1U> afterLoopChannels{afterLoop.data()};
  graph.render(AudioBufferView(afterLoopChannels.data(),
                               afterLoopChannels.size(), afterLoop.size()));
  if (graph.currentFrame() != 6U || instrumentPtr->noteOnCount(60U) != 3U) {
    throw std::runtime_error(
        "Disabling transport loop did not restore the song timeline");
  }

  bool rejectedEmptyRange = false;
  try {
    graph.setTransportLoop(8U, 8U, true);
  } catch (const std::invalid_argument&) {
    rejectedEmptyRange = true;
  }
  if (!rejectedEmptyRange) {
    throw std::runtime_error(
        "Transport loop accepted an empty enabled range");
  }

  bool rejectedReversedRange = false;
  try {
    graph.setTransportLoop(9U, 8U, true);
  } catch (const std::invalid_argument&) {
    rejectedReversedRange = true;
  }
  if (!rejectedReversedRange) {
    throw std::runtime_error(
        "Transport loop accepted a reversed enabled range");
  }
}

void TestNewNodesLocateToCurrentGraphFrame() {
  SceneGraph graph(48000.0, 64);
  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));

  auto node = std::make_unique<LocationTrackingNode>();
  auto* nodePtr = node.get();
  if (!graph.addNode("late", std::move(node))) {
    throw std::runtime_error("Failed to add node after the graph clock advanced");
  }
  if (nodePtr->locatedFrame != 64) {
    throw std::runtime_error(
        "New node did not locate to the current graph frame");
  }

  graph.removeNode("late");
  graph.locate(4096);
  auto replacement = std::make_unique<LocationTrackingNode>();
  auto* replacementPtr = replacement.get();
  if (!graph.addNode("late", std::move(replacement))) {
    throw std::runtime_error("Failed to add replacement node");
  }
  if (replacementPtr->locatedFrame != 4096) {
    throw std::runtime_error(
        "Replacement node did not locate to the current graph frame");
  }
}

void TestGraphRejectsCycles() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("source", std::make_unique<ConstantNode>(0.25F));
  graph.addNode("middle", std::make_unique<SilentNode>());
  graph.addNode("sink", std::make_unique<SilentNode>());

  if (!graph.connect("source", "middle") ||
      !graph.connect("middle", "sink")) {
    throw std::runtime_error("Failed to build acyclic graph");
  }
  if (graph.connect("sink", "source")) {
    throw std::runtime_error("Graph accepted a multi-node cycle");
  }
  if (graph.connect("middle", "middle")) {
    throw std::runtime_error("Graph accepted a self-cycle");
  }
  if (!graph.connect("sink", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error(
        "Cycle rejection corrupted valid graph connections");
  }

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  for (const auto sample : samples) {
    if (std::fabs(sample - 0.25F) > 1e-6F) {
      throw std::runtime_error(
          "Acyclic graph rendered incorrectly after cycle rejection");
    }
  }
}

void TestTrackOutputAppliesGainAndPan() {
  TrackOutputNode output;
  output.setParameter("gain", 0.5);
  output.setParameter("pan", 1.0);

  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float*, 2> channels{left.data(), right.data()};
  output.process(
      AudioBufferView(channels.data(), channels.size(), left.size()));

  for (const auto sample : left) {
    if (std::fabs(sample) > 1e-6F) {
      throw std::runtime_error("Hard-right pan did not silence the left channel");
    }
  }
  for (const auto sample : right) {
    if (std::fabs(sample - 0.5F) > 1e-6F) {
      throw std::runtime_error(
          "Track output did not apply gain to the right channel");
    }
  }
}

void TestInstrumentPanicRetainsTimelineAndPurgesTransientEvents() {
  SceneGraph graph(48000.0, 64U);
  auto instrument = std::make_unique<juno::Juno106Node>(64U, 1U);
  auto* instrumentPtr = instrument.get();
  if (!instrument->setParameter(juno::ParameterId::kChorusMode,
                                static_cast<float>(juno::ChorusMode::kI)) ||
      !instrument->setParameter(juno::ParameterId::kOutputGain, 1.0F) ||
      !instrument->setParameter(juno::ParameterId::kAttackSeconds,
                                0.0005F) ||
      !instrument->setParameter(juno::ParameterId::kReleaseSeconds, 1.0F) ||
      !graph.addNode("juno", std::move(instrument)) ||
      !graph.connect("juno", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Failed to build instrument panic graph");
  }

  const std::array<InstrumentEvent, 2U> events = {{
      {0U, InstrumentEventType::kNoteOn, 0U, 0U, 60U, 0.8F},
      {128U, InstrumentEventType::kNoteOn, 0U, 0U, 67U, 0.8F},
  }};
  graph.scheduleInstrumentEvents("juno", events);

  std::array<float, 64U> left{};
  std::array<float, 64U> right{};
  std::array<float*, 2U> channels{left.data(), right.data()};
  const auto output =
      AudioBufferView(channels.data(), channels.size(), left.size());
  graph.render(output);
  if (!std::any_of(left.begin(), left.end(),
                   [](float sample) { return std::fabs(sample) > 1.0e-7F; }) ||
      graph.currentFrame() != 64U ||
      instrumentPtr->pendingEventCount() != 1U) {
    throw std::runtime_error(
        "Instrument panic fixture did not begin with a queued future note");
  }

  graph.panicInstruments();
  if (graph.currentFrame() != 64U || instrumentPtr->currentFrame() != 64U ||
      instrumentPtr->pendingEventCount() != 1U) {
    throw std::runtime_error(
        "Instrument panic moved the timeline or discarded future events");
  }

  graph.render(output);
  if (std::any_of(left.begin(), left.end(),
                  [](float sample) { return sample != 0.0F; }) ||
      std::any_of(right.begin(), right.end(),
                  [](float sample) { return sample != 0.0F; })) {
    throw std::runtime_error(
        "Instrument panic left stale envelope or chorus output");
  }
  graph.render(output);
  if (!std::any_of(left.begin(), left.end(),
                   [](float sample) { return std::fabs(sample) > 1.0e-7F; })) {
    throw std::runtime_error(
        "Instrument panic discarded the queued restart note");
  }

  const std::array<InstrumentEvent, 1U> currentFrameEvent = {{
      {graph.currentFrame(), InstrumentEventType::kNoteOn, 0U, 0U, 72U,
       0.8F},
  }};
  graph.scheduleInstrumentEvents("juno", currentFrameEvent);
  graph.panicInstruments();
  if (instrumentPtr->pendingEventCount() != 1U) {
    throw std::runtime_error(
        "Instrument panic discarded a current-frame timeline note");
  }
  graph.render(output);
  if (!std::any_of(left.begin(), left.end(),
                   [](float sample) { return std::fabs(sample) > 1.0e-7F; })) {
    throw std::runtime_error(
        "Current-frame timeline note did not resume after panic");
  }

  const std::array<InstrumentEvent, 2U> transientEvents = {{
      {graph.currentFrame(), InstrumentEventType::kNoteOn, 0U, 0U, 76U,
       0.8F, false},
      {graph.currentFrame() + 64U, InstrumentEventType::kNoteOn, 0U, 0U,
       79U, 0.8F, false},
  }};
  graph.scheduleInstrumentEvents("juno", transientEvents);
  graph.panicInstruments();
  if (instrumentPtr->pendingEventCount() != 0U) {
    throw std::runtime_error("Instrument panic retained transient live input");
  }
  for (std::size_t block = 0U; block < 2U; ++block) {
    graph.render(output);
    if (std::any_of(left.begin(), left.end(),
                    [](float sample) { return sample != 0.0F; }) ||
        std::any_of(right.begin(), right.end(),
                    [](float sample) { return sample != 0.0F; })) {
      throw std::runtime_error(
          "Transient live note replayed after instrument panic");
    }
  }
}

void TestInstrumentParametersApplyImmediately() {
  SceneGraph graph(48000.0, 64U);
  auto instrument = std::make_unique<juno::Juno106Node>(64U, 1U);
  auto* instrumentPtr = instrument.get();
  if (!graph.addNode("juno", std::move(instrument))) {
    throw std::runtime_error("Failed to add immediate-parameter instrument");
  }

  graph.setInstrumentParameter(
      "juno", static_cast<std::uint16_t>(juno::ParameterId::kCutoffHz),
      2400.0F);
  if (instrumentPtr->pendingEventCount() != 0U) {
    throw std::runtime_error(
        "Immediate parameter update consumed event queue capacity");
  }

  bool rejectedInvalidParameter = false;
  try {
    graph.setInstrumentParameter("juno", 0xffffU, 1.0F);
  } catch (const std::runtime_error&) {
    rejectedInvalidParameter = true;
  }
  if (!rejectedInvalidParameter) {
    throw std::runtime_error(
        "Immediate parameter update accepted an invalid parameter");
  }
}

}  // namespace

void RunSceneGraphTests() {
  TestAutomationDoesNotOutliveNode();
  TestAutomationDoesNotTargetReusedId();
  TestResolvedRealtimeInstrumentCommandUsesIntraBufferOffset();
  TestMixerProcessesGraphInputs();
  TestGraphClockCanLocate();
  TestTransportLoopWrapsExactlyAndReplaysTimelineInstrumentEvents();
  TestNewNodesLocateToCurrentGraphFrame();
  TestGraphRejectsCycles();
  TestTrackOutputAppliesGainAndPan();
  TestInstrumentPanicRetainsTimelineAndPurgesTransientEvents();
  TestInstrumentParametersApplyImmediately();
}

}  // namespace daft::audio::tests
