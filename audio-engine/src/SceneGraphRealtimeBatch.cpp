#include "audio_engine/SceneGraph.h"

namespace daft::audio {

bool SceneGraph::applyRealtimeInstrumentBatch(
    RealtimeNodeId nodeId, std::span<const InstrumentEvent> events,
    bool replace) noexcept {
  auto* instrument = instrumentForRealtimeId(nodeId);
  const bool applied =
      instrument != nullptr && instrument->scheduleEvents(events, replace);
  if (!applied) {
    realtimeCommandFailures_.fetch_add(1U, std::memory_order_relaxed);
  }
  return applied;
}

}  // namespace daft::audio
