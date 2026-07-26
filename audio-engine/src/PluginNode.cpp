#include "audio_engine/PluginNode.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <limits>
#include <utility>

#if defined(__ANDROID__)
#include <android/log.h>
#elif defined(__APPLE__)
#include <TargetConditionals.h>
#include <os/log.h>
#endif

namespace daft::audio {
namespace {
constexpr const char* kLogTag = "DaftAudioEngine";

#if defined(__ANDROID__)
void LogPluginError(const char* message, const std::string& instanceId) {
  __android_log_print(ANDROID_LOG_ERROR, kLogTag, "%s (hostInstanceId=%s)", message, instanceId.c_str());
}
#elif defined(__APPLE__)
os_log_t PluginLogger() {
  static os_log_t logger = os_log_create("com.daft.audio", "plugin");
  return logger;
}

void LogPluginError(const char* message, const std::string& instanceId) {
  os_log_error(PluginLogger(), "%{public}s (hostInstanceId=%{public}s)", message, instanceId.c_str());
}
#else
void LogPluginError(const char* message, const std::string& instanceId) {
  std::fprintf(stderr, "PluginNode error: %s (hostInstanceId=%s)\n", message, instanceId.c_str());
}
#endif
}  // namespace

PluginNode::PluginNode(std::string hostInstanceId, PluginBusCapabilities capabilities)
    : hostInstanceId_(std::move(hostInstanceId)), capabilities_(capabilities) {}

void PluginNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  resetFailureFlags();
}

void PluginNode::reset() { resetFailureFlags(); }

void PluginNode::process(AudioBufferView buffer) {
  if (buffer.frameCount() == 0 || buffer.channelCount() == 0) {
    return;
  }

  if (bypassed_.load(std::memory_order_acquire)) {
    return;
  }

  if (hostInstanceId_.empty()) {
    logHostUnavailable();
    return;
  }

  PluginRenderRequest request{hostInstanceId_, buffer, sampleRate(), capabilities_, false};
  const auto result = PluginHostBridge::Render(request);
  if (!result.has_value()) {
    logHostUnavailable();
    return;
  }

  hostUnavailableLogged_.store(false, std::memory_order_release);

  if (!result->success) {
    logRenderFailure();
    return;
  }

  renderFailureLogged_.store(false, std::memory_order_release);

  if (result->pluginBypassed) {
    return;
  }
}

void PluginNode::setParameter(const std::string& name, double value) {
  const auto lowered = toLower(name);
  if (lowered == "bypass" || lowered == "bypassed") {
    setBypassed(truthy(value));
    return;
  }
  if (lowered == "hostinstanceid" && std::isfinite(value)) {
    const auto rounded = static_cast<std::uint64_t>(std::llround(std::fabs(value)));
    if (rounded > 0) {
      setHostInstanceId(std::to_string(rounded));
    }
    return;
  }
}

void PluginNode::setHostInstanceId(std::string hostInstanceId) {
  hostInstanceId_ = std::move(hostInstanceId);
  hostUnavailableLogged_.store(false, std::memory_order_release);
}

void PluginNode::setBypassed(bool bypassed) noexcept {
  bypassed_.store(bypassed, std::memory_order_release);
}

void PluginNode::logHostUnavailable() const noexcept {
  bool expected = false;
  if (hostUnavailableLogged_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
    LogPluginError("Plugin host unavailable", hostInstanceId_);
  }
}

void PluginNode::logRenderFailure() const noexcept {
  bool expected = false;
  if (renderFailureLogged_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
    LogPluginError("Plugin host render failed", hostInstanceId_);
  }
}

void PluginNode::resetFailureFlags() noexcept {
  hostUnavailableLogged_.store(false, std::memory_order_release);
  renderFailureLogged_.store(false, std::memory_order_release);
}

bool PluginNode::truthy(double value) noexcept { return std::fabs(value) > std::numeric_limits<double>::epsilon(); }

std::string PluginNode::toLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

}  // namespace daft::audio
