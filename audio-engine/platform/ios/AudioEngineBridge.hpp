#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include "audio_engine/SceneGraph.h"

namespace daft::audio::bridge {

class AudioEngineBridge {
 public:
  struct RenderDiagnostics {
    std::uint64_t xruns;
    double lastRenderDurationMicros;
    std::size_t clipBufferBytes;
  };

  struct ClipBuffer {
    double sampleRate = 0.0;
    std::size_t frameCount = 0;
    std::vector<std::vector<float>> channelSamples;

    [[nodiscard]] std::size_t channelCount() const { return channelSamples.size(); }
    [[nodiscard]] std::span<const float> channel(std::size_t index) const {
      if (index >= channelSamples.size()) {
        return {};
      }
      return std::span<const float>(channelSamples[index].data(), channelSamples[index].size());
    }
  };

  static void initialize(double sampleRate, std::uint32_t framesPerBuffer);
  static void shutdown();
  static void render(float** outputs, std::size_t channelCount, std::size_t frameCount);

  static bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  static void removeNode(const std::string& id);
  static bool connect(const std::string& source, const std::string& destination);
  static void disconnect(const std::string& source, const std::string& destination);
  static void scheduleParameterAutomation(const std::string& nodeId, const std::string& parameter,
                                          std::uint64_t frame, double value);
  static bool registerClipBuffer(const std::string& key, double sampleRate, std::size_t channelCount,
                                 std::size_t frameCount, std::vector<std::vector<float>> channelData);
  static bool unregisterClipBuffer(const std::string& key);
  static std::shared_ptr<const ClipBuffer> clipBufferForKey(const std::string& key);
  static RenderDiagnostics getDiagnostics();

 private:
  struct ClipBufferEntry {
    std::shared_ptr<ClipBuffer> buffer;
    std::size_t referenceCount = 0;
    std::size_t byteSize = 0;
  };

  struct ParameterAutomationCommand {
    std::string nodeId;
    std::string parameter;
    std::uint64_t frame;
    double value;
  };

  class ParameterAutomationQueue {
   public:
    bool push(ParameterAutomationCommand command) {
      std::lock_guard<std::mutex> lock(mutex_);
      const auto tail = tail_.load(std::memory_order_relaxed);
      const auto nextTail = increment(tail);
      const auto head = head_.load(std::memory_order_acquire);
      if (nextTail == head) {
        return false;
      }
      commands_[tail] = std::move(command);
      tail_.store(nextTail, std::memory_order_release);
      return true;
    }

    bool pop(ParameterAutomationCommand& command) {
      const auto head = head_.load(std::memory_order_acquire);
      const auto tail = tail_.load(std::memory_order_acquire);
      if (head == tail) {
        return false;
      }
      command = std::move(commands_[head]);
      commands_[head] = {};
      head_.store(increment(head), std::memory_order_release);
      return true;
    }

    void reset() {
      head_.store(0, std::memory_order_release);
      tail_.store(0, std::memory_order_release);
    }

   private:
    static constexpr std::size_t kMaxSize = 128;
    static constexpr std::size_t kCapacity = kMaxSize + 1U;

    static std::size_t increment(std::size_t value) { return (value + 1U) % kCapacity; }

    std::array<ParameterAutomationCommand, kCapacity> commands_{};
    std::atomic<std::size_t> head_{0U};
    std::atomic<std::size_t> tail_{0U};
    std::mutex mutex_;
  };

  static void applyParameterAutomation(const std::shared_ptr<SceneGraph>& graph);

  static std::atomic<std::shared_ptr<SceneGraph>> graph_;
  static std::mutex mutex_;
  static std::atomic<std::uint64_t> xruns_;
  static std::atomic<double> lastRenderDurationMicros_;
  static std::unordered_map<std::string, ClipBufferEntry> clipBuffers_;
  static ParameterAutomationQueue commandQueue_;
};

}  // namespace daft::audio::bridge
