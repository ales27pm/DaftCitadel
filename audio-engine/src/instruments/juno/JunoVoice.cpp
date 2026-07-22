#include "audio_engine/instruments/juno/detail/JunoVoice.h"

#include <algorithm>
#include <cmath>

namespace daft::audio::juno::detail {

void JunoVoice::prepare(float sampleRate) {
  sampleRate_ = sampleRate;
  filter_.prepare(sampleRate);
  reset();
}

void JunoVoice::reset() noexcept {
  phase_ = 0.0F;
  subPhase_ = 0.0F;
  envelopeLevel_ = 0.0F;
  envelopeTarget_ = 0.0F;
  frequency_ = 0.0F;
  velocity_ = 0.0F;
  active_ = false;
  midiNote_ = 0;
  filter_.reset();
}

void JunoVoice::noteOn(std::uint8_t midiNote, float velocity) noexcept {
  active_ = true;
  velocity_ = std::clamp(velocity, 0.0F, 1.0F);
  midiNote_ = midiNote;
  frequency_ = 440.0F * std::pow(2.0F, (static_cast<float>(midiNote) - 69.0F) / 12.0F);
  envelopeLevel_ = 0.0F;
  envelopeTarget_ = 1.0F;
  phase_ = 0.0F;
  subPhase_ = 0.0F;
}

bool JunoVoice::noteOff(std::uint8_t midiNote) noexcept {
  if (!active_ || midiNote_ != midiNote) {
    return false;
  }
  release();
  return true;
}

void JunoVoice::release() noexcept {
  if (active_) {
    envelopeTarget_ = 0.0F;
  }
}

bool JunoVoice::setParameter(ParameterId parameter, float value) noexcept {
  if (!std::isfinite(value)) {
    return false;
  }

  switch (parameter) {
    case ParameterId::kPulseWidth:
      pulseWidth_ = std::clamp(value, 0.05F, 0.95F);
      return true;
    case ParameterId::kSubLevel:
      subLevel_ = std::clamp(value, 0.0F, 1.0F);
      return true;
    case ParameterId::kCutoffHz:
      cutoffHz_ = std::clamp(value, 20.0F, sampleRate_ * 0.45F);
      return true;
    case ParameterId::kResonance:
      resonance_ = std::clamp(value, 0.0F, 1.2F);
      return true;
    case ParameterId::kAttackSeconds:
      attackSeconds_ = std::clamp(value, 0.0005F, 30.0F);
      return true;
    case ParameterId::kReleaseSeconds:
      releaseSeconds_ = std::clamp(value, 0.0005F, 30.0F);
      return true;
    case ParameterId::kChorusMode:
    case ParameterId::kOutputGain:
      return false;
  }
  return false;
}

float JunoVoice::processMono() noexcept {
  if (!stepEnvelopeAndPhase()) {
    return 0.0F;
  }

  const float pulseWidth = std::clamp(pulseWidth_, 0.05F, 0.95F);
  const float oscillator = phase_ < pulseWidth
                               ? -1.0F + (phase_ / pulseWidth) * 2.0F
                               : 1.0F - ((phase_ - pulseWidth) / (1.0F - pulseWidth)) * 2.0F;
  const float subOscillator = (subPhase_ < 0.5F ? 1.0F : -1.0F) * subLevel_;
  const float filtered = filter_.process(oscillator + subOscillator, cutoffHz_, resonance_);
  return filtered * envelopeLevel_ * velocity_;
}

bool JunoVoice::stepEnvelopeAndPhase() noexcept {
  if (!active_) {
    return false;
  }

  const float envelopeSeconds = envelopeTarget_ > envelopeLevel_ ? attackSeconds_ : releaseSeconds_;
  const float step =
      std::clamp(1.0F - std::exp(-1.0F / (envelopeSeconds * sampleRate_)), 0.0F, 1.0F);
  envelopeLevel_ += (envelopeTarget_ - envelopeLevel_) * step;

  if (envelopeLevel_ < 1.0e-4F && envelopeTarget_ == 0.0F) {
    active_ = false;
    frequency_ = 0.0F;
    velocity_ = 0.0F;
    return false;
  }

  phase_ += frequency_ / sampleRate_;
  if (phase_ >= 1.0F) {
    phase_ -= std::floor(phase_);
  }
  subPhase_ += (frequency_ * 0.5F) / sampleRate_;
  if (subPhase_ >= 1.0F) {
    subPhase_ -= std::floor(subPhase_);
  }
  return true;
}

}  // namespace daft::audio::juno::detail
