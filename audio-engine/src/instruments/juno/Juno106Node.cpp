#include "audio_engine/instruments/juno/Juno106Node.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

namespace daft::audio::juno {
namespace {

[[nodiscard]] std::optional<ParameterId> ParameterForName(
    std::string_view name) noexcept {
  if (name == "pulsewidth") {
    return ParameterId::kPulseWidth;
  }
  if (name == "sublevel") {
    return ParameterId::kSubLevel;
  }
  if (name == "cutoffhz") {
    return ParameterId::kCutoffHz;
  }
  if (name == "resonance") {
    return ParameterId::kResonance;
  }
  if (name == "attackseconds") {
    return ParameterId::kAttackSeconds;
  }
  if (name == "releaseseconds") {
    return ParameterId::kReleaseSeconds;
  }
  if (name == "chorusmode") {
    return ParameterId::kChorusMode;
  }
  if (name == "outputgain") {
    return ParameterId::kOutputGain;
  }
  if (name == "lforatehz") {
    return ParameterId::kLfoRateHz;
  }
  if (name == "lfodepth") {
    return ParameterId::kLfoDepth;
  }

  std::uint16_t numeric = 0U;
  const auto parsed =
      std::from_chars(name.data(), name.data() + name.size(), numeric);
  if (parsed.ec == std::errc{} &&
      parsed.ptr == name.data() + name.size()) {
    return static_cast<ParameterId>(numeric);
  }
  return std::nullopt;
}

[[nodiscard]] std::optional<std::size_t> ParameterIndex(
    ParameterId parameter) noexcept {
  const auto numeric = static_cast<std::uint16_t>(parameter);
  if (numeric < static_cast<std::uint16_t>(ParameterId::kPulseWidth) ||
      numeric > static_cast<std::uint16_t>(ParameterId::kLfoDepth)) {
    return std::nullopt;
  }
  return static_cast<std::size_t>(numeric);
}

}  // namespace

Juno106Node::Juno106Node(std::uint32_t maximumFramesPerBlock,
                         std::size_t polyphony) noexcept
    : maximumFramesPerBlock_(maximumFramesPerBlock), polyphony_(polyphony) {}

void Juno106Node::setParameter(const std::string& name, double value) {
  const auto parameter = resolveParameterId(name);
  if (parameter) {
    (void)setParameterById(*parameter, value);
  }
}

std::optional<NodeParameterId> Juno106Node::resolveParameterId(
    std::string_view name) const noexcept {
  const auto parameter = ParameterForName(name);
  if (!parameter || !ParameterIndex(*parameter)) {
    return std::nullopt;
  }
  return static_cast<NodeParameterId>(*parameter);
}

bool Juno106Node::setParameterById(NodeParameterId parameter,
                                   double value) noexcept {
  if (!std::isfinite(value) ||
      value < -static_cast<double>(std::numeric_limits<float>::max()) ||
      value > static_cast<double>(std::numeric_limits<float>::max())) {
    return false;
  }
  return setParameter(static_cast<ParameterId>(parameter),
                      static_cast<float>(value));
}

bool Juno106Node::setParameter(ParameterId parameter, float value) noexcept {
  const auto index = ParameterIndex(parameter);
  if (!index || !std::isfinite(value)) {
    return false;
  }
  configuredParameterValues_[*index] = value;
  configuredParameters_[*index] = true;
  return !prepared_ || engine_.setParameter(parameter, value);
}

bool Juno106Node::setImmediateParameter(std::uint16_t parameter,
                                        float value) noexcept {
  return setParameter(static_cast<ParameterId>(parameter), value);
}

bool Juno106Node::scheduleParameter(std::uint64_t frame,
                                    ParameterId parameter,
                                    float value) noexcept {
  if (!ParameterIndex(parameter)) {
    return false;
  }
  return InstrumentNode::scheduleParameter(
      frame, static_cast<std::uint16_t>(parameter), value);
}

void Juno106Node::allNotesOff() noexcept {
  if (prepared_) {
    engine_.allNotesOff();
  }
}

bool Juno106Node::allNotesOff(std::uint8_t channel) noexcept {
  return prepared_ && engine_.allNotesOff(channel);
}

std::size_t Juno106Node::activeVoiceCount() const noexcept {
  return prepared_ ? engine_.activeVoiceCount() : 0U;
}

void Juno106Node::prepareInstrument(double sampleRate) {
  prepared_ = false;
  scratchLeft_.clear();
  scratchRight_.clear();
  if (maximumFramesPerBlock_ == 0U ||
      maximumFramesPerBlock_ > JunoDSPEngine::kMaximumFramesPerBlock ||
      polyphony_ == 0U || polyphony_ > JunoDSPEngine::kMaximumPolyphony) {
    return;
  }

  std::vector<float> preparedLeft(maximumFramesPerBlock_, 0.0F);
  std::vector<float> preparedRight(maximumFramesPerBlock_, 0.0F);
  if (!engine_.prepare({sampleRate, maximumFramesPerBlock_, polyphony_})) {
    return;
  }
  for (std::size_t index = 1U; index < configuredParameters_.size(); ++index) {
    if (configuredParameters_[index]) {
      (void)engine_.setParameter(static_cast<ParameterId>(index),
                                 configuredParameterValues_[index]);
    }
  }
  scratchLeft_ = std::move(preparedLeft);
  scratchRight_ = std::move(preparedRight);
  prepared_ = true;
}

void Juno106Node::resetInstrument() noexcept {
  if (prepared_) {
    engine_.reset();
  }
}

void Juno106Node::renderInstrument(AudioBufferView buffer,
                                   std::size_t frameOffset,
                                   std::size_t frameCount) noexcept {
  if (!prepared_ || frameCount == 0U) {
    return;
  }

  std::size_t rendered = 0U;
  while (rendered < frameCount) {
    const std::size_t chunk = std::min<std::size_t>(
        maximumFramesPerBlock_, frameCount - rendered);
    const std::size_t outputOffset = frameOffset + rendered;
    if (buffer.channelCount() >= 2U) {
      engine_.render(buffer.channel(0).subspan(outputOffset, chunk),
                     buffer.channel(1).subspan(outputOffset, chunk));
    } else if (buffer.channelCount() == 1U) {
      auto mono = buffer.channel(0).subspan(outputOffset, chunk);
      auto scratchRight = std::span<float>(scratchRight_).first(chunk);
      engine_.render(mono, scratchRight);
      for (std::size_t frame = 0U; frame < chunk; ++frame) {
        mono[frame] = 0.5F * (mono[frame] + scratchRight[frame]);
      }
    } else {
      engine_.render(std::span<float>(scratchLeft_).first(chunk),
                     std::span<float>(scratchRight_).first(chunk));
    }
    rendered += chunk;
  }
}

void Juno106Node::handleInstrumentEvent(
    const InstrumentEvent& event) noexcept {
  if (!prepared_) {
    return;
  }

  switch (event.type) {
    case InstrumentEventType::kNoteOn:
      (void)engine_.noteOn(event.channel, event.data, event.value);
      break;
    case InstrumentEventType::kNoteOff:
      (void)engine_.noteOff(event.channel, event.data);
      break;
    case InstrumentEventType::kControlChange:
      if (event.data == 64U) {
        (void)engine_.setSustainPedal(event.channel, event.value >= 0.5F);
      } else if (event.data == 120U || event.data == 123U) {
        (void)engine_.allNotesOff(event.channel);
      }
      break;
    case InstrumentEventType::kPitchBend:
      (void)engine_.setPitchBend(event.channel, event.value);
      break;
    case InstrumentEventType::kChannelAftertouch:
      (void)engine_.setChannelAftertouch(event.channel, event.value);
      break;
    case InstrumentEventType::kPolyAftertouch:
      (void)engine_.setPolyAftertouch(event.channel, event.data, event.value);
      break;
    case InstrumentEventType::kParameter:
      (void)setParameter(static_cast<ParameterId>(event.parameter), event.value);
      break;
    case InstrumentEventType::kAllNotesOff:
      (void)engine_.allNotesOff(event.channel);
      break;
  }
}

bool Juno106Node::validateInstrumentEvent(
    const InstrumentEvent& event) const noexcept {
  return event.type != InstrumentEventType::kParameter ||
         ParameterIndex(static_cast<ParameterId>(event.parameter)).has_value();
}

}  // namespace daft::audio::juno
