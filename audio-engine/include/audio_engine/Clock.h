#pragma once

#include <atomic>
#include <cstdint>
#include <stdexcept>

namespace daft::audio {

class RenderClock {
 public:
  RenderClock(double sampleRate, std::uint32_t framesPerBuffer)
      : sampleRate_(sampleRate), framesPerBuffer_(framesPerBuffer) {
    if (sampleRate <= 0.0 || framesPerBuffer == 0) {
      throw std::invalid_argument("RenderClock requires positive sample rate and buffer size");
    }
  }

  [[nodiscard]] double sampleRate() const noexcept { return sampleRate_; }

  [[nodiscard]] std::uint64_t frameTime() const noexcept {
    return frameTime_.load(std::memory_order_acquire);
  }

  void advance() noexcept {
    frameTime_.fetch_add(framesPerBuffer_, std::memory_order_release);
  }

  void advanceBy(std::uint32_t frames) noexcept {
    frameTime_.fetch_add(frames, std::memory_order_release);
  }

  void locate(std::uint64_t frame) noexcept {
    frameTime_.store(frame, std::memory_order_release);
  }

  void setFramesPerBuffer(std::uint32_t framesPerBuffer) noexcept {
    if (framesPerBuffer != 0U) {
      framesPerBuffer_ = framesPerBuffer;
    }
  }

  [[nodiscard]] std::uint32_t framesPerBuffer() const noexcept {
    return framesPerBuffer_;
  }

 private:
  double sampleRate_;
  std::uint32_t framesPerBuffer_;
  std::atomic<std::uint64_t> frameTime_{0};
};

}  // namespace daft::audio
