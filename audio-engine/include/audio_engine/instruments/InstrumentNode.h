#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

#include "audio_engine/DSPNode.h"

namespace daft::audio {

enum class InstrumentEventType : std::uint8_t {
  kNoteOn,
  kNoteOff,
  kControlChange,
  kPitchBend,
  kChannelAftertouch,
  kPolyAftertouch,
  kParameter,
  kAllNotesOff,
};

// MIDI channels use their wire-format zero-based range (0-15). Normalized
// velocity, controller, and aftertouch values use [0, 1], while pitch bend uses
// [-1, 1]. Parameter identifiers are instrument-specific numeric values. Batch
// timeline events retain across transport panic by default; live scheduling
// paths mark their copies transient.
struct InstrumentEvent {
  std::uint64_t frame = 0;
  InstrumentEventType type = InstrumentEventType::kNoteOn;
  std::uint16_t parameter = 0;
  std::uint8_t channel = 0;
  std::uint8_t data = 0;
  float value = 0.0F;
  bool retainAcrossPanic = true;
};

// Source-node foundation for portable instruments. The fixed-capacity event
// queue is stable-sorted by absolute frame and never allocates. Direct callers
// must serialize scheduling and process(); platform bridges use the dedicated
// SPSC command boundary before mutating this consumer-owned queue.
class InstrumentNode : public DSPNode {
 public:
  // 1024 events keeps dense MIDI clips practical while retaining a fixed,
  // inspectable per-node memory bound (no queue growth at runtime).
  static constexpr std::size_t kEventCapacity = 1024;
  static constexpr std::uint8_t kMaximumMidiChannel = 15;
  static constexpr std::uint8_t kMaximumMidiData = 127;

  void prepare(double sampleRate) override;
  void reset() noexcept override;
  void locate(std::uint64_t frame) noexcept override;
  void process(AudioBufferView buffer) noexcept final;

  [[nodiscard]] bool scheduleEvent(const InstrumentEvent& event) noexcept;
  [[nodiscard]] bool scheduleEvents(std::span<const InstrumentEvent> events,
                                     bool replace = false) noexcept;
  [[nodiscard]] bool replaceScheduledEvents(
      std::span<const InstrumentEvent> events) noexcept {
    return scheduleEvents(events, true);
  }
  [[nodiscard]] bool scheduleNoteOn(std::uint64_t frame,
                                    std::uint8_t channel,
                                    std::uint8_t note,
                                    float velocity) noexcept;
  [[nodiscard]] bool scheduleNoteOff(
      std::uint64_t frame, std::uint8_t channel, std::uint8_t note,
      float releaseVelocity = 0.0F) noexcept;
  [[nodiscard]] bool scheduleControlChange(std::uint64_t frame,
                                           std::uint8_t channel,
                                           std::uint8_t controller,
                                           float value) noexcept;
  [[nodiscard]] bool schedulePitchBend(std::uint64_t frame,
                                       std::uint8_t channel,
                                       float normalizedBend) noexcept;
  [[nodiscard]] bool scheduleChannelAftertouch(std::uint64_t frame,
                                               std::uint8_t channel,
                                               float pressure) noexcept;
  [[nodiscard]] bool schedulePolyAftertouch(std::uint64_t frame,
                                            std::uint8_t channel,
                                            std::uint8_t note,
                                            float pressure) noexcept;
  [[nodiscard]] bool scheduleParameter(std::uint64_t frame,
                                       std::uint16_t parameter,
                                       float value) noexcept;
  [[nodiscard]] bool scheduleAllNotesOff(std::uint64_t frame,
                                         std::uint8_t channel) noexcept;

  void clearScheduledEvents() noexcept;
  [[nodiscard]] std::size_t pendingEventCount() const noexcept {
    return eventCount_;
  }
  [[nodiscard]] std::uint64_t currentFrame() const noexcept {
    return currentFrame_;
  }
  [[nodiscard]] bool validateEvent(const InstrumentEvent& event) const noexcept {
    return isValidEvent(event);
  }
  [[nodiscard]] virtual std::size_t activeVoiceCount() const noexcept {
    return 0U;
  }

  // Transport loops rewind retained timeline events without replaying transient
  // live input. The graph calls these only while it owns the render/control lane.
  void rewindTimelineForLoop(std::uint64_t startFrame,
                             std::uint64_t endFrame) noexcept;
  void restoreTimelineAfterLoop(std::uint64_t frame) noexcept;

  // Immediately clears voices/effect history without moving the timeline.
  // Transient live input is canceled so stale gestures cannot replay; timeline
  // events remain queued at every frame. Musical all-notes-off remains release-based.
  void panic() noexcept;
  [[nodiscard]] virtual bool setImmediateParameter(std::uint16_t parameter,
                                                   float value) noexcept {
    static_cast<void>(parameter);
    static_cast<void>(value);
    return false;
  }
  virtual void allNotesOff() noexcept = 0;

 protected:
  virtual void prepareInstrument(double sampleRate) = 0;
  virtual void resetInstrument() noexcept = 0;
  virtual void renderInstrument(AudioBufferView buffer,
                                std::size_t frameOffset,
                                std::size_t frameCount) noexcept = 0;
  virtual void handleInstrumentEvent(const InstrumentEvent& event) noexcept = 0;
  [[nodiscard]] virtual bool validateInstrumentEvent(
      const InstrumentEvent& event) const noexcept {
    static_cast<void>(event);
    return true;
  }

 private:
  [[nodiscard]] static bool IsNormalized(float value) noexcept;
  [[nodiscard]] static bool IsValidChannel(std::uint8_t channel) noexcept;
  [[nodiscard]] static bool IsValidData(std::uint8_t data) noexcept;
  [[nodiscard]] bool isValidEvent(const InstrumentEvent& event) const noexcept;
  void insertEvent(const InstrumentEvent& event) noexcept;
  void insertTimelineEvent(const InstrumentEvent& event) noexcept;
  void restoreTimelineRange(std::uint64_t startFrame,
                            std::uint64_t endFrame) noexcept;

  std::array<InstrumentEvent, kEventCapacity> events_{};
  std::size_t eventCount_ = 0;
  // Retained events are the immutable song timeline. The active queue above is
  // still consumed normally, while this bounded copy lets native transport
  // wraps repopulate a loop without a JS-thread reschedule.
  std::array<InstrumentEvent, kEventCapacity> timelineEvents_{};
  std::size_t timelineEventCount_ = 0;
  std::uint64_t currentFrame_ = 0;
};

}  // namespace daft::audio
