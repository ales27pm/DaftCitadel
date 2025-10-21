#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "audio_engine/DSPNode.h"

namespace daft::audio::bridge {

using NodeOptions = std::unordered_map<std::string, double>;

namespace detail {
inline std::string normalize(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

template <typename T>
inline void applyParameters(T& node, const NodeOptions& options, const std::initializer_list<std::string>& excluded = {}) {
  std::unordered_set<std::string> excludedKeys;
  excludedKeys.reserve(excluded.size());
  for (const auto& key : excluded) {
    excludedKeys.insert(key);
  }
  for (const auto& [key, value] : options) {
    if (excludedKeys.count(key) > 0) {
      continue;
    }
    node.setParameter(key, value);
  }
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
    if (const auto it = options.find("inputcount"); it != options.end()) {
      inputCount = std::max<std::size_t>(1, static_cast<std::size_t>(it->second));
    }
    auto node = std::make_unique<daft::audio::MixerNode>(inputCount);
    detail::applyParameters(*node, options, {"inputcount"});
    return node;
  }

  error = "Unsupported node type '" + type + "'";
  return nullptr;
}

}  // namespace daft::audio::bridge
