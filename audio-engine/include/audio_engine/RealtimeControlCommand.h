#pragma once

#include <cstdint>
#include <type_traits>

#include "audio_engine/instruments/InstrumentNode.h"

namespace daft::audio {

using RealtimeNodeId = std::uint32_t;
using NodeParameterId = std::uint16_t;

inline constexpr RealtimeNodeId kInvalidRealtimeNodeId = 0U;
inline constexpr NodeParameterId kInvalidNodeParameterId = 0U;

enum class RealtimeCommandType : std::uint8_t {
  kScheduleInstrumentEvent,
  kClearInstrumentEvents,
  kScheduleNodeParameter,
  kAllNotesOff,
  kPanicAllInstruments,
  kLocateTransport,
  kSetTransportLoop,
};

struct RealtimeControlCommand {
  RealtimeCommandType type = RealtimeCommandType::kScheduleInstrumentEvent;
  RealtimeNodeId nodeId = kInvalidRealtimeNodeId;
  NodeParameterId parameterId = kInvalidNodeParameterId;
  std::uint64_t frame = 0U;
  std::uint64_t endFrame = 0U;
  double parameterValue = 0.0;
  InstrumentEvent instrumentEvent{};
  bool instrumentFrameIsRelative = false;
  bool enabled = false;
};

static_assert(std::is_trivially_copyable_v<RealtimeControlCommand>);

}  // namespace daft::audio
