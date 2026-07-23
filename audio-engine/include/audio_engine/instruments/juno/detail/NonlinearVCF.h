#pragma once

#include <algorithm>
#include <cmath>

namespace daft::audio::juno::detail {

class NonlinearVCF final {
 public:
  void prepare(float sampleRate) noexcept {
    sampleRate_ = sampleRate;
    reset();
  }

  void reset() noexcept {
    for (auto& stage : stages_) {
      stage = 0.0F;
    }
  }

  [[nodiscard]] float process(float input, float cutoffHz, float resonance) noexcept {
    if (sampleRate_ <= 0.0F) {
      return input;
    }

    cutoffHz = std::clamp(cutoffHz, 20.0F, sampleRate_ * 0.45F);
    resonance = std::clamp(resonance, 0.0F, 1.2F);

    const float normalizedCutoff = cutoffHz / sampleRate_;
    const float pole = std::exp(-2.0F * kPi * normalizedCutoff);
    const float coefficient = 1.0F - pole;
    const float feedback = resonance * 3.5F;
    float stageInput = softClip(input - feedback * stages_[3]);

    for (auto& stage : stages_) {
      stage += coefficient * (stageInput - stage);
      stageInput = stage;
    }
    return softClip(stages_[3]);
  }

 private:
  [[nodiscard]] static float softClip(float value) noexcept { return std::tanh(value * 1.5F); }

  static constexpr float kPi = 3.14159265358979323846F;
  float sampleRate_ = 44100.0F;
  float stages_[4] = {0.0F, 0.0F, 0.0F, 0.0F};
};

}  // namespace daft::audio::juno::detail
