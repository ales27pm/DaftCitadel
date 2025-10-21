#pragma once

#include <algorithm>
#include <cstdint>
#include <functional>
#include <vector>

#include "audio_engine/Clock.h"

namespace daft::audio {

struct ScheduledEvent {
  std::uint64_t frame = 0;
  std::function<void()> callback{};
};

template <std::size_t MaxEvents>
class RealTimeScheduler {
 public:
  explicit RealTimeScheduler(RenderClock& clock) : clock_(clock) { events_.reserve(MaxEvents); }

  bool schedule(const ScheduledEvent& event) {
    if (events_.size() >= MaxEvents) {
      return false;
    }
    events_.push_back(event);
    return true;
  }

  void dispatchDueEvents() {
    if (events_.empty()) {
      return;
    }

    const auto now = clock_.frameTime();
    std::sort(events_.begin(), events_.end(),
              [](const ScheduledEvent& a, const ScheduledEvent& b) { return a.frame < b.frame; });

    const auto split = std::partition_point(events_.begin(), events_.end(),
                                            [now](const ScheduledEvent& event) {
                                              return event.frame <= now;
                                            });

    for (auto it = events_.begin(); it != split; ++it) {
      if (it->callback) {
        it->callback();
      }
    }

    events_.erase(events_.begin(), split);
  }

 private:
  RenderClock& clock_;
  std::vector<ScheduledEvent> events_{};
};

}  // namespace daft::audio
