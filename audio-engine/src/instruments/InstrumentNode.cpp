#include "audio_engine/instruments/InstrumentNode.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace daft::audio {

namespace {

[[nodiscard]] std::uint64_t SaturatingAdd(std::uint64_t value,
                                          std::size_t increment) noexcept {
  const auto maximum = std::numeric_limits<std::uint64_t>::max();
  if (increment > maximum - value) {
    return maximum;
  }
  return value + static_cast<std::uint64_t>(increment);
}

}  // namespace

void InstrumentNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  eventCount_ = 0;
  timelineEventCount_ = 0;
  currentFrame_ = 0;
  prepareInstrument(sampleRate);
}

void InstrumentNode::reset() {
  eventCount_ = 0;
  timelineEventCount_ = 0;
  currentFrame_ = 0;
  resetInstrument();
}

void InstrumentNode::locate(std::uint64_t frame) {
  eventCount_ = 0;
  timelineEventCount_ = 0;
  currentFrame_ = frame;
  resetInstrument();
}

void InstrumentNode::clearScheduledEvents() noexcept {
  eventCount_ = 0U;
  timelineEventCount_ = 0U;
}

void InstrumentNode::rewindTimelineForLoop(std::uint64_t startFrame,
                                           std::uint64_t endFrame) noexcept {
  currentFrame_ = startFrame;
  resetInstrument();
  // Pending live events use absolute transport frames and must not survive a
  // wrap: replaying a touch gesture would create phantom notes, while a note-off
  // beyond the loop end could otherwise leave a voice stuck. Retained song
  // events are reconstructed from the immutable timeline copy instead.
  restoreTimelineRange(startFrame, endFrame);
}

void InstrumentNode::restoreTimelineAfterLoop(std::uint64_t frame) noexcept {
  std::array<InstrumentEvent, kEventCapacity> transientEvents{};
  std::size_t transientCount = 0U;
  for (std::size_t index = 0U; index < eventCount_; ++index) {
    if (!events_[index].retainAcrossPanic) {
      transientEvents[transientCount++] = events_[index];
    }
  }

  restoreTimelineRange(frame, std::numeric_limits<std::uint64_t>::max());
  for (std::size_t index = 0U;
       index < transientCount && eventCount_ < events_.size(); ++index) {
    insertEvent(transientEvents[index]);
  }
}

void InstrumentNode::panic() noexcept {
  resetInstrument();
  std::size_t retained = 0U;
  for (std::size_t index = 0U; index < eventCount_; ++index) {
    if (events_[index].retainAcrossPanic) {
      events_[retained++] = events_[index];
    }
  }
  eventCount_ = retained;
}

void InstrumentNode::process(AudioBufferView buffer) {
  buffer.fill(0.0F);
  const std::size_t frameCount = buffer.frameCount();
  if (frameCount == 0U) {
    return;
  }

  const std::uint64_t blockStart = currentFrame_;
  const std::uint64_t blockEnd = SaturatingAdd(blockStart, frameCount);
  std::size_t offset = 0;
  std::size_t dispatched = 0;

  while (dispatched < eventCount_) {
    const auto& next = events_[dispatched];
    const bool isDue = next.frame <= blockStart || next.frame < blockEnd;
    if (!isDue) {
      break;
    }
    const std::size_t eventOffset =
        next.frame <= blockStart
            ? 0U
            : static_cast<std::size_t>(std::min<std::uint64_t>(
                  next.frame - blockStart, static_cast<std::uint64_t>(frameCount)));
    if (eventOffset > offset) {
      renderInstrument(buffer, offset, eventOffset - offset);
      offset = eventOffset;
    }

    handleInstrumentEvent(next);
    ++dispatched;
  }

  if (offset < frameCount) {
    renderInstrument(buffer, offset, frameCount - offset);
  }
  if (dispatched > 0U) {
    for (std::size_t index = dispatched; index < eventCount_; ++index) {
      events_[index - dispatched] = events_[index];
    }
    eventCount_ -= dispatched;
  }
  currentFrame_ = blockEnd;
}

bool InstrumentNode::scheduleEvent(const InstrumentEvent& event) noexcept {
  return scheduleEvents(std::span<const InstrumentEvent>(&event, 1U));
}

bool InstrumentNode::scheduleEvents(std::span<const InstrumentEvent> events,
                                    bool replace) noexcept {
  const std::size_t retained = replace ? 0U : eventCount_;
  const auto incomingTimeline = static_cast<std::size_t>(std::count_if(
      events.begin(), events.end(),
      [](const InstrumentEvent& event) { return event.retainAcrossPanic; }));
  if (events.size() > events_.size() - retained) {
    return false;
  }
  for (const auto& event : events) {
    if (!isValidEvent(event)) {
      return false;
    }
  }

  if (!replace && incomingTimeline > timelineEvents_.size() - timelineEventCount_) {
    // Repeated realtime append calls are allowed to recycle already-played
    // history. Session timelines use atomic replacement and remain fully
    // retained, while this bounded compaction prevents long live sessions from
    // exhausting the separate loop replay archive.
    const auto reclaimable = static_cast<std::size_t>(std::count_if(
        timelineEvents_.begin(), timelineEvents_.begin() +
                                     static_cast<std::ptrdiff_t>(timelineEventCount_),
        [this](const InstrumentEvent& event) {
          return event.frame < currentFrame_;
        }));
    if (incomingTimeline >
        timelineEvents_.size() - timelineEventCount_ + reclaimable) {
      return false;
    }
    std::size_t retainedTimeline = 0U;
    for (std::size_t index = 0U; index < timelineEventCount_; ++index) {
      if (timelineEvents_[index].frame >= currentFrame_) {
        timelineEvents_[retainedTimeline++] = timelineEvents_[index];
      }
    }
    timelineEventCount_ = retainedTimeline;
  }

  if (replace) {
    eventCount_ = 0U;
    timelineEventCount_ = 0U;
  }
  for (const auto& event : events) {
    insertEvent(event);
    if (event.retainAcrossPanic) {
      insertTimelineEvent(event);
    }
  }
  return true;
}

bool InstrumentNode::isValidEvent(const InstrumentEvent& event) const noexcept {
  if (!std::isfinite(event.value) || !IsValidChannel(event.channel)) {
    return false;
  }
  switch (event.type) {
    case InstrumentEventType::kNoteOn:
    case InstrumentEventType::kNoteOff:
    case InstrumentEventType::kControlChange:
    case InstrumentEventType::kPolyAftertouch:
      if (!IsValidData(event.data) || !IsNormalized(event.value)) {
        return false;
      }
      break;
    case InstrumentEventType::kPitchBend:
      if (event.value < -1.0F || event.value > 1.0F) {
        return false;
      }
      break;
    case InstrumentEventType::kChannelAftertouch:
      if (!IsNormalized(event.value)) {
        return false;
      }
      break;
    case InstrumentEventType::kParameter:
      break;
    case InstrumentEventType::kAllNotesOff:
      break;
    default:
      return false;
  }
  return validateInstrumentEvent(event);
}

void InstrumentNode::insertEvent(const InstrumentEvent& event) noexcept {
  std::size_t insertion = eventCount_;
  while (insertion > 0U && events_[insertion - 1U].frame > event.frame) {
    events_[insertion] = events_[insertion - 1U];
    --insertion;
  }
  events_[insertion] = event;
  ++eventCount_;
}

void InstrumentNode::insertTimelineEvent(const InstrumentEvent& event) noexcept {
  std::size_t insertion = timelineEventCount_;
  while (insertion > 0U && timelineEvents_[insertion - 1U].frame > event.frame) {
    timelineEvents_[insertion] = timelineEvents_[insertion - 1U];
    --insertion;
  }
  timelineEvents_[insertion] = event;
  ++timelineEventCount_;
}

void InstrumentNode::restoreTimelineRange(std::uint64_t startFrame,
                                          std::uint64_t endFrame) noexcept {
  eventCount_ = 0U;
  for (std::size_t index = 0U; index < timelineEventCount_; ++index) {
    const auto& event = timelineEvents_[index];
    if (event.frame >= startFrame && event.frame < endFrame) {
      insertEvent(event);
    }
  }
}

bool InstrumentNode::scheduleNoteOn(std::uint64_t frame, std::uint8_t channel,
                                    std::uint8_t note, float velocity) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kNoteOn, 0U, channel, note, velocity});
}

bool InstrumentNode::scheduleNoteOff(std::uint64_t frame, std::uint8_t channel,
                                     std::uint8_t note, float releaseVelocity) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kNoteOff, 0U, channel, note, releaseVelocity});
}

bool InstrumentNode::scheduleControlChange(std::uint64_t frame, std::uint8_t channel,
                                           std::uint8_t controller, float value) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kControlChange, 0U, channel, controller, value});
}

bool InstrumentNode::schedulePitchBend(std::uint64_t frame, std::uint8_t channel,
                                       float normalizedBend) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kPitchBend, 0U, channel, 0U, normalizedBend});
}

bool InstrumentNode::scheduleChannelAftertouch(std::uint64_t frame,
                                               std::uint8_t channel,
                                               float pressure) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kChannelAftertouch, 0U, channel, 0U, pressure});
}

bool InstrumentNode::schedulePolyAftertouch(std::uint64_t frame, std::uint8_t channel,
                                            std::uint8_t note, float pressure) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kPolyAftertouch, 0U, channel, note, pressure});
}

bool InstrumentNode::scheduleParameter(std::uint64_t frame, std::uint16_t parameter,
                                       float value) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kParameter, parameter, 0U, 0U, value});
}

bool InstrumentNode::scheduleAllNotesOff(std::uint64_t frame,
                                         std::uint8_t channel) noexcept {
  return scheduleEvent(
      {frame, InstrumentEventType::kAllNotesOff, 0U, channel, 0U, 0.0F});
}

bool InstrumentNode::IsNormalized(float value) noexcept {
  return value >= 0.0F && value <= 1.0F;
}

bool InstrumentNode::IsValidChannel(std::uint8_t channel) noexcept {
  return channel <= kMaximumMidiChannel;
}

bool InstrumentNode::IsValidData(std::uint8_t data) noexcept {
  return data <= kMaximumMidiData;
}

}  // namespace daft::audio
