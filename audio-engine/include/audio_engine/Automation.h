#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <optional>

namespace daft::audio {

struct AutomationPoint {
  std::uint64_t frame;
  float value;
};

template <std::size_t MaxPoints>
class StaticAutomationLane {
 public:
  StaticAutomationLane() = default;

  bool push(const AutomationPoint& point) {
    auto writeIndex = writeIndex_.load(std::memory_order_relaxed);
    auto readIndex = readIndex_.load(std::memory_order_acquire);
    auto nextWrite = increment(writeIndex);
    if (nextWrite == readIndex) {
      return false;  // full
    }
    points_[writeIndex] = point;
    writeIndex_.store(nextWrite, std::memory_order_release);
    return true;
  }

  [[nodiscard]] std::optional<AutomationPoint> pop() {
    auto readIndex = readIndex_.load(std::memory_order_relaxed);
    auto writeIndex = writeIndex_.load(std::memory_order_acquire);
    if (readIndex == writeIndex) {
      return std::nullopt;
    }
    AutomationPoint point = points_[readIndex];
    readIndex_.store(increment(readIndex), std::memory_order_release);
    return point;
  }

  void clear() {
    readIndex_.store(0, std::memory_order_relaxed);
    writeIndex_.store(0, std::memory_order_relaxed);
  }

 private:
  static constexpr std::size_t capacity_ = MaxPoints + 1;
  std::array<AutomationPoint, capacity_> points_{};
  std::atomic<std::size_t> writeIndex_{0};
  std::atomic<std::size_t> readIndex_{0};

  static std::size_t increment(std::size_t index) { return (index + 1) % capacity_; }
};

}  // namespace daft::audio
