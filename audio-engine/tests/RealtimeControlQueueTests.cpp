#include "audio_engine/RealtimeControlQueue.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <thread>

namespace daft::audio::tests {
namespace {

struct QueueCommand {
  std::uint64_t sequence = 0U;
  std::uint32_t payload = 0U;
};

void TestQueueCapacityAndFifoOrder() {
  RealtimeSpscQueue<QueueCommand, 4U> queue;
  for (std::uint64_t sequence = 0U; sequence < 4U; ++sequence) {
    if (!queue.tryPush({sequence, static_cast<std::uint32_t>(sequence * 3U)})) {
      throw std::runtime_error("Realtime queue rejected an in-capacity push");
    }
  }
  if (queue.sizeApprox() != 4U || queue.availableCapacityApprox() != 0U) {
    throw std::runtime_error("Realtime queue reported incorrect full capacity");
  }
  if (queue.tryPush({4U, 12U}) || queue.sizeApprox() != 4U) {
    throw std::runtime_error("Realtime queue overflow was not rejected atomically");
  }

  QueueCommand command{};
  for (std::uint64_t expected = 0U; expected < 4U; ++expected) {
    if (!queue.tryPop(command) || command.sequence != expected ||
        command.payload != expected * 3U) {
      throw std::runtime_error("Realtime queue did not preserve FIFO order");
    }
  }
  if (queue.tryPop(command) || queue.sizeApprox() != 0U) {
    throw std::runtime_error("Realtime queue did not become empty after draining");
  }
}

void TestBatchPublicationIsAtomic() {
  RealtimeSpscQueue<QueueCommand, 4U> queue;
  const std::array<QueueCommand, 3U> first = {{{1U, 10U}, {2U, 20U}, {3U, 30U}}};
  const std::array<QueueCommand, 2U> overflow = {{{4U, 40U}, {5U, 50U}}};
  if (!queue.tryPushBatch(first) || queue.sizeApprox() != first.size()) {
    throw std::runtime_error("Realtime queue rejected a valid batch");
  }
  if (queue.tryPushBatch(overflow) || queue.sizeApprox() != first.size()) {
    throw std::runtime_error("Rejected realtime batch partially mutated the queue");
  }

  QueueCommand command{};
  for (const auto& expected : first) {
    if (!queue.tryPop(command) || command.sequence != expected.sequence ||
        command.payload != expected.payload) {
      throw std::runtime_error("Realtime batch publication changed command order");
    }
  }

  if (!queue.tryPushBatch(overflow)) {
    throw std::runtime_error("Realtime queue did not recover capacity after drain");
  }
  queue.discardPublishedFromConsumer();
  if (queue.sizeApprox() != 0U || queue.tryPop(command)) {
    throw std::runtime_error("Consumer cancellation did not discard published commands");
  }
}

void TestConcurrentProducerConsumer() {
  constexpr std::uint64_t kCommandCount = 100000U;
  RealtimeSpscQueue<QueueCommand, 256U> queue;
  std::atomic<bool> begin{false};
  std::atomic<bool> producerFinished{false};
  std::atomic<bool> failed{false};

  std::thread producer([&]() {
    while (!begin.load(std::memory_order_acquire)) {
      std::this_thread::yield();
    }
    for (std::uint64_t sequence = 0U; sequence < kCommandCount; ++sequence) {
      const QueueCommand command{sequence,
                                 static_cast<std::uint32_t>(sequence ^ 0x5a5aU)};
      while (!queue.tryPush(command)) {
        if (failed.load(std::memory_order_acquire)) {
          return;
        }
        std::this_thread::yield();
      }
    }
    producerFinished.store(true, std::memory_order_release);
  });

  std::thread consumer([&]() {
    while (!begin.load(std::memory_order_acquire)) {
      std::this_thread::yield();
    }
    std::uint64_t expected = 0U;
    QueueCommand command{};
    while (expected < kCommandCount) {
      if (!queue.tryPop(command)) {
        if (producerFinished.load(std::memory_order_acquire) &&
            queue.sizeApprox() == 0U) {
          failed.store(true, std::memory_order_release);
          return;
        }
        std::this_thread::yield();
        continue;
      }
      if (command.sequence != expected ||
          command.payload != static_cast<std::uint32_t>(expected ^ 0x5a5aU)) {
        failed.store(true, std::memory_order_release);
        return;
      }
      ++expected;
    }
  });

  begin.store(true, std::memory_order_release);
  producer.join();
  consumer.join();

  if (failed.load(std::memory_order_acquire) || queue.sizeApprox() != 0U) {
    throw std::runtime_error(
        "Concurrent realtime queue producer/consumer lost or reordered commands");
  }
}

void TestRenderStatisticsPercentiles() {
  RealtimeRenderStatistics statistics;
  for (std::uint64_t sample = 1U; sample <= 100U; ++sample) {
    statistics.record(sample);
  }
  const auto snapshot = statistics.snapshot();
  if (snapshot.renderCount != 100U || snapshot.totalRenderMicros != 5050U ||
      snapshot.maximumRenderMicros != 100U) {
    throw std::runtime_error("Realtime render statistics totals are incorrect");
  }
  if (snapshot.p50RenderMicros < 50U || snapshot.p50RenderMicros > 63U ||
      snapshot.p95RenderMicros < 95U || snapshot.p95RenderMicros > 127U ||
      snapshot.p99RenderMicros < 99U || snapshot.p99RenderMicros > 127U) {
    throw std::runtime_error("Realtime render histogram percentiles are incorrect");
  }

  statistics.resetQuiescent();
  const auto reset = statistics.snapshot();
  if (reset.renderCount != 0U || reset.totalRenderMicros != 0U ||
      reset.maximumRenderMicros != 0U || reset.p99RenderMicros != 0U) {
    throw std::runtime_error("Realtime render statistics did not reset");
  }
}

}  // namespace

void RunRealtimeControlQueueTests() {
  TestQueueCapacityAndFifoOrder();
  TestBatchPublicationIsAtomic();
  TestConcurrentProducerConsumer();
  TestRenderStatisticsPercentiles();
}

}  // namespace daft::audio::tests
