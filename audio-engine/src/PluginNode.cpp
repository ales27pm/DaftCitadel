#include "audio_engine/PluginNode.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility>

namespace daft::audio {

PluginNode::PluginNode(std::string hostInstanceId,
                       PluginBusCapabilities capabilities)
    : hostInstanceId_(std::move(hostInstanceId)),
      capabilities_(capabilities) {}

void PluginNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  unavailableRenderCount_.store(0U, std::memory_order_relaxed);
  failedRenderCount_.store(0U, std::memory_order_relaxed);
}

void PluginNode::reset() noexcept {
  unavailableRenderCount_.store(0U, std::memory_order_relaxed);
  failedRenderCount_.store(0U, std::memory_order_relaxed);
}

void PluginNode::process(AudioBufferView buffer) noexcept {
  if (buffer.frameCount() == 0U || buffer.channelCount() == 0U ||
      bypassed_.load(std::memory_order_acquire)) {
    return;
  }

  if (hostInstanceId_.empty()) {
    unavailableRenderCount_.fetch_add(1U, std::memory_order_relaxed);
    return;
  }

  PluginRenderRequest request{hostInstanceId_, buffer, sampleRate(),
                              capabilities_, false};
  const auto result = PluginHostBridge::Render(request);
  if (!result.has_value()) {
    unavailableRenderCount_.fetch_add(1U, std::memory_order_relaxed);
    return;
  }

  if (!result->success) {
    failedRenderCount_.fetch_add(1U, std::memory_order_relaxed);
    return;
  }
}

void PluginNode::setParameter(const std::string& name, double value) {
  const auto lowered = toLower(name);
  const auto parameter = resolveParameterId(lowered);
  if (parameter) {
    (void)setParameterById(*parameter, value);
    return;
  }
  if (lowered == "hostinstanceid" && std::isfinite(value)) {
    const auto rounded =
        static_cast<std::uint64_t>(std::llround(std::fabs(value)));
    if (rounded > 0U) {
      setHostInstanceId(std::to_string(rounded));
    }
  }
}

std::optional<NodeParameterId> PluginNode::resolveParameterId(
    std::string_view name) const noexcept {
  if (name == "bypass" || name == "bypassed") {
    return kBypassParameterId;
  }
  return std::nullopt;
}

bool PluginNode::setParameterById(NodeParameterId parameter,
                                  double value) noexcept {
  if (parameter != kBypassParameterId || !std::isfinite(value)) {
    return false;
  }
  setBypassed(truthy(value));
  return true;
}

void PluginNode::setHostInstanceId(std::string hostInstanceId) {
  hostInstanceId_ = std::move(hostInstanceId);
  unavailableRenderCount_.store(0U, std::memory_order_relaxed);
}

void PluginNode::setBypassed(bool bypassed) noexcept {
  bypassed_.store(bypassed, std::memory_order_release);
}

bool PluginNode::truthy(double value) noexcept {
  return std::fabs(value) > std::numeric_limits<double>::epsilon();
}

std::string PluginNode::toLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) {
                   return static_cast<char>(std::tolower(c));
                 });
  return value;
}

}  // namespace daft::audio
