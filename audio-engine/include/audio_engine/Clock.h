#pragma once

#include <atomic>
#include <cstdint>

namespace daft::audio {

class RenderClock {
 public:
  RenderClock(double sampleRate, std::uint32_t framesPerBuffer)
      : sampleRate_(sampleRate), framesPerBuffer_(framesPerBuffer) {}

  [[nodiscard]] double sampleRate() const { return sampleRate_; }

  [[nodiscard]] std::uint64_t frameTime() const { return frameTime_.load(std::memory_order_relaxed); }

  void advance() { frameTime_.fetch_add(framesPerBuffer_, std::memory_order_relaxed); }

  [[nodiscard]] std::uint32_t framesPerBuffer() const { return framesPerBuffer_; }

 private:
  double sampleRate_;
  std::uint32_t framesPerBuffer_;
  std::atomic<std::uint64_t> frameTime_{0};
};

}  // namespace daft::audio
