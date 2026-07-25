#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "audio_engine/instruments/InstrumentNode.h"
#include "audio_engine/instruments/juno/JunoDSPEngine.h"

namespace daft::audio::juno {

// Portable graph-facing Juno source node. MIDI is zero-based by channel,
// pitch bend spans +/-2 semitones, and channel/poly pressure add up to 25% gain
// per voice (the greater of the two pressures wins). CC64 controls sustain;
// CC120 and CC123 perform channel-scoped all-notes-off. The single global LFO
// runs at 0.05-20 Hz; normalized depth 0-1 adds at most +/-2 semitones.
class Juno106Node final : public InstrumentNode {
 public:
  static constexpr std::uint32_t kDefaultMaximumFramesPerBlock = 1024;

  explicit Juno106Node(
      std::uint32_t maximumFramesPerBlock = kDefaultMaximumFramesPerBlock,
      std::size_t polyphony = JunoDSPEngine::kDefaultPolyphony) noexcept;

  // DSPNode compatibility path. Names are lowercase canonical Juno names or a
  // decimal ParameterId. Realtime scheduling uses the numeric overloads.
  void setParameter(const std::string& name, double value) override;
  [[nodiscard]] std::optional<NodeParameterId> resolveParameterId(
      std::string_view name) const noexcept override;
  [[nodiscard]] bool setParameterById(NodeParameterId parameter,
                                      double value) noexcept override;
  [[nodiscard]] bool setParameter(ParameterId parameter, float value) noexcept;
  [[nodiscard]] bool setImmediateParameter(std::uint16_t parameter,
                                           float value) noexcept override;
  [[nodiscard]] bool scheduleParameter(std::uint64_t frame,
                                       ParameterId parameter,
                                       float value) noexcept;

  void allNotesOff() noexcept override;
  [[nodiscard]] bool allNotesOff(std::uint8_t channel) noexcept;

  [[nodiscard]] bool isPrepared() const noexcept { return prepared_; }
  [[nodiscard]] std::size_t activeVoiceCount() const noexcept override;
  [[nodiscard]] std::uint32_t maximumFramesPerBlock() const noexcept {
    return maximumFramesPerBlock_;
  }
  [[nodiscard]] std::size_t polyphony() const noexcept { return polyphony_; }

 protected:
  void prepareInstrument(double sampleRate) override;
  void resetInstrument() noexcept override;
  void renderInstrument(AudioBufferView buffer,
                        std::size_t frameOffset,
                        std::size_t frameCount) noexcept override;
  void handleInstrumentEvent(const InstrumentEvent& event) noexcept override;
  [[nodiscard]] bool validateInstrumentEvent(
      const InstrumentEvent& event) const noexcept override;

 private:
  static constexpr std::size_t kParameterStorageSize =
      static_cast<std::size_t>(ParameterId::kLfoDepth) + 1U;

  std::uint32_t maximumFramesPerBlock_;
  std::size_t polyphony_;
  JunoDSPEngine engine_;
  std::vector<float> scratchLeft_;
  std::vector<float> scratchRight_;
  std::array<float, kParameterStorageSize> configuredParameterValues_{};
  std::array<bool, kParameterStorageSize> configuredParameters_{};
  bool prepared_ = false;
};

}  // namespace daft::audio::juno
