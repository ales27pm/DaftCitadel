#pragma once

#include <cstddef>
#include <optional>
#include <string_view>

#include "audio_engine/AudioBuffer.h"

namespace daft::audio {

struct PluginBusCapabilities {
  bool acceptsAudio = false;
  bool emitsAudio = false;
  bool acceptsMidi = false;
  bool emitsMidi = false;
  bool acceptsSidechain = false;
  bool emitsSidechain = false;
};

struct PluginRenderRequest {
  std::string_view hostInstanceId;
  AudioBufferView audioBuffer;
  double sampleRate = 0.0;
  PluginBusCapabilities capabilities{};
  bool bypassed = false;
};

struct PluginRenderResult {
  bool success = false;
  bool pluginBypassed = false;
};

class PluginHostBridge {
 public:
  using RenderCallback = PluginRenderResult (*)(PluginRenderRequest& request, void* userData);

  static void SetRenderCallback(RenderCallback callback, void* userData = nullptr) noexcept;
  static void ClearRenderCallback() noexcept;
  static std::optional<PluginRenderResult> Render(PluginRenderRequest& request) noexcept;
};

}  // namespace daft::audio
