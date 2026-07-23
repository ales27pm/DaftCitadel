#pragma once

#include <cstdint>

#include "audio_engine/instruments/juno/JunoDSPEngine.h"
#include "audio_engine/instruments/juno/detail/NonlinearVCF.h"

namespace daft::audio::juno::detail {

class JunoVoice final {
 public:
  void prepare(float sampleRate);
  void reset() noexcept;
  void noteOn(std::uint8_t midiNote, float velocity) noexcept;
  [[nodiscard]] bool noteOff(std::uint8_t midiNote) noexcept;
  void release() noexcept;
  [[nodiscard]] bool setParameter(ParameterId parameter, float value) noexcept;
  [[nodiscard]] float processMono() noexcept;

  [[nodiscard]] bool isActive() const noexcept { return active_; }
  [[nodiscard]] std::uint8_t currentNote() const noexcept { return midiNote_; }

 private:
  [[nodiscard]] bool stepEnvelopeAndPhase() noexcept;

  float sampleRate_ = 44100.0F;
  float phase_ = 0.0F;
  float subPhase_ = 0.0F;
  float envelopeLevel_ = 0.0F;
  float envelopeTarget_ = 0.0F;
  float frequency_ = 0.0F;
  float velocity_ = 0.0F;
  float attackSeconds_ = 0.01F;
  float releaseSeconds_ = 0.5F;
  float cutoffHz_ = 1000.0F;
  float resonance_ = 0.1F;
  float subLevel_ = 0.0F;
  float pulseWidth_ = 0.5F;
  bool active_ = false;
  std::uint8_t midiNote_ = 0;
  NonlinearVCF filter_;
};

}  // namespace daft::audio::juno::detail
