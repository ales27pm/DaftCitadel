#pragma once

#include <cstdint>
#include <type_traits>

#include "audio_engine/RealtimeTypes.h"
#include "audio_engine/instruments/InstrumentNode.h"

namespace daft::audio {

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
  bool frameIsRelative = false;
  bool enabled = false;
};

static_assert(std::is_trivially_copyable_v<RealtimeControlCommand>);

}  // namespace daft::audio
