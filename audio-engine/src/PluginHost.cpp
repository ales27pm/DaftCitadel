#include "audio_engine/PluginHost.h"

#include <atomic>

namespace daft::audio {

namespace {
std::atomic<PluginHostBridge::RenderCallback> gRenderCallback{nullptr};
std::atomic<void*> gRenderUserData{nullptr};
}  // namespace

void PluginHostBridge::SetRenderCallback(RenderCallback callback, void* userData) noexcept {
  gRenderUserData.store(userData, std::memory_order_release);
  gRenderCallback.store(callback, std::memory_order_release);
}

void PluginHostBridge::ClearRenderCallback() noexcept {
  SetRenderCallback(nullptr, nullptr);
}

std::optional<PluginRenderResult> PluginHostBridge::Render(PluginRenderRequest& request) noexcept {
  const auto callback = gRenderCallback.load(std::memory_order_acquire);
  if (!callback) {
    return std::nullopt;
  }
  const auto userData = gRenderUserData.load(std::memory_order_acquire);
  try {
    return callback(request, userData);
  } catch (...) {
    return PluginRenderResult{false, false};
  }
}

}  // namespace daft::audio
