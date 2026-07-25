#pragma once

#include <array>
#include <atomic>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <type_traits>

namespace daft::audio {

// Fixed-capacity single-producer/single-consumer queue for the realtime control
// boundary. Producer and consumer ownership must remain stable for the queue's
// lifetime. Pushes publish only after every copied element is ready, so a batch
// is observed atomically by the audio thread.
template <typename T, std::size_t Capacity>
class RealtimeSpscQueue final {
  static_assert(Capacity > 0U, "RealtimeSpscQueue requires positive capacity");
  static_assert(std::is_trivially_copyable_v<T>,
                "RealtimeSpscQueue payloads must be trivially copyable");

 public:
  static constexpr std::size_t kCapacity = Capacity;

  [[nodiscard]] bool tryPush(const T& value) noexcept {
    return tryPushBatch(std::span<const T>(&value, 1U));
  }

  [[nodiscard]] bool tryPushBatch(std::span<const T> values) noexcept {
    if (values.empty()) {
      return true;
    }

    const std::size_t write = writeIndex_.load(std::memory_order_relaxed);
    const std::size_t read = readIndex_.load(std::memory_order_acquire);
    if (values.size() > AvailableCapacity(write, read)) {
      return false;
    }

    std::size_t cursor = write;
    for (const auto& value : values) {
      storage_[cursor] = value;
      cursor = Increment(cursor);
    }
    writeIndex_.store(cursor, std::memory_order_release);
    return true;
  }

  [[nodiscard]] bool tryPop(T& value) noexcept {
    const std::size_t read = readIndex_.load(std::memory_order_relaxed);
    const std::size_t write = writeIndex_.load(std::memory_order_acquire);
    if (read == write) {
      return false;
    }

    value = storage_[read];
    readIndex_.store(Increment(read), std::memory_order_release);
    return true;
  }

  [[nodiscard]] std::size_t sizeApprox() const noexcept {
    const std::size_t write = writeIndex_.load(std::memory_order_acquire);
    const std::size_t read = readIndex_.load(std::memory_order_acquire);
    return Distance(write, read);
  }

  [[nodiscard]] std::size_t availableCapacityApprox() const noexcept {
    return kCapacity - sizeApprox();
  }

  // Consumer-only cancellation. Existing producer writes published before this
  // call are discarded; a concurrent producer may publish newer commands after
  // the sampled write index and those remain visible.
  void discardPublishedFromConsumer() noexcept {
    readIndex_.store(writeIndex_.load(std::memory_order_acquire),
                     std::memory_order_release);
  }

  // Only call while producer and consumer are both quiescent.
  void resetQuiescent() noexcept {
    readIndex_.store(0U, std::memory_order_relaxed);
    writeIndex_.store(0U, std::memory_order_relaxed);
  }

 private:
  static constexpr std::size_t kStorageSize = Capacity + 1U;

  [[nodiscard]] static constexpr std::size_t Increment(
      std::size_t index) noexcept {
    return index + 1U == kStorageSize ? 0U : index + 1U;
  }

  [[nodiscard]] static constexpr std::size_t Distance(
      std::size_t write, std::size_t read) noexcept {
    return write >= read ? write - read : kStorageSize - read + write;
  }

  [[nodiscard]] static constexpr std::size_t AvailableCapacity(
      std::size_t write, std::size_t read) noexcept {
    return Capacity - Distance(write, read);
  }

  std::array<T, kStorageSize> storage_{};
  alignas(64) std::atomic<std::size_t> writeIndex_{0U};
  alignas(64) std::atomic<std::size_t> readIndex_{0U};
};

struct RealtimeRenderStatisticsSnapshot {
  std::uint64_t renderCount = 0U;
  std::uint64_t totalRenderMicros = 0U;
  std::uint64_t maximumRenderMicros = 0U;
  std::uint64_t p50RenderMicros = 0U;
  std::uint64_t p95RenderMicros = 0U;
  std::uint64_t p99RenderMicros = 0U;
};

// Allocation-free histogram recorded by the callback. Percentiles are computed
// from power-of-two microsecond buckets by the non-realtime diagnostics reader.
class RealtimeRenderStatistics final {
 public:
  static constexpr std::size_t kBucketCount = 32U;

  void record(std::uint64_t renderMicros) noexcept {
    renderCount_.fetch_add(1U, std::memory_order_relaxed);
    totalRenderMicros_.fetch_add(renderMicros, std::memory_order_relaxed);

    std::uint64_t observed = maximumRenderMicros_.load(std::memory_order_relaxed);
    while (observed < renderMicros &&
           !maximumRenderMicros_.compare_exchange_weak(
               observed, renderMicros, std::memory_order_relaxed,
               std::memory_order_relaxed)) {
    }

    buckets_[BucketIndex(renderMicros)].fetch_add(1U,
                                                   std::memory_order_relaxed);
  }

  [[nodiscard]] RealtimeRenderStatisticsSnapshot snapshot() const noexcept {
    RealtimeRenderStatisticsSnapshot result{};
    result.renderCount = renderCount_.load(std::memory_order_acquire);
    result.totalRenderMicros =
        totalRenderMicros_.load(std::memory_order_acquire);
    result.maximumRenderMicros =
        maximumRenderMicros_.load(std::memory_order_acquire);
    if (result.renderCount == 0U) {
      return result;
    }

    result.p50RenderMicros = PercentileUpperBound(result.renderCount, 50U);
    result.p95RenderMicros = PercentileUpperBound(result.renderCount, 95U);
    result.p99RenderMicros = PercentileUpperBound(result.renderCount, 99U);
    return result;
  }

  void resetQuiescent() noexcept {
    renderCount_.store(0U, std::memory_order_relaxed);
    totalRenderMicros_.store(0U, std::memory_order_relaxed);
    maximumRenderMicros_.store(0U, std::memory_order_relaxed);
    for (auto& bucket : buckets_) {
      bucket.store(0U, std::memory_order_relaxed);
    }
  }

 private:
  [[nodiscard]] static constexpr std::size_t BucketIndex(
      std::uint64_t renderMicros) noexcept {
    if (renderMicros == 0U) {
      return 0U;
    }
    const auto width = static_cast<std::size_t>(std::bit_width(renderMicros));
    return width >= kBucketCount ? kBucketCount - 1U : width;
  }

  [[nodiscard]] static constexpr std::uint64_t BucketUpperBound(
      std::size_t bucket) noexcept {
    if (bucket == 0U) {
      return 0U;
    }
    if (bucket >= std::numeric_limits<std::uint64_t>::digits) {
      return std::numeric_limits<std::uint64_t>::max();
    }
    return (std::uint64_t{1U} << bucket) - 1U;
  }

  [[nodiscard]] std::uint64_t PercentileUpperBound(
      std::uint64_t sampleCount, std::uint64_t percentile) const noexcept {
    const std::uint64_t rank =
        (sampleCount * percentile + 99U) / 100U;
    std::uint64_t cumulative = 0U;
    for (std::size_t bucket = 0U; bucket < buckets_.size(); ++bucket) {
      cumulative += buckets_[bucket].load(std::memory_order_acquire);
      if (cumulative >= rank) {
        return BucketUpperBound(bucket);
      }
    }
    return BucketUpperBound(kBucketCount - 1U);
  }

  std::atomic<std::uint64_t> renderCount_{0U};
  std::atomic<std::uint64_t> totalRenderMicros_{0U};
  std::atomic<std::uint64_t> maximumRenderMicros_{0U};
  std::array<std::atomic<std::uint64_t>, kBucketCount> buckets_{};
};

}  // namespace daft::audio
