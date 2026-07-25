#pragma once

#include <cstdint>

namespace daft::audio {

using RealtimeNodeId = std::uint32_t;
using NodeParameterId = std::uint16_t;

inline constexpr RealtimeNodeId kInvalidRealtimeNodeId = 0U;
inline constexpr NodeParameterId kInvalidNodeParameterId = 0U;

}  // namespace daft::audio
