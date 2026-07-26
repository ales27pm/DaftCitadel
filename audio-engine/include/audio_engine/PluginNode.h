#pragma once

#include <atomic>
#include <string>

#include "audio_engine/DSPNode.h"
#include "audio_engine/PluginHost.h"

namespace daft::audio {

class PluginNode final : public DSPNode {
 public:
  explicit PluginNode(std::string hostInstanceId, PluginBusCapabilities capabilities);

  void prepare(double sampleRate) override;
  void reset() override;
  void process(AudioBufferView buffer) override;
  void setParameter(const std::string& name, double value) override;

  void setHostInstanceId(std::string hostInstanceId);
  [[nodiscard]] const std::string& hostInstanceId() const noexcept { return hostInstanceId_; }

  void setBypassed(bool bypassed) noexcept;
  [[nodiscard]] bool bypassed() const noexcept { return bypassed_.load(std::memory_order_relaxed); }

  [[nodiscard]] const PluginBusCapabilities& capabilities() const noexcept { return capabilities_; }

 private:
  void logHostUnavailable() const noexcept;
  void logRenderFailure() const noexcept;
  void resetFailureFlags() noexcept;

  static bool truthy(double value) noexcept;
  static std::string toLower(std::string value);

  std::string hostInstanceId_;
  PluginBusCapabilities capabilities_;
  std::atomic<bool> bypassed_{false};
  mutable std::atomic<bool> hostUnavailableLogged_{false};
  mutable std::atomic<bool> renderFailureLogged_{false};
};

}  // namespace daft::audio
