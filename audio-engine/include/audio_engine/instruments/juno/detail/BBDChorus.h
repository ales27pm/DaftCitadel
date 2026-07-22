#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "audio_engine/instruments/juno/JunoDSPEngine.h"

namespace daft::audio::juno::detail {

class BBDChorus final {
 public:
  void prepare(float sampleRate) {
    sampleRate_ = sampleRate;
    constexpr float kMaximumDelaySeconds = 0.050F;
    const auto maximumSamples = static_cast<std::size_t>(kMaximumDelaySeconds * sampleRate_) + 4U;
    buffer_.assign(maximumSamples, 0.0F);
    reset();
  }

  void setMode(ChorusMode mode) noexcept { mode_ = mode; }

  void reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0F);
    writeIndex_ = 0;
    leftLfoPhase_ = 0.0F;
    rightLfoPhase_ = 0.5F;
    noiseState_ = 0x12345678U;
  }

  void process(float input, float& left, float& right) noexcept {
    if (buffer_.empty() || sampleRate_ <= 0.0F || mode_ == ChorusMode::kOff) {
      left = input;
      right = input;
      return;
    }

    constexpr float kBaseDelayI = 0.012F;
    constexpr float kDepthI = 0.004F;
    constexpr float kBaseDelayII = 0.020F;
    constexpr float kDepthII = 0.008F;
    constexpr float kLeftLfoRate = 0.6F;
    constexpr float kRightLfoRate = 1.2F;

    const float baseDelay = mode_ == ChorusMode::kI ? kBaseDelayI : kBaseDelayII;
    const float depth = mode_ == ChorusMode::kI ? kDepthI : kDepthII;
    const float leftLfo = std::sin(2.0F * kPi * leftLfoPhase_);
    const float rightLfo = std::sin(2.0F * kPi * rightLfoPhase_);
    const float wetLeft = readDelayed(baseDelay + depth * leftLfo);
    const float wetRight = readDelayed(baseDelay + depth * rightLfo);
    const float noise = kNoiseAmount * whiteNoise();

    writeSample(input + noise);

    constexpr float kDryMix = 0.7F;
    constexpr float kWetMix = 0.6F;
    left = kDryMix * input + kWetMix * wetLeft;
    right = kDryMix * input + kWetMix * wetRight;

    const float inverseSampleRate = 1.0F / sampleRate_;
    leftLfoPhase_ += kLeftLfoRate * inverseSampleRate;
    rightLfoPhase_ += kRightLfoRate * inverseSampleRate;
    if (leftLfoPhase_ >= 1.0F) {
      leftLfoPhase_ -= 1.0F;
    }
    if (rightLfoPhase_ >= 1.0F) {
      rightLfoPhase_ -= 1.0F;
    }
  }

 private:
  static constexpr float kPi = 3.14159265358979323846F;
  static constexpr float kNoiseAmount = 0.003F;

  void writeSample(float sample) noexcept {
    if (buffer_.empty()) {
      return;
    }
    buffer_[writeIndex_] = sample;
    writeIndex_ = (writeIndex_ + 1U) % buffer_.size();
  }

  [[nodiscard]] float readDelayed(float delaySeconds) const noexcept {
    if (buffer_.empty()) {
      return 0.0F;
    }
    float delaySamples =
        std::clamp(delaySeconds * sampleRate_, 0.0F, static_cast<float>(buffer_.size() - 2U));
    float readPosition = static_cast<float>(writeIndex_) - delaySamples;
    while (readPosition < 0.0F) {
      readPosition += static_cast<float>(buffer_.size());
    }

    const auto firstIndex = static_cast<std::size_t>(readPosition) % buffer_.size();
    const auto secondIndex = (firstIndex + 1U) % buffer_.size();
    const float fraction = readPosition - std::floor(readPosition);
    const float first = buffer_[firstIndex];
    const float second = buffer_[secondIndex];
    return first + (second - first) * fraction;
  }

  [[nodiscard]] float whiteNoise() noexcept {
    std::uint32_t value = noiseState_;
    value ^= value << 13U;
    value ^= value >> 17U;
    value ^= value << 5U;
    noiseState_ = value;

    // The upper 24 bits convert exactly to float, avoiding assumptions about
    // the platform's floating-point bit representation.
    constexpr float kHalfRange = 8388607.5F;
    return static_cast<float>(value >> 8U) / kHalfRange - 1.0F;
  }

  float sampleRate_ = 44100.0F;
  ChorusMode mode_ = ChorusMode::kOff;
  std::vector<float> buffer_;
  std::size_t writeIndex_ = 0;
  float leftLfoPhase_ = 0.0F;
  float rightLfoPhase_ = 0.5F;
  std::uint32_t noiseState_ = 0x12345678U;
};

}  // namespace daft::audio::juno::detail
