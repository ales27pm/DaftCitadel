#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <ctime>
#include <iostream>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#include "audio_engine/instruments/InstrumentNode.h"
#include "audio_engine/instruments/juno/Juno106Node.h"

namespace daft::audio::tests {
namespace {

using juno::ChorusMode;
using juno::Juno106Node;
using juno::ParameterId;

#if defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(undefined_behavior_sanitizer)
constexpr bool kSanitizedBuild = true;
#else
constexpr bool kSanitizedBuild = false;
#endif
#elif defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_UNDEFINED__)
constexpr bool kSanitizedBuild = true;
#else
constexpr bool kSanitizedBuild = false;
#endif

#if defined(__OPTIMIZE__)
constexpr bool kOptimizedBuild = true;
#else
constexpr bool kOptimizedBuild = false;
#endif

class TestBuffer final {
 public:
  TestBuffer(std::size_t channels, std::size_t frames)
      : samples_(channels, std::vector<float>(frames, 0.0F)), pointers_(channels) {
    for (std::size_t channel = 0U; channel < channels; ++channel) {
      pointers_[channel] = samples_[channel].data();
    }
  }

  [[nodiscard]] AudioBufferView view() {
    return {pointers_.data(), samples_.size(), samples_.empty() ? 0U : samples_[0].size()};
  }

  [[nodiscard]] const std::vector<float>& channel(std::size_t index) const {
    return samples_.at(index);
  }

 private:
  std::vector<std::vector<float>> samples_;
  std::vector<float*> pointers_;
};

class ProbeInstrument final : public InstrumentNode {
 public:
  void setParameter(const std::string&, double value) override {
    if (std::isfinite(value)) {
      value_ = static_cast<float>(value);
    }
  }

  void allNotesOff() noexcept override { value_ = 0.0F; }

 protected:
  void prepareInstrument(double) override { value_ = 0.0F; }
  void resetInstrument() noexcept override { value_ = 0.0F; }

  void renderInstrument(AudioBufferView buffer, std::size_t frameOffset,
                        std::size_t frameCount) noexcept override {
    for (std::size_t channel = 0U; channel < buffer.channelCount(); ++channel) {
      std::fill(buffer.channel(channel).begin() + static_cast<std::ptrdiff_t>(frameOffset),
                buffer.channel(channel).begin() +
                    static_cast<std::ptrdiff_t>(frameOffset + frameCount),
                value_);
    }
  }

  void handleInstrumentEvent(const InstrumentEvent& event) noexcept override {
    switch (event.type) {
      case InstrumentEventType::kNoteOn:
      case InstrumentEventType::kParameter:
      case InstrumentEventType::kChannelAftertouch:
      case InstrumentEventType::kPolyAftertouch:
      case InstrumentEventType::kPitchBend:
      case InstrumentEventType::kControlChange:
        value_ = event.value;
        break;
      case InstrumentEventType::kNoteOff:
      case InstrumentEventType::kAllNotesOff:
        value_ = 0.0F;
        break;
    }
  }

 private:
  float value_ = 0.0F;
};

void AssertNear(float actual, float expected, float tolerance, const std::string& context) {
  if (!std::isfinite(actual) || std::fabs(actual - expected) > tolerance) {
    throw std::runtime_error(context + " expected " + std::to_string(expected) + " got " +
                             std::to_string(actual));
  }
}

void AssertExactSilence(std::span<const float> samples, const std::string& context) {
  if (std::any_of(samples.begin(), samples.end(), [](float sample) { return sample != 0.0F; })) {
    throw std::runtime_error(context + " expected exact silence");
  }
}

[[nodiscard]] bool ContainsSignal(std::span<const float> samples) {
  return std::any_of(samples.begin(), samples.end(),
                     [](float sample) { return std::fabs(sample) > 1.0e-7F; });
}

void ConfigureDryNode(Juno106Node& node) {
  if (!node.setParameter(ParameterId::kChorusMode,
                         static_cast<float>(ChorusMode::kOff)) ||
      !node.setParameter(ParameterId::kOutputGain, 1.0F) ||
      !node.setParameter(ParameterId::kAttackSeconds, 0.0005F) ||
      !node.setParameter(ParameterId::kReleaseSeconds, 0.0005F)) {
    throw std::runtime_error("Unable to configure dry Juno node");
  }
}

void PrepareDryNode(Juno106Node& node) {
  ConfigureDryNode(node);
  node.prepare(48000.0);
  if (!node.isPrepared()) {
    throw std::runtime_error("Juno node did not prepare");
  }
}

void TestAbsoluteFrameOrderingAndLifecycle() {
  ProbeInstrument node;
  node.prepare(48000.0);
  const std::array<InstrumentEvent, 4> batch = {{
      {6U, InstrumentEventType::kParameter, 1U, 0U, 0U, 0.6F},
      {2U, InstrumentEventType::kParameter, 1U, 0U, 0U, 0.2F},
      {2U, InstrumentEventType::kParameter, 1U, 0U, 0U, 0.3F},
      {8U, InstrumentEventType::kParameter, 1U, 0U, 0U, 0.8F},
  }};
  if (!node.scheduleEvents(batch) || node.pendingEventCount() != batch.size()) {
    throw std::runtime_error("Unable to queue absolute-frame instrument events");
  }

  TestBuffer first(1U, 8U);
  node.process(first.view());
  for (std::size_t frame = 0U; frame < 2U; ++frame) {
    AssertNear(first.channel(0)[frame], 0.0F, 0.0F, "Pre-event frame");
  }
  for (std::size_t frame = 2U; frame < 6U; ++frame) {
    AssertNear(first.channel(0)[frame], 0.3F, 0.0F, "Stable same-frame event order");
  }
  for (std::size_t frame = 6U; frame < 8U; ++frame) {
    AssertNear(first.channel(0)[frame], 0.6F, 0.0F, "Intra-buffer event frame");
  }
  if (node.currentFrame() != 8U || node.pendingEventCount() != 1U) {
    throw std::runtime_error("Block-end event was not retained for the next buffer");
  }

  TestBuffer second(1U, 4U);
  node.process(second.view());
  for (float sample : second.channel(0)) {
    AssertNear(sample, 0.8F, 0.0F, "Block-boundary event");
  }

  if (!node.scheduleParameter(4U, 1U, 0.4F)) {
    throw std::runtime_error("Unable to schedule overdue event");
  }
  TestBuffer overdue(1U, 2U);
  node.process(overdue.view());
  for (float sample : overdue.channel(0)) {
    AssertNear(sample, 0.4F, 0.0F, "Overdue event dispatch");
  }

  if (!node.scheduleParameter(100U, 1U, 1.0F)) {
    throw std::runtime_error("Unable to queue event before locate");
  }
  node.locate(64U);
  if (node.currentFrame() != 64U || node.pendingEventCount() != 0U) {
    throw std::runtime_error("Locate did not reset state and queued events");
  }
  TestBuffer located(1U, 4U);
  node.process(located.view());
  AssertExactSilence(located.channel(0), "Located probe node");

  node.reset();
  if (node.currentFrame() != 0U || node.pendingEventCount() != 0U) {
    throw std::runtime_error("Reset did not restore the instrument timeline");
  }
}

void TestAtomicBatchCapacityAndValidation() {
  ProbeInstrument node;
  node.prepare(48000.0);
  if (!node.scheduleParameter(4U, 1U, 0.4F)) {
    throw std::runtime_error("Unable to seed event queue");
  }

  const std::array<InstrumentEvent, 2> invalidBatch = {{
      {1U, InstrumentEventType::kNoteOn, 0U, 0U, 60U, 0.5F},
      {2U, InstrumentEventType::kNoteOn, 0U, 16U, 60U, 0.5F},
  }};
  if (node.scheduleEvents(invalidBatch) || node.pendingEventCount() != 1U) {
    throw std::runtime_error("Invalid batch partially mutated the event queue");
  }

  std::array<InstrumentEvent, InstrumentNode::kEventCapacity> fullBatch{};
  for (std::size_t index = 0U; index < fullBatch.size(); ++index) {
    fullBatch[index] = {static_cast<std::uint64_t>(fullBatch.size() - index),
                        InstrumentEventType::kParameter, 1U, 0U, 0U,
                        static_cast<float>(index)};
  }
  if (!node.replaceScheduledEvents(fullBatch) ||
      node.pendingEventCount() != InstrumentNode::kEventCapacity) {
    throw std::runtime_error("Fixed-capacity replacement batch was rejected");
  }
  if (node.scheduleParameter(0U, 1U, 1.0F) ||
      node.pendingEventCount() != InstrumentNode::kEventCapacity) {
    throw std::runtime_error("Queue overflow did not fail atomically");
  }
  if (node.replaceScheduledEvents(invalidBatch) ||
      node.pendingEventCount() != InstrumentNode::kEventCapacity) {
    throw std::runtime_error("Invalid replacement destroyed the existing batch");
  }

  const std::array<InstrumentEvent, 2> replacement = {{
      {3U, InstrumentEventType::kParameter, 1U, 0U, 0U, 0.3F},
      {1U, InstrumentEventType::kParameter, 1U, 0U, 0U, 0.1F},
  }};
  if (!node.replaceScheduledEvents(replacement) || node.pendingEventCount() != 2U) {
    throw std::runtime_error("Valid replacement batch failed");
  }
  if (!node.replaceScheduledEvents({}) || node.pendingEventCount() != 0U) {
    throw std::runtime_error("Empty replacement did not clear the queue");
  }

  const InstrumentEvent invalidType{0U, static_cast<InstrumentEventType>(0xffU),
                                    0U, 0U, 0U, 0.0F};
  if (node.scheduleEvent(invalidType) ||
      node.schedulePitchBend(0U, 0U, std::numeric_limits<float>::quiet_NaN()) ||
      node.scheduleNoteOn(0U, 0U, 60U, 1.1F)) {
    throw std::runtime_error("Event queue accepted an invalid payload");
  }
}

void TestJunoExactNoteAndParameterFrames() {
  Juno106Node node(64U, 2U);
  PrepareDryNode(node);
  const std::array<InstrumentEvent, 2> invalidParameterBatch = {{
      {4U, InstrumentEventType::kParameter,
       static_cast<std::uint16_t>(ParameterId::kCutoffHz), 0U, 0U, 1200.0F},
      {8U, InstrumentEventType::kParameter, 0xffffU, 0U, 0U, 1.0F},
  }};
  if (node.scheduleEvents(invalidParameterBatch) || node.pendingEventCount() != 0U) {
    throw std::runtime_error("Invalid Juno parameter batch was not rejected atomically");
  }
  if (!node.scheduleNoteOn(4U, 0U, 60U, 0.8F) ||
      !node.scheduleParameter(32U, ParameterId::kOutputGain, 0.0F)) {
    throw std::runtime_error("Unable to schedule exact-frame Juno events");
  }

  TestBuffer output(2U, 64U);
  node.process(output.view());
  AssertExactSilence(std::span<const float>(output.channel(0)).first(4U),
                     "Juno pre-note frames");
  if (!ContainsSignal(std::span<const float>(output.channel(0)).subspan(4U, 28U))) {
    throw std::runtime_error("Juno note did not begin at its scheduled frame");
  }
  AssertExactSilence(std::span<const float>(output.channel(0)).subspan(32U),
                     "Juno post-gain frames");
  AssertExactSilence(std::span<const float>(output.channel(1)).subspan(32U),
                     "Juno post-gain right frames");
}

void TestPrePreparePatchPersistence() {
  Juno106Node node(128U, 1U);
  if (!node.setParameter(ParameterId::kChorusMode,
                         static_cast<float>(ChorusMode::kOff)) ||
      !node.setParameter(ParameterId::kOutputGain, 0.0F) ||
      !node.setParameter(ParameterId::kAttackSeconds, 0.0005F)) {
    throw std::runtime_error("Pre-prepare patch configuration was rejected");
  }

  const auto renderSilentNote = [&node](const std::string& context) {
    if (!node.scheduleNoteOn(node.currentFrame(), 0U, 60U, 0.8F)) {
      throw std::runtime_error("Unable to schedule patch persistence note");
    }
    TestBuffer output(2U, 128U);
    node.process(output.view());
    AssertExactSilence(output.channel(0), context);
  };

  node.prepare(48000.0);
  if (!node.isPrepared()) {
    throw std::runtime_error("Preconfigured Juno node did not prepare");
  }
  renderSilentNote("Pre-prepare output gain");
  node.reset();
  renderSilentNote("Reset patch retention");
  node.prepare(44100.0);
  renderSilentNote("Re-prepare patch retention");

  node.setParameter("8", 1.0);
  node.reset();
  if (!node.scheduleNoteOn(0U, 0U, 60U, 0.8F)) {
    throw std::runtime_error("Unable to schedule restored-gain note");
  }
  TestBuffer audible(2U, 128U);
  node.process(audible.view());
  if (!ContainsSignal(audible.channel(0))) {
    throw std::runtime_error("Numeric string parameter dispatch did not restore output gain");
  }
}

void TestMonoStereoAndExtraChannelRendering() {
  Juno106Node stereo(128U, 1U);
  Juno106Node mono(128U, 1U);
  Juno106Node surround(128U, 1U);
  PrepareDryNode(stereo);
  PrepareDryNode(mono);
  PrepareDryNode(surround);
  for (auto* node : {&stereo, &mono, &surround}) {
    if (!node->scheduleNoteOn(0U, 0U, 60U, 0.8F)) {
      throw std::runtime_error("Unable to schedule channel-layout test note");
    }
  }

  TestBuffer stereoOutput(2U, 256U);
  TestBuffer monoOutput(1U, 256U);
  TestBuffer surroundOutput(4U, 256U);
  stereo.process(stereoOutput.view());
  mono.process(monoOutput.view());
  surround.process(surroundOutput.view());
  for (std::size_t frame = 0U; frame < 256U; ++frame) {
    const float folded =
        0.5F * (stereoOutput.channel(0)[frame] + stereoOutput.channel(1)[frame]);
    AssertNear(monoOutput.channel(0)[frame], folded, 1.0e-7F, "Mono fold-down");
    AssertNear(surroundOutput.channel(0)[frame], stereoOutput.channel(0)[frame], 1.0e-7F,
               "Multichannel left");
    AssertNear(surroundOutput.channel(1)[frame], stereoOutput.channel(1)[frame], 1.0e-7F,
               "Multichannel right");
  }
  AssertExactSilence(surroundOutput.channel(2), "Third Juno output channel");
  AssertExactSilence(surroundOutput.channel(3), "Fourth Juno output channel");
}

void TestSustainChannelIdentityAndAllNotesOff() {
  Juno106Node sustain(128U, 2U);
  PrepareDryNode(sustain);
  if (!sustain.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !sustain.scheduleControlChange(16U, 0U, 64U, 1.0F) ||
      !sustain.scheduleNoteOff(32U, 0U, 60U)) {
    throw std::runtime_error("Unable to schedule sustain sequence");
  }
  TestBuffer held(2U, 128U);
  sustain.process(held.view());
  if (sustain.activeVoiceCount() != 1U) {
    throw std::runtime_error("CC64 did not defer note release");
  }
  if (!sustain.scheduleControlChange(sustain.currentFrame(), 0U, 64U, 0.0F)) {
    throw std::runtime_error("Unable to schedule sustain release");
  }
  TestBuffer released(2U, 512U);
  sustain.process(released.view());
  if (sustain.activeVoiceCount() != 0U) {
    throw std::runtime_error("CC64 release left a sustained voice active");
  }

  Juno106Node channels(128U, 2U);
  PrepareDryNode(channels);
  if (!channels.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !channels.scheduleNoteOn(0U, 1U, 60U, 0.8F)) {
    throw std::runtime_error("Unable to schedule channel-identity notes");
  }
  TestBuffer sounding(2U, 64U);
  channels.process(sounding.view());
  if (channels.activeVoiceCount() != 2U ||
      !channels.scheduleAllNotesOff(channels.currentFrame(), 0U)) {
    throw std::runtime_error("Same note on distinct channels did not occupy distinct voices");
  }
  TestBuffer channelRelease(2U, 512U);
  channels.process(channelRelease.view());
  if (channels.activeVoiceCount() != 1U) {
    throw std::runtime_error("Channel all-notes-off affected another MIDI channel");
  }
  channels.allNotesOff();
  TestBuffer globalRelease(2U, 512U);
  channels.process(globalRelease.view());
  if (channels.activeVoiceCount() != 0U) {
    throw std::runtime_error("Global all-notes-off left a voice active");
  }
}

void TestPitchBendAndAftertouchBehavior() {
  Juno106Node baseline(256U, 1U);
  Juno106Node bentOtherChannel(256U, 1U);
  Juno106Node bentSameChannel(256U, 1U);
  PrepareDryNode(baseline);
  PrepareDryNode(bentOtherChannel);
  PrepareDryNode(bentSameChannel);
  if (!baseline.scheduleNoteOn(0U, 1U, 60U, 0.8F) ||
      !bentOtherChannel.schedulePitchBend(0U, 0U, 1.0F) ||
      !bentOtherChannel.scheduleNoteOn(0U, 1U, 60U, 0.8F) ||
      !bentSameChannel.schedulePitchBend(0U, 1U, 1.0F) ||
      !bentSameChannel.scheduleNoteOn(0U, 1U, 60U, 0.8F)) {
    throw std::runtime_error("Unable to schedule pitch-bend comparison");
  }
  TestBuffer baselineOutput(2U, 256U);
  TestBuffer otherOutput(2U, 256U);
  TestBuffer bentOutput(2U, 256U);
  baseline.process(baselineOutput.view());
  bentOtherChannel.process(otherOutput.view());
  bentSameChannel.process(bentOutput.view());
  bool bendChangedSignal = false;
  for (std::size_t frame = 0U; frame < 256U; ++frame) {
    AssertNear(otherOutput.channel(0)[frame], baselineOutput.channel(0)[frame], 1.0e-7F,
               "Pitch-bend channel isolation");
    bendChangedSignal =
        std::fabs(bentOutput.channel(0)[frame] - baselineOutput.channel(0)[frame]) >
            1.0e-5F ||
        bendChangedSignal;
  }
  if (!bendChangedSignal) {
    throw std::runtime_error("Pitch bend did not alter the targeted channel");
  }

  Juno106Node pressureBaseline(256U, 1U);
  Juno106Node channelPressure(256U, 1U);
  Juno106Node polyPressure(256U, 1U);
  Juno106Node unrelatedPolyPressure(256U, 1U);
  PrepareDryNode(pressureBaseline);
  PrepareDryNode(channelPressure);
  PrepareDryNode(polyPressure);
  PrepareDryNode(unrelatedPolyPressure);
  if (!pressureBaseline.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !channelPressure.scheduleChannelAftertouch(0U, 0U, 1.0F) ||
      !channelPressure.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !polyPressure.schedulePolyAftertouch(0U, 0U, 60U, 1.0F) ||
      !polyPressure.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !unrelatedPolyPressure.schedulePolyAftertouch(0U, 0U, 61U, 1.0F) ||
      !unrelatedPolyPressure.scheduleNoteOn(0U, 0U, 60U, 0.8F)) {
    throw std::runtime_error("Unable to schedule aftertouch comparison");
  }
  TestBuffer pressureBaselineOutput(2U, 256U);
  TestBuffer channelPressureOutput(2U, 256U);
  TestBuffer polyPressureOutput(2U, 256U);
  TestBuffer unrelatedOutput(2U, 256U);
  pressureBaseline.process(pressureBaselineOutput.view());
  channelPressure.process(channelPressureOutput.view());
  polyPressure.process(polyPressureOutput.view());
  unrelatedPolyPressure.process(unrelatedOutput.view());
  for (std::size_t frame = 0U; frame < 256U; ++frame) {
    const float expectedPressure = pressureBaselineOutput.channel(0)[frame] * 1.25F;
    AssertNear(channelPressureOutput.channel(0)[frame], expectedPressure, 2.0e-6F,
               "Channel aftertouch gain");
    AssertNear(polyPressureOutput.channel(0)[frame], expectedPressure, 2.0e-6F,
               "Poly aftertouch gain");
    AssertNear(unrelatedOutput.channel(0)[frame], pressureBaselineOutput.channel(0)[frame],
               1.0e-7F, "Poly aftertouch note isolation");
  }
}

void AssertBuffersEqual(const TestBuffer& actual, const TestBuffer& expected,
                        const std::string& context) {
  if (actual.channel(0).size() != expected.channel(0).size()) {
    throw std::runtime_error(context + " frame count differs");
  }
  for (std::size_t frame = 0U; frame < actual.channel(0).size(); ++frame) {
    AssertNear(actual.channel(0)[frame], expected.channel(0)[frame], 0.0F,
               context + " left");
    AssertNear(actual.channel(1)[frame], expected.channel(1)[frame], 0.0F,
               context + " right");
  }
}

void TestScheduledLfoAndPrePrepareCaching() {
  Juno106Node preconfigured(256U, 1U);
  Juno106Node configuredAfterPrepare(256U, 1U);
  if (!preconfigured.setParameter(ParameterId::kLfoRateHz, 8.0F) ||
      !preconfigured.setParameter(ParameterId::kLfoDepth, 0.75F)) {
    throw std::runtime_error("Pre-prepare LFO parameters were rejected");
  }
  PrepareDryNode(preconfigured);
  PrepareDryNode(configuredAfterPrepare);
  if (!configuredAfterPrepare.setParameter(ParameterId::kLfoRateHz, 8.0F) ||
      !configuredAfterPrepare.setParameter(ParameterId::kLfoDepth, 0.75F) ||
      !preconfigured.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !configuredAfterPrepare.scheduleNoteOn(0U, 0U, 60U, 0.8F)) {
    throw std::runtime_error("Unable to configure LFO cache comparison");
  }
  TestBuffer preconfiguredOutput(2U, 4096U);
  TestBuffer postconfiguredOutput(2U, 4096U);
  preconfigured.process(preconfiguredOutput.view());
  configuredAfterPrepare.process(postconfiguredOutput.view());
  AssertBuffersEqual(preconfiguredOutput, postconfiguredOutput,
                     "Pre-prepare LFO parameter cache");

  Juno106Node reconfiguredAfterPrepare(256U, 1U);
  ConfigureDryNode(reconfiguredAfterPrepare);
  preconfigured.prepare(44100.0);
  reconfiguredAfterPrepare.prepare(44100.0);
  if (!preconfigured.isPrepared() || !reconfiguredAfterPrepare.isPrepared() ||
      !reconfiguredAfterPrepare.setParameter(ParameterId::kLfoRateHz, 8.0F) ||
      !reconfiguredAfterPrepare.setParameter(ParameterId::kLfoDepth, 0.75F) ||
      !preconfigured.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !reconfiguredAfterPrepare.scheduleNoteOn(0U, 0U, 60U, 0.8F)) {
    throw std::runtime_error("Unable to configure LFO re-prepare cache comparison");
  }
  TestBuffer repreparedOutput(2U, 4096U);
  TestBuffer reconfiguredOutput(2U, 4096U);
  preconfigured.process(repreparedOutput.view());
  reconfiguredAfterPrepare.process(reconfiguredOutput.view());
  AssertBuffersEqual(repreparedOutput, reconfiguredOutput,
                     "Re-prepared LFO parameter cache");

  Juno106Node baseline(256U, 1U);
  Juno106Node scheduled(256U, 1U);
  PrepareDryNode(baseline);
  PrepareDryNode(scheduled);
  if (!baseline.setParameter(ParameterId::kLfoRateHz, 8.0F) ||
      !scheduled.setParameter(ParameterId::kLfoRateHz, 8.0F) ||
      !baseline.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !scheduled.scheduleNoteOn(0U, 0U, 60U, 0.8F) ||
      !scheduled.scheduleParameter(1024U, ParameterId::kLfoDepth, 1.0F)) {
    throw std::runtime_error("Unable to schedule native LFO parameter event");
  }
  TestBuffer baselineOutput(2U, 4096U);
  TestBuffer scheduledOutput(2U, 4096U);
  baseline.process(baselineOutput.view());
  scheduled.process(scheduledOutput.view());
  for (std::size_t frame = 0U; frame < 1024U; ++frame) {
    AssertNear(scheduledOutput.channel(0)[frame], baselineOutput.channel(0)[frame], 0.0F,
               "Pre-LFO scheduled frame");
  }
  bool changed = false;
  for (std::size_t frame = 1024U; frame < 4096U; ++frame) {
    changed =
        std::fabs(scheduledOutput.channel(0)[frame] - baselineOutput.channel(0)[frame]) >
            1.0e-5F ||
        changed;
  }
  if (!changed) {
    throw std::runtime_error("Scheduled LFO depth did not change native node output");
  }
}

void TestDenseRealtimeSchedulingStress() {
  constexpr std::size_t kBlockFrames = 256U;
  constexpr std::size_t kBlockCount = 512U;
  constexpr double kBufferBudgetMicros =
      static_cast<double>(kBlockFrames) / 48000.0 * 1'000'000.0;
  constexpr double kP99BudgetMicros = kBufferBudgetMicros * 0.70;

  Juno106Node node(kBlockFrames, 6U);
  node.prepare(48000.0);
  if (!node.isPrepared() ||
      !node.setParameter(ParameterId::kReleaseSeconds, 0.0005F) ||
      !node.setParameter(ParameterId::kOutputGain, 0.2F)) {
    throw std::runtime_error("Unable to configure dense Juno stress test");
  }

  std::array<double, kBlockCount> renderMicros{};
  for (std::size_t block = 0U; block < kBlockCount; ++block) {
    const std::uint64_t frame = node.currentFrame();
    const auto channel = static_cast<std::uint8_t>(block % 4U);
    const auto firstNote = static_cast<std::uint8_t>(48U + block % 24U);
    const float bend = static_cast<float>(static_cast<int>(block % 17U) - 8) / 8.0F;
    const float pressure = static_cast<float>(block % 11U) / 10.0F;
    const std::array<InstrumentEvent, 17U> events = {{
        {frame, InstrumentEventType::kControlChange, 0U, channel, 64U, 1.0F},
        {frame + 4U, InstrumentEventType::kNoteOn, 0U, channel, firstNote, 0.8F},
        {frame + 3U, InstrumentEventType::kNoteOn, 0U, channel,
         static_cast<std::uint8_t>(firstNote + 3U), 0.7F},
        {frame + 2U, InstrumentEventType::kNoteOn, 0U, channel,
         static_cast<std::uint8_t>(firstNote + 7U), 0.6F},
        {frame + 1U, InstrumentEventType::kNoteOn, 0U, channel,
         static_cast<std::uint8_t>(firstNote + 10U), 0.5F},
        {frame + 5U, InstrumentEventType::kPitchBend, 0U, channel, 0U, bend},
        {frame + 6U, InstrumentEventType::kChannelAftertouch, 0U, channel, 0U,
         pressure},
        {frame + 7U, InstrumentEventType::kPolyAftertouch, 0U, channel, firstNote,
         1.0F - pressure},
        {frame + 8U, InstrumentEventType::kParameter,
         static_cast<std::uint16_t>(ParameterId::kLfoRateHz), 0U, 0U,
         0.05F + static_cast<float>(block % 100U) * 0.1F},
        {frame + 9U, InstrumentEventType::kParameter,
         static_cast<std::uint16_t>(ParameterId::kLfoDepth), 0U, 0U, pressure},
        {frame + 10U, InstrumentEventType::kParameter,
         static_cast<std::uint16_t>(ParameterId::kCutoffHz), 0U, 0U,
         200.0F + static_cast<float>(block % 100U) * 100.0F},
        {frame + 11U, InstrumentEventType::kParameter,
         static_cast<std::uint16_t>(ParameterId::kResonance), 0U, 0U, pressure},
        {frame + 128U, InstrumentEventType::kNoteOff, 0U, channel, firstNote, 0.0F},
        {frame + 129U, InstrumentEventType::kNoteOff, 0U, channel,
         static_cast<std::uint8_t>(firstNote + 3U), 0.0F},
        {frame + 130U, InstrumentEventType::kNoteOff, 0U, channel,
         static_cast<std::uint8_t>(firstNote + 7U), 0.0F},
        {frame + 131U, InstrumentEventType::kNoteOff, 0U, channel,
         static_cast<std::uint8_t>(firstNote + 10U), 0.0F},
        {frame + 192U, InstrumentEventType::kControlChange, 0U, channel, 64U, 0.0F},
    }};
    if (!node.scheduleEvents(events) ||
        node.pendingEventCount() > InstrumentNode::kEventCapacity) {
      throw std::runtime_error("Dense Juno stress queue overflowed");
    }

    TestBuffer output(2U, kBlockFrames);
    const std::clock_t started = std::clock();
    node.process(output.view());
    const std::clock_t finished = std::clock();
    if (started == static_cast<std::clock_t>(-1) ||
        finished == static_cast<std::clock_t>(-1)) {
      throw std::runtime_error("Process CPU clock is unavailable");
    }
    renderMicros[block] = static_cast<double>(finished - started) * 1'000'000.0 /
                          static_cast<double>(CLOCKS_PER_SEC);
    if (node.pendingEventCount() != 0U) {
      throw std::runtime_error("Dense Juno stress left due events queued");
    }
    for (std::size_t outputChannel = 0U; outputChannel < 2U; ++outputChannel) {
      if (!std::all_of(output.channel(outputChannel).begin(),
                       output.channel(outputChannel).end(),
                       [](float sample) { return std::isfinite(sample); })) {
        throw std::runtime_error("Dense Juno stress produced non-finite audio");
      }
    }
  }

  auto sortedMicros = renderMicros;
  std::sort(sortedMicros.begin(), sortedMicros.end());
  const std::size_t p99Index =
      static_cast<std::size_t>(std::ceil(0.99 * static_cast<double>(kBlockCount))) - 1U;
  const double p99Micros = sortedMicros[p99Index];
  std::cout << "JUNO_STRESS_P99_US=" << p99Micros
            << " threshold_us=" << kP99BudgetMicros
            << " sanitized=" << (kSanitizedBuild ? 1 : 0)
            << " optimized=" << (kOptimizedBuild ? 1 : 0)
            << " clock=process_cpu\n";
  if (!kSanitizedBuild && kOptimizedBuild && p99Micros >= kP99BudgetMicros) {
    throw std::runtime_error("Dense Juno render p99 exceeded 70% of the buffer budget");
  }

  node.allNotesOff();
  for (std::size_t block = 0U; block < 40U; ++block) {
    TestBuffer draining(2U, kBlockFrames);
    node.process(draining.view());
  }
  if (node.activeVoiceCount() != 0U || node.pendingEventCount() != 0U) {
    throw std::runtime_error("Dense Juno stress did not drain voices and events");
  }
  TestBuffer silent(2U, kBlockFrames);
  node.process(silent.view());
  AssertExactSilence(silent.channel(0), "Dense Juno stress left drain");
  AssertExactSilence(silent.channel(1), "Dense Juno stress right drain");
}

}  // namespace

void RunInstrumentNodeTests() {
  TestAbsoluteFrameOrderingAndLifecycle();
  TestAtomicBatchCapacityAndValidation();
  TestJunoExactNoteAndParameterFrames();
  TestPrePreparePatchPersistence();
  TestMonoStereoAndExtraChannelRendering();
  TestSustainChannelIdentityAndAllNotesOff();
  TestPitchBendAndAftertouchBehavior();
  TestScheduledLfoAndPrePrepareCaching();
  TestDenseRealtimeSchedulingStress();
}

}  // namespace daft::audio::tests
