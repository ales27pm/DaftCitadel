#pragma once

#include <algorithm>
#include <cmath>

class NonlinearVCF {
 public:
  NonlinearVCF() = default;

  void configure(float sampleRate) {
    sampleRate_ = sampleRate;
    reset();
  }

  void reset() {
    for (auto& stage : stage_) {
      stage = 0.0f;
    }
  }

  float process(float input, float cutoffHz, float resonance) {
    if (sampleRate_ <= 0.0f) {
      return input;
    }
    cutoffHz = std::clamp(cutoffHz, 20.0f, sampleRate_ * 0.45f);
    resonance = std::clamp(resonance, 0.0f, 1.2f);

    const float fc = cutoffHz / sampleRate_;
    const float x = std::exp(-2.0f * kPi * fc);
    const float g = 1.0f - x;
    const float fb = resonance * 3.5f;
    float x_in = softClip(input - fb * stage_[3]);

    for (std::size_t i = 0; i < 4; ++i) {
      stage_[i] = stage_[i] + g * (x_in - stage_[i]);
      x_in = stage_[i];
    }
    return softClip(stage_[3]);
  }

 private:
  float sampleRate_ = 44100.0f;
  float stage_[4] = {0.0f, 0.0f, 0.0f, 0.0f};

  static inline float softClip(float x) {
    return std::tanh(x * 1.5f);
  }

  static inline constexpr float kPi = 3.14159265358979323846f;
};

