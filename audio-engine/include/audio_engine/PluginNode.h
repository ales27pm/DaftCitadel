#pragma once

#include <atomic>
#include <optional>
#include <string>
#include <string_view>

#include "audio_engine/DSPNode.h"
#include "audio_engine/PluginHost.h"

namespace daft::audio {

class PluginNode final : public DSPNode {
 public:
  explicit PluginNode(std::string hostInstanceId,
                      PluginBusCapabilities capabilities);

  void prepare(double sampleRate) override;
  void reset() noexcept override;
  void process(AudioBufferView buffer) noexcept override;
  void setParameter(const std::string& name, double value) override;
  [[nodiscard]] std::optional<NodeParameterId> resolveParameterId(
      std::string_view name) const noexcept override;
  [[nodiscard]] bool setParameterById(NodeParameterId parameter,
                                      double value) noexcept override;

  void setHostInstanceId(std::string hostInstanceId);
  [[nodiscard]] const std::string& hostInstanceId() const noexcept {
    return hostInstanceId_;
  }

  void setBypassed(bool bypassed) noexcept;
  [[nodiscard]] bool bypassed() const noexcept {
    return bypassed_.load(std::memory_order_relaxed);
  }

  [[nodiscard]] const PluginBusCapabilities& capabilities() const noexcept {
    return capabilities_;
  }
  [[nodiscard]] std::uint64_t unavailableRenderCount() const noexcept {
    return unavailableRenderCount_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t failedRenderCount() const noexcept {
    return failedRenderCount_.load(std::memory_order_relaxed);
  }

 private:
  static constexpr NodeParameterId kBypassParameterId = 1U;

  static bool truthy(double value) noexcept;
  static std::string toLower(std::string value);

  std::string hostInstanceId_;
  PluginBusCapabilities capabilities_;
  std::atomic<bool> bypassed_{false};
  std::atomic<std::uint64_t> unavailableRenderCount_{0U};
  std::atomic<std::uint64_t> failedRenderCount_{0U};
};

}  // namespace daft::audio
