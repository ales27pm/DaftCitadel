#include "audio_engine/instruments/juno/JunoInstrumentNode.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <span>
#include <vector>

namespace daft::audio {

JunoInstrumentNode::JunoInstrumentNode(std::size_t polyphony)
    : polyphony_(std::max<std::size_t>(1, polyphony)) {}

void JunoInstrumentNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  sampleRate_ = sampleRate;
  engine_.prepare(juno::EngineConfig{std::max(1.0, sampleRate_), 256U,
                                     std::max<std::size_t>(1, polyphony_)});
  initialized_ = true;
  started_ = true;
}

void JunoInstrumentNode::reset() noexcept {
  if (!initialized_) {
    return;
  }
  engine_.allNotesOff();
  engine_.reset();
  started_ = false;
}

void JunoInstrumentNode::process(AudioBufferView buffer) noexcept {
  ensureInitialized();

  if (buffer.channelCount() == 0 || buffer.frameCount() == 0) {
    return;
  }

  auto leftChannel = buffer.channel(0).data();
  auto* rightChannel = buffer.channel(std::min<std::size_t>(buffer.channelCount() - 1, 1)).data();

  if (buffer.channelCount() == 1) {
    if (rightScratch_.size() < buffer.frameCount()) {
      rightScratch_.resize(buffer.frameCount());
    }
    auto* scratchRight = rightScratch_.data();
    engine_.render(std::span<float>(leftChannel, buffer.frameCount()),
                   std::span<float>(scratchRight, buffer.frameCount()));
    auto leftData = buffer.channel(0);
    for (std::size_t frame = 0; frame < buffer.frameCount(); ++frame) {
      leftData[frame] =
          static_cast<float>((static_cast<double>(leftData[frame]) + static_cast<double>(scratchRight[frame])) * 0.5);
    }
    return;
  }

  engine_.render(std::span<float>(leftChannel, buffer.frameCount()),
                 std::span<float>(rightChannel, buffer.frameCount()));

  for (std::size_t index = 2; index < buffer.channelCount(); ++index) {
    const auto view = buffer.channel(index);
    std::fill(view.begin(), view.end(), 0.0F);
  }
}

void JunoInstrumentNode::ensureInitialized() {
  if (initialized_ && started_) {
    return;
  }

  engine_.prepare(juno::EngineConfig{std::max(1.0, sampleRate_), 256U,
                                     std::max<std::size_t>(1, polyphony_)});
  initialized_ = true;
  started_ = true;
}

std::string JunoInstrumentNode::normalizeParameter(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](const unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

bool JunoInstrumentNode::toInt(double value, int& out) {
  if (!std::isfinite(value)) {
    return false;
  }
  const auto rounded = static_cast<long long>(std::llround(value));
  if (rounded < std::numeric_limits<int>::min() || rounded > std::numeric_limits<int>::max()) {
    return false;
  }
  out = static_cast<int>(rounded);
  return std::fabs(value - static_cast<double>(rounded)) < 1e-6;
}

bool JunoInstrumentNode::toUnsigned(double value, std::size_t& out, std::size_t minValue,
                                     std::size_t maxValue) {
  if (!std::isfinite(value)) {
    return false;
  }
  const auto rounded = static_cast<long long>(std::llround(value));
  if (rounded < 0) {
    return false;
  }
  const auto converted = static_cast<std::size_t>(rounded);
  if (converted < minValue || converted > maxValue) {
    return false;
  }
  out = converted;
  return true;
}

void JunoInstrumentNode::applyPatchParameter(const std::string& name, double value) {
  const auto setParameter = [this, value](juno::ParameterId parameter) {
    engine_.setParameter(parameter, static_cast<float>(value));
  };

  if (name == "pulsewidth" || name == "pulse_width") {
    setParameter(juno::ParameterId::kPulseWidth);
    return;
  }
  if (name == "sublevel" || name == "sub_level") {
    setParameter(juno::ParameterId::kSubLevel);
    return;
  }
  if (name == "cutoff" || name == "cutoffhz" || name == "cutoff_hz") {
    setParameter(juno::ParameterId::kCutoffHz);
    return;
  }
  if (name == "resonance") {
    setParameter(juno::ParameterId::kResonance);
    return;
  }
  if (name == "attack" || name == "attackseconds" || name == "attack_seconds") {
    setParameter(juno::ParameterId::kAttackSeconds);
    return;
  }
  if (name == "release" || name == "releaseseconds" || name == "release_seconds") {
    setParameter(juno::ParameterId::kReleaseSeconds);
    return;
  }
  if (name == "chorus" || name == "chorusmode" || name == "chorus_mode") {
    setParameter(juno::ParameterId::kChorusMode);
    return;
  }
  if (name == "gain" || name == "outputgain" || name == "output_gain") {
    setParameter(juno::ParameterId::kOutputGain);
    return;
  }
  if (name == "lforate" || name == "lforatehz" || name == "lfo_rate" || name == "lfo_rate_hz") {
    setParameter(juno::ParameterId::kLfoRateHz);
    return;
  }
  if (name == "lfodepth" || name == "lfo_depth") {
    setParameter(juno::ParameterId::kLfoDepth);
    return;
  }
}

void JunoInstrumentNode::setParameter(const std::string& name, double value) {
  const auto key = normalizeParameter(name);

  if (key == "velocity") {
    const double normalizedVelocity =
        value > 1.0 ? std::clamp(value / 127.0, 0.0, 1.0) : std::clamp(value, 0.0, 1.0);
    const float clamped = static_cast<float>(normalizedVelocity);
    noteVelocity_ = clamped;
    return;
  }

  if (key == "polyphony") {
    std::size_t polyphony = 1;
    if (toUnsigned(value, polyphony, 1, 128)) {
      polyphony_ = polyphony;
      engine_.prepare(juno::EngineConfig{std::max(1.0, sampleRate_), 256U,
                                         std::max<std::size_t>(1, polyphony_)});
      initialized_ = true;
      started_ = true;
    }
    return;
  }

  if (key == "note" || key == "noteon") {
    int note = 0;
    if (toInt(value, note)) {
      const int clamped = std::clamp(note, 0, 127);
      ensureInitialized();
      engine_.noteOn(clamped, noteVelocity_);
    }
    return;
  }

  if (key == "noteoff") {
    int note = 0;
    if (toInt(value, note)) {
      ensureInitialized();
      engine_.noteOff(std::clamp(note, 0, 127));
    }
    return;
  }

  if (key == "start") {
    ensureInitialized();
    started_ = true;
    return;
  }

  if (key == "stop") {
    started_ = false;
    engine_.allNotesOff();
    engine_.reset();
    return;
  }

  applyPatchParameter(key, value);
}

}  // namespace daft::audio
