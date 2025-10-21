#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>

#include "audio_engine/Clock.h"

namespace daft::audio {

struct ScheduledEvent {
  std::uint64_t frame = 0;
  std::function<void()> callback{};
};

template <std::size_t MaxEvents>
class RealTimeScheduler {
 public:
  explicit RealTimeScheduler(RenderClock& clock) : clock_(clock) {}

  bool schedule(const ScheduledEvent& event) {
    const auto write = writeIndex_.load(std::memory_order_relaxed);
    const auto read = readIndex_.load(std::memory_order_acquire);
    const auto next = increment(write);
    if (next == read) {
      return false;
    }
    events_[write] = event;
    writeIndex_.store(next, std::memory_order_release);
    return true;
  }

  void dispatchDueEvents() {
    const auto now = clock_.frameTime();
    while (true) {
      const auto read = readIndex_.load(std::memory_order_relaxed);
      const auto write = writeIndex_.load(std::memory_order_acquire);
      if (read == write) {
        break;
      }

      const auto& event = events_[read];
      if (event.frame > now) {
        break;
      }

      if (event.callback) {
        event.callback();
      }
      readIndex_.store(increment(read), std::memory_order_release);
    }
  }

 private:
  RenderClock& clock_;
  static constexpr std::size_t capacity_ = MaxEvents + 1;
  std::array<ScheduledEvent, capacity_> events_{};
  std::atomic<std::size_t> writeIndex_{0};
  std::atomic<std::size_t> readIndex_{0};

  static std::size_t increment(std::size_t value) { return (value + 1) % capacity_; }
};

}  // namespace daft::audio
