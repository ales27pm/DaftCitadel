#include "audio_engine/instruments/juno/detail/JunoVoice.h"

#include <algorithm>
#include <cmath>

namespace daft::audio::juno::detail {

void JunoVoice::prepare(float sampleRate) {
  sampleRate_ = sampleRate;
  filter_.prepare(sampleRate);
  filter_.setCutoffHz(cutoffHz_);
  filter_.setResonance(resonance_);
  updateEnvelopeSteps();
  reset();
}

void JunoVoice::reset() noexcept {
  phase_ = 0.0F;
  subPhase_ = 0.0F;
  envelopeLevel_ = 0.0F;
  envelopeTarget_ = 0.0F;
  baseFrequency_ = 0.0F;
  frequency_ = 0.0F;
  velocity_ = 0.0F;
  pitchBend_ = 0.0F;
  pitchBendMultiplier_ = 1.0F;
  lfoPitchMultiplier_ = 1.0F;
  channelAftertouch_ = 0.0F;
  polyAftertouch_ = 0.0F;
  active_ = false;
  channel_ = 0;
  midiNote_ = 0;
  triggerAge_ = 0;
  filter_.reset();
}

void JunoVoice::noteOn(std::uint8_t channel, std::uint8_t midiNote, float velocity,
                       std::uint64_t triggerAge) noexcept {
  active_ = true;
  velocity_ = std::clamp(velocity, 0.0F, 1.0F);
  channel_ = channel;
  midiNote_ = midiNote;
  triggerAge_ = triggerAge;
  baseFrequency_ =
      440.0F * std::pow(2.0F, (static_cast<float>(midiNote) - 69.0F) / 12.0F);
  setPitchBend(pitchBend_);
  envelopeLevel_ = 0.0F;
  envelopeTarget_ = 1.0F;
  phase_ = 0.0F;
  subPhase_ = 0.0F;
}

bool JunoVoice::noteOff(std::uint8_t channel, std::uint8_t midiNote) noexcept {
  if (!active_ || channel_ != channel || midiNote_ != midiNote) {
    return false;
  }
  release();
  return true;
}

void JunoVoice::setPitchBend(float normalizedBend) noexcept {
  pitchBend_ = std::clamp(normalizedBend, -1.0F, 1.0F);
  constexpr float kPitchBendRangeSemitones = 2.0F;
  pitchBendMultiplier_ =
      std::exp2((pitchBend_ * kPitchBendRangeSemitones) / 12.0F);
  updateFrequency();
}

void JunoVoice::setLfoPitchMultiplier(float multiplier) noexcept {
  lfoPitchMultiplier_ = std::clamp(multiplier, 0.5F, 2.0F);
  updateFrequency();
}

void JunoVoice::updateFrequency() noexcept {
  frequency_ = baseFrequency_ * pitchBendMultiplier_ * lfoPitchMultiplier_;
}

void JunoVoice::setChannelAftertouch(float pressure) noexcept {
  channelAftertouch_ = std::clamp(pressure, 0.0F, 1.0F);
}

void JunoVoice::setPolyAftertouch(float pressure) noexcept {
  polyAftertouch_ = std::clamp(pressure, 0.0F, 1.0F);
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
      filter_.setCutoffHz(cutoffHz_);
      return true;
    case ParameterId::kResonance:
      resonance_ = std::clamp(value, 0.0F, 1.2F);
      filter_.setResonance(resonance_);
      return true;
    case ParameterId::kAttackSeconds:
      attackSeconds_ = std::clamp(value, 0.0005F, 30.0F);
      updateEnvelopeSteps();
      return true;
    case ParameterId::kReleaseSeconds:
      releaseSeconds_ = std::clamp(value, 0.0005F, 30.0F);
      updateEnvelopeSteps();
      return true;
    case ParameterId::kChorusMode:
    case ParameterId::kOutputGain:
    case ParameterId::kLfoRateHz:
    case ParameterId::kLfoDepth:
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
  const float filtered = filter_.process(oscillator + subOscillator);
  constexpr float kMaximumAftertouchGain = 0.25F;
  const float aftertouchGain =
      1.0F + kMaximumAftertouchGain * std::max(channelAftertouch_, polyAftertouch_);
  return filtered * envelopeLevel_ * velocity_ * aftertouchGain;
}

bool JunoVoice::stepEnvelopeAndPhase() noexcept {
  if (!active_) {
    return false;
  }

  const float step = envelopeTarget_ > envelopeLevel_ ? attackStep_ : releaseStep_;
  envelopeLevel_ += (envelopeTarget_ - envelopeLevel_) * step;

  if (envelopeLevel_ < 1.0e-4F && envelopeTarget_ == 0.0F) {
    active_ = false;
    baseFrequency_ = 0.0F;
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

void JunoVoice::updateEnvelopeSteps() noexcept {
  const auto stepForSeconds = [this](float seconds) {
    return std::clamp(1.0F - std::exp(-1.0F / (seconds * sampleRate_)), 0.0F, 1.0F);
  };
  attackStep_ = stepForSeconds(attackSeconds_);
  releaseStep_ = stepForSeconds(releaseSeconds_);
}

}  // namespace daft::audio::juno::detail
