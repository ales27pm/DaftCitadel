#pragma once

#include <algorithm>
#include <cmath>

namespace daft::audio::juno::detail {

class NonlinearVCF final {
 public:
  void prepare(float sampleRate) noexcept {
    sampleRate_ = sampleRate;
    setCutoffHz(cutoffHz_);
    setResonance(resonance_);
    reset();
  }

  void setCutoffHz(float cutoffHz) noexcept {
    cutoffHz_ = std::clamp(cutoffHz, 20.0F, sampleRate_ * 0.45F);
    const float normalizedCutoff = cutoffHz_ / sampleRate_;
    coefficient_ = 1.0F - std::exp(-2.0F * kPi * normalizedCutoff);
  }

  void setResonance(float resonance) noexcept {
    resonance_ = std::clamp(resonance, 0.0F, 1.2F);
    feedback_ = resonance_ * 3.5F;
  }

  void reset() noexcept {
    for (auto& stage : stages_) {
      stage = 0.0F;
    }
  }

  [[nodiscard]] float process(float input) noexcept {
    if (sampleRate_ <= 0.0F) {
      return input;
    }

    float stageInput = softClip(input - feedback_ * stages_[3]);

    for (auto& stage : stages_) {
      stage += coefficient_ * (stageInput - stage);
      stageInput = stage;
    }
    return softClip(stages_[3]);
  }

 private:
  [[nodiscard]] static float softClip(float value) noexcept { return std::tanh(value * 1.5F); }

  static constexpr float kPi = 3.14159265358979323846F;
  float sampleRate_ = 44100.0F;
  float cutoffHz_ = 1000.0F;
  float resonance_ = 0.1F;
  float coefficient_ = 0.0F;
  float feedback_ = 0.35F;
  float stages_[4] = {0.0F, 0.0F, 0.0F, 0.0F};
};

}  // namespace daft::audio::juno::detail
