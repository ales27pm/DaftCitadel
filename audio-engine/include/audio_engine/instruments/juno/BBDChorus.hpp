#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>

class BBDChorus {
 public:
  enum class Mode {
    Off = 0,
    I = 1,
    II = 2
  };

  BBDChorus() = default;

  void configure(float sampleRate) { setSampleRate(sampleRate); }

  void setSampleRate(float sampleRate) {
    sampleRate_ = sampleRate;
    const float maxDelaySec = 0.050f;
    const std::size_t maxSamples = static_cast<std::size_t>(maxDelaySec * sampleRate_) + 4;
    buffer_.assign(maxSamples, 0.0f);
    writeIndex_ = 0;
    lfoPhaseL_ = 0.0f;
    lfoPhaseR_ = 0.5f;
  }

  void setMode(Mode m) { mode_ = m; }
  Mode mode() const { return mode_; }

  void reset() {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    writeIndex_ = 0;
    lfoPhaseL_ = 0.0f;
    lfoPhaseR_ = 0.5f;
  }

  inline void process(float in, float& outL, float& outR) {
    if (buffer_.empty() || sampleRate_ <= 0.0f || mode_ == Mode::Off) {
      outL = in;
      outR = in;
      return;
    }

    const float baseDelayI = 0.012f;
    const float depthI = 0.004f;
    const float baseDelayII = 0.020f;
    const float depthII = 0.008f;
    const float baseDelay = (mode_ == Mode::I) ? baseDelayI : baseDelayII;
    const float depth = (mode_ == Mode::I) ? depthI : depthII;

    const float lfoRateL = 0.6f;
    const float lfoRateR = 1.2f;
    const float lfoL = std::sin(2.0f * kPi * lfoPhaseL_);
    const float lfoR = std::sin(2.0f * kPi * lfoPhaseR_);

    const float delayL = baseDelay + depth * lfoL;
    const float delayR = baseDelay + depth * lfoR;
    const float wetL = readDelayed(delayL);
    const float wetR = readDelayed(delayR);
    const float noise = noiseAmount_ * whiteNoise();

    writeSample(in + noise);
    outL = 0.7f * in + 0.6f * wetL;
    outR = 0.7f * in + 0.6f * wetR;

    const float invSr = 1.0f / sampleRate_;
    lfoPhaseL_ += lfoRateL * invSr;
    lfoPhaseR_ += lfoRateR * invSr;
    if (lfoPhaseL_ >= 1.0f) {
      lfoPhaseL_ -= 1.0f;
    }
    if (lfoPhaseR_ >= 1.0f) {
      lfoPhaseR_ -= 1.0f;
    }
  }

 private:
  float sampleRate_ = 44100.0f;
  Mode mode_ = Mode::Off;
  std::vector<float> buffer_;
  std::size_t writeIndex_ = 0;
  float lfoPhaseL_ = 0.0f;
  float lfoPhaseR_ = 0.5f;
  float noiseAmount_ = 0.003f;
  std::uint32_t noiseState_ = 0x12345678u;

  static inline constexpr float kPi = 3.14159265358979323846f;

  inline void writeSample(float x) {
    if (buffer_.empty()) {
      return;
    }
    buffer_[writeIndex_] = x;
    writeIndex_ = (writeIndex_ + 1) % buffer_.size();
  }

  inline float readDelayed(float delaySeconds) const {
    if (buffer_.empty()) {
      return 0.0f;
    }
    float delaySamples = delaySeconds * sampleRate_;
    if (delaySamples < 0.0f) {
      delaySamples = 0.0f;
    }
    const auto maxDelay = static_cast<float>(buffer_.size() - 2);
    if (delaySamples > maxDelay) {
      delaySamples = maxDelay;
    }

    float readPos = static_cast<float>(writeIndex_) - delaySamples;
    while (readPos < 0.0f) {
      readPos += static_cast<float>(buffer_.size());
    }

    const std::size_t idx0 = static_cast<std::size_t>(readPos) % buffer_.size();
    const std::size_t idx1 = (idx0 + 1) % buffer_.size();
    const float frac = readPos - std::floor(readPos);
    const float s0 = buffer_[idx0];
    const float s1 = buffer_[idx1];
    return s0 + (s1 - s0) * frac;
  }

  inline float whiteNoise() {
    std::uint32_t x = noiseState_;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    noiseState_ = x;
    const std::uint32_t mant = (x & 0x007FFFFFu) | 0x3F800000u;
    float f;
    std::memcpy(&f, &mant, sizeof(float));
    return (f - 1.5f) * 2.0f;
  }
};

