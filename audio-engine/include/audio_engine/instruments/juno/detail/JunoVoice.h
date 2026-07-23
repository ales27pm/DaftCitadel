#pragma once

#include <cstdint>

#include "audio_engine/instruments/juno/JunoDSPEngine.h"
#include "audio_engine/instruments/juno/detail/NonlinearVCF.h"

namespace daft::audio::juno::detail {

class JunoVoice final {
 public:
  void prepare(float sampleRate);
  void reset() noexcept;
  void noteOn(std::uint8_t channel, std::uint8_t midiNote, float velocity,
              std::uint64_t triggerAge) noexcept;
  [[nodiscard]] bool noteOff(std::uint8_t channel, std::uint8_t midiNote) noexcept;
  void release() noexcept;
  [[nodiscard]] bool setParameter(ParameterId parameter, float value) noexcept;
  void setPitchBend(float normalizedBend) noexcept;
  void setLfoPitchMultiplier(float multiplier) noexcept;
  void setChannelAftertouch(float pressure) noexcept;
  void setPolyAftertouch(float pressure) noexcept;
  [[nodiscard]] float processMono() noexcept;

  [[nodiscard]] bool isActive() const noexcept { return active_; }
  [[nodiscard]] std::uint8_t currentChannel() const noexcept { return channel_; }
  [[nodiscard]] std::uint8_t currentNote() const noexcept { return midiNote_; }
  [[nodiscard]] std::uint64_t triggerAge() const noexcept { return triggerAge_; }

 private:
  [[nodiscard]] bool stepEnvelopeAndPhase() noexcept;
  void updateEnvelopeSteps() noexcept;
  void updateFrequency() noexcept;

  float sampleRate_ = 44100.0F;
  float phase_ = 0.0F;
  float subPhase_ = 0.0F;
  float envelopeLevel_ = 0.0F;
  float envelopeTarget_ = 0.0F;
  float baseFrequency_ = 0.0F;
  float frequency_ = 0.0F;
  float velocity_ = 0.0F;
  float pitchBend_ = 0.0F;
  float pitchBendMultiplier_ = 1.0F;
  float lfoPitchMultiplier_ = 1.0F;
  float channelAftertouch_ = 0.0F;
  float polyAftertouch_ = 0.0F;
  float attackSeconds_ = 0.01F;
  float releaseSeconds_ = 0.5F;
  float attackStep_ = 0.0F;
  float releaseStep_ = 0.0F;
  float cutoffHz_ = 1000.0F;
  float resonance_ = 0.1F;
  float subLevel_ = 0.0F;
  float pulseWidth_ = 0.5F;
  bool active_ = false;
  std::uint8_t channel_ = 0;
  std::uint8_t midiNote_ = 0;
  std::uint64_t triggerAge_ = 0;
  NonlinearVCF filter_;
};

}  // namespace daft::audio::juno::detail
