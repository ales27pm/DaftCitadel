#include "audio_engine/Scheduler.h"

#include <stdexcept>
#include <vector>

namespace daft::audio::tests {

void RunSchedulerTests() {
  RenderClock clock(48000.0, 64);
  RealTimeScheduler<8> scheduler(clock);

  bool immediateTriggered = false;
  scheduler.schedule({clock.frameTime(), [&]() { immediateTriggered = true; }});
  scheduler.dispatchDueEvents();
  if (!immediateTriggered) {
    throw std::runtime_error("Immediate event was not dispatched");
  }

  bool delayedTriggered = false;
  scheduler.schedule({clock.frameTime() + 128, [&]() { delayedTriggered = true; }});
  scheduler.dispatchDueEvents();
  if (delayedTriggered) {
    throw std::runtime_error("Delayed event dispatched too early");
  }
  clock.advanceBy(64);
  scheduler.dispatchDueEvents();
  if (delayedTriggered) {
    throw std::runtime_error("Delayed event dispatched before frame reached");
  }
  clock.advanceBy(64);
  scheduler.dispatchDueEvents();
  if (!delayedTriggered) {
    throw std::runtime_error("Delayed event was not dispatched");
  }

  const auto baseFrame = clock.frameTime();
  std::vector<int> order;
  scheduler.schedule({baseFrame + 32, [&]() { order.push_back(1); }});
  scheduler.schedule({baseFrame + 64, [&]() { order.push_back(2); }});
  scheduler.schedule({baseFrame + 96, [&]() { order.push_back(3); }});
  scheduler.dispatchDueEvents();
  if (!order.empty()) {
    throw std::runtime_error("Future events dispatched too early");
  }
  clock.advanceBy(32);
  scheduler.dispatchDueEvents();
  if (order != std::vector<int>{1}) {
    throw std::runtime_error("Event ordering incorrect at first dispatch");
  }
  clock.advanceBy(32);
  scheduler.dispatchDueEvents();
  if (order != std::vector<int>{1, 2}) {
    throw std::runtime_error("Event ordering incorrect at second dispatch");
  }
  clock.advanceBy(64);
  scheduler.dispatchDueEvents();
  if (order != std::vector<int>{1, 2, 3}) {
    throw std::runtime_error("Unexpected events dispatched");
  }
}

}  // namespace daft::audio::tests
