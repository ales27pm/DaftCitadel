#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cctype>
#include <cstddef>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "audio_engine/DSPNode.h"
#include "audio_engine/PluginNode.h"

#if defined(__ANDROID__)
#include "../android/AudioEngineBridge.h"
#else
#include "../ios/AudioEngineBridge.hpp"
#endif

/**
 * Create a DSPNode instance matching the given node type.
 *
 * Creates and configures a concrete daft::audio::DSPNode (e.g., GainNode, SineOscillatorNode, MixerNode)
 * based on a case-insensitive type name and applies parameters from `options`.
 * For mixer nodes the "inputcount" option (if present) determines the number of inputs and is not applied as a parameter.
 *
 * @param type Case-insensitive name of the node type to create (e.g., "gain", "sine", "mixer").
 * @param options Mapping of parameter names to numeric and string values to apply to the created node.
 * @param error Set to a human-readable message if the requested type is unsupported; left unchanged on success.
 * @returns A unique_ptr to the created DSPNode on success, or `nullptr` if the type is unsupported.
 */
namespace daft::audio::bridge {

struct NodeOptions {
  std::unordered_map<std::string, double> numeric;
  std::unordered_map<std::string, std::string> strings;

  void setNumeric(std::string key, double value) { numeric[std::move(key)] = value; }
  void setString(std::string key, std::string value) { strings[std::move(key)] = std::move(value); }

  [[nodiscard]] std::optional<double> numericValue(const std::string& key) const {
    if (const auto it = numeric.find(key); it != numeric.end()) {
      return it->second;
    }
    return std::nullopt;
  }

  [[nodiscard]] std::optional<std::string> stringValue(const std::string& key) const {
    if (const auto it = strings.find(key); it != strings.end()) {
      return it->second;
    }
    return std::nullopt;
  }
};

namespace detail {
inline std::string normalize(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

bool parseBoolean(const NodeOptions& options, const std::string& key, bool defaultValue = false);
std::optional<std::string> stringFromOptions(const NodeOptions& options, const std::string& key);

template <typename T>
inline void applyParameters(T& node, const NodeOptions& options, const std::initializer_list<std::string>& excluded = {}) {
  std::unordered_set<std::string> excludedKeys;
  excludedKeys.reserve(excluded.size());
  for (const auto& key : excluded) {
    excludedKeys.insert(key);
  }
  for (const auto& [key, value] : options.numeric) {
    if (excludedKeys.count(key) > 0) {
      continue;
    }
    node.setParameter(key, value);
  }
}

inline std::optional<std::string> toIntegerString(double value) {
  if (!std::isfinite(value) || value < 0.0) {
    return std::nullopt;
  }
  const double clamped = std::min(value, static_cast<double>(std::numeric_limits<std::uint64_t>::max()));
  const auto rounded = static_cast<std::uint64_t>(std::floor(clamped + 0.5));
  return std::to_string(rounded);
}

inline std::optional<std::size_t> toSizeT(double value) {
  if (!std::isfinite(value) || value < 0.0) {
    return std::nullopt;
  }
  const double clamped = std::min(value, static_cast<double>(std::numeric_limits<std::size_t>::max()));
  return static_cast<std::size_t>(std::floor(clamped + 0.5));
}

inline std::optional<std::string> clipBufferKeyFromOptions(const NodeOptions& options) {
  if (auto key = options.stringValue("bufferkey")) {
    if (!key->empty()) {
      return key;
    }
  }
  if (auto numeric = options.numericValue("bufferkey")) {
    return toIntegerString(*numeric);
  }
  return std::nullopt;
}
}  // namespace detail

inline std::unique_ptr<daft::audio::DSPNode> CreateNode(const std::string& type,
                                                        const NodeOptions& options,
                                                        std::string& error) {
  const auto normalized = detail::normalize(type);
  if (normalized == "gain" || normalized == "gainnode") {
    auto node = std::make_unique<daft::audio::GainNode>();
    detail::applyParameters(*node, options, {});
    return node;
  }
  if (normalized == "sine" || normalized == "sineoscillator" || normalized == "oscillator") {
    auto node = std::make_unique<daft::audio::SineOscillatorNode>();
    detail::applyParameters(*node, options, {});
    return node;
  }
  if (normalized == "mixer" || normalized == "mixernode") {
    std::size_t inputCount = 2;
    if (const auto value = options.numericValue("inputcount")) {
      inputCount = std::max<std::size_t>(1, static_cast<std::size_t>(*value));
    }
    auto node = std::make_unique<daft::audio::MixerNode>(inputCount);
    detail::applyParameters(*node, options, {"inputcount"});
    return node;
  }
  if (normalized == "clipplayer" || normalized == "clip") {
    auto key = detail::clipBufferKeyFromOptions(options);
    if (!key || key->empty()) {
      error = "clipPlayer requires a bufferKey option";
      return nullptr;
    }
    auto clipBuffer = AudioEngineBridge::clipBufferForKey(*key);
    if (!clipBuffer) {
      error = "clip buffer '" + *key + "' is not registered";
      return nullptr;
    }

    if (auto sampleRate = options.numericValue("buffersamplerate")) {
      if (std::fabs(*sampleRate - clipBuffer->sampleRate) > 1e-3) {
        error = "clip buffer '" + *key + "' sample rate mismatch";
        return nullptr;
      }
    }

    daft::audio::ClipPlayerNode::ClipBufferData descriptor;
    descriptor.key = *key;
    descriptor.sampleRate = clipBuffer->sampleRate;
    descriptor.frameCount = clipBuffer->frameCount;
    descriptor.owner =
        std::const_pointer_cast<void>(std::static_pointer_cast<const void>(clipBuffer));
    const auto channelCount = clipBuffer->channelCount();
    if (channelCount == 0 || clipBuffer->frameCount == 0) {
      error = "clip buffer '" + *key + "' has no audio data";
      return nullptr;
    }
    if (auto declaredChannels = options.numericValue("bufferchannels")) {
      if (const auto expected = detail::toSizeT(*declaredChannels)) {
        if (*expected != channelCount) {
          error = "clip buffer '" + *key + "' channel count mismatch";
          return nullptr;
        }
      }
    }
    if (auto declaredFrames = options.numericValue("bufferframes")) {
      if (const auto expected = detail::toSizeT(*declaredFrames)) {
        if (*expected != clipBuffer->frameCount) {
          error = "clip buffer '" + *key + "' frame count mismatch";
          return nullptr;
        }
      }
    }
    descriptor.channels.reserve(channelCount);
    for (std::size_t channel = 0; channel < channelCount; ++channel) {
      const auto span = clipBuffer->channel(channel);
      if (span.size() < clipBuffer->frameCount) {
        error = "clip buffer '" + *key + "' has insufficient samples";
        return nullptr;
      }
      descriptor.channels.push_back(span.data());
    }

    auto node = std::make_unique<daft::audio::ClipPlayerNode>();
    node->setClipBuffer(std::move(descriptor));
    detail::applyParameters(*node, options, {"bufferkey"});
    return node;
  }

  if (normalized == "plugin" || normalized.rfind("plugin:", 0) == 0 || normalized == "pluginnode") {
    auto hostId = detail::stringFromOptions(options, "hostinstanceid");
    if (!hostId || hostId->empty()) {
      error = "plugin nodes require a hostInstanceId option";
      return nullptr;
    }

    daft::audio::PluginBusCapabilities capabilities{};
    const std::array<std::pair<const char*, bool*>, 6> capabilityMap = {{
        {"acceptsaudio", &capabilities.acceptsAudio},
        {"emitsaudio", &capabilities.emitsAudio},
        {"acceptsmidi", &capabilities.acceptsMidi},
        {"emitsmidi", &capabilities.emitsMidi},
        {"acceptssidechain", &capabilities.acceptsSidechain},
        {"emitssidechain", &capabilities.emitsSidechain},
    }};
    for (const auto& [key, flag] : capabilityMap) {
      *flag = detail::parseBoolean(options, key);
    }

    auto node = std::make_unique<daft::audio::PluginNode>(*hostId, capabilities);
    detail::applyParameters(*node, options,
                           {"hostinstanceid", "acceptsaudio", "emitsaudio", "acceptsmidi", "emitsmidi",
                            "acceptssidechain", "emitssidechain"});
    return node;
  }

  error = "Unsupported node type '" + type + "'";
  return nullptr;
}

}  // namespace daft::audio::bridge