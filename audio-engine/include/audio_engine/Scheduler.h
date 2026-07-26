#pragma once

#include <algorithm>
#include <array>
#include <functional>
#include <cstdint>

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
    if (eventCount_ >= MaxEvents) {
      return false;
    }
    events_[eventCount_] = event;
    ++eventCount_;
    return true;
  }

  void dispatchDueEvents() {
    if (eventCount_ == 0U) {
      return;
    }

    const auto now = clock_.frameTime();
    const auto end = events_.begin() + eventCount_;
    std::sort(events_.begin(), end,
              [](const ScheduledEvent& a, const ScheduledEvent& b) { return a.frame < b.frame; });

    const auto split = std::partition_point(events_.begin(), end,
                                            [now](const ScheduledEvent& event) {
                                              return event.frame <= now;
                                            });

    for (auto it = events_.begin(); it != split; ++it) {
      if (!it->callback) {
        continue;
      }
      try {
        it->callback();
      } catch (...) {
        // Swallow exceptions to keep the audio thread responsive.
      }
    }

    const auto dueCount = static_cast<std::size_t>(split - events_.begin());
    const auto remainingCount = eventCount_ - dueCount;
    if (remainingCount > 0U) {
      if (dueCount > 0U) {
        std::move(split, end, events_.begin());
      }
    }
    for (std::size_t i = remainingCount; i < eventCount_; ++i) {
      events_[i] = {};
    }
    eventCount_ = remainingCount;
  }

 private:
  RenderClock& clock_;
  std::array<ScheduledEvent, MaxEvents> events_{};
  std::size_t eventCount_ = 0U;
};

}  // namespace daft::audio
