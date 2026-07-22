#include "audio_engine/instruments/juno/JunoDSPEngine.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <memory>
#include <utility>
#include <vector>

#include "audio_engine/instruments/juno/detail/BBDChorus.h"
#include "audio_engine/instruments/juno/detail/JunoVoice.h"

namespace daft::audio::juno {
namespace {

[[nodiscard]] bool IsValidSampleRate(double sampleRate) noexcept {
  return std::isfinite(sampleRate) && sampleRate >= 8000.0 && sampleRate <= 384000.0;
}

[[nodiscard]] bool IsValidBlockSize(std::uint32_t frames) noexcept {
  return frames > 0U && frames <= JunoDSPEngine::kMaximumFramesPerBlock;
}

[[nodiscard]] bool IsValidPolyphony(std::size_t polyphony) noexcept {
  return polyphony > 0U && polyphony <= JunoDSPEngine::kMaximumPolyphony;
}

[[nodiscard]] bool IsValidMidiNote(int midiNote) noexcept {
  return midiNote >= 0 && midiNote <= 127;
}

}  // namespace

struct JunoDSPEngine::Impl {
  EngineConfig config{};
  std::vector<detail::JunoVoice> voices;
  detail::BBDChorus chorus;
  std::array<std::uint16_t, 128> heldNoteCounts{};
  float outputGain = kDefaultOutputGain;
  bool prepared = false;
};

JunoDSPEngine::JunoDSPEngine() : impl_(std::make_unique<Impl>()) {}

JunoDSPEngine::~JunoDSPEngine() = default;

bool JunoDSPEngine::prepare(const EngineConfig& config) {
  if (!IsValidSampleRate(config.sampleRate) ||
      !IsValidBlockSize(config.maximumFramesPerBlock) || !IsValidPolyphony(config.polyphony)) {
    return false;
  }

  try {
    std::vector<detail::JunoVoice> preparedVoices(config.polyphony);
    for (auto& voice : preparedVoices) {
      voice.prepare(static_cast<float>(config.sampleRate));
    }
    detail::BBDChorus preparedChorus;
    preparedChorus.prepare(static_cast<float>(config.sampleRate));
    preparedChorus.setMode(ChorusMode::kI);
    impl_->voices = std::move(preparedVoices);
    impl_->chorus = std::move(preparedChorus);
  } catch (...) {
    return false;
  }

  impl_->config = config;
  impl_->heldNoteCounts.fill(0U);
  impl_->outputGain = kDefaultOutputGain;
  impl_->prepared = true;
  return true;
}

void JunoDSPEngine::reset() noexcept {
  for (auto& voice : impl_->voices) {
    voice.reset();
  }
  impl_->chorus.reset();
  impl_->heldNoteCounts.fill(0U);
}

bool JunoDSPEngine::noteOn(int midiNote, float velocity) noexcept {
  if (!impl_->prepared || !IsValidMidiNote(midiNote) || !std::isfinite(velocity)) {
    return false;
  }
  if (velocity < 0.0F) {
    return false;
  }
  if (velocity == 0.0F) {
    return noteOff(midiNote);
  }

  const auto noteIndex = static_cast<std::size_t>(midiNote);
  auto& heldCount = impl_->heldNoteCounts[noteIndex];
  if (heldCount == std::numeric_limits<std::uint16_t>::max()) {
    return false;
  }

  const auto encodedNote = static_cast<std::uint8_t>(midiNote);
  auto voice = std::find_if(impl_->voices.begin(), impl_->voices.end(),
                            [encodedNote](const auto& candidate) {
                              return candidate.isActive() &&
                                     candidate.currentNote() == encodedNote;
                            });
  if (voice == impl_->voices.end()) {
    voice = std::find_if(impl_->voices.begin(), impl_->voices.end(),
                         [](const auto& candidate) { return !candidate.isActive(); });
  }
  if (voice == impl_->voices.end()) {
    voice = impl_->voices.begin();
  }
  ++heldCount;
  voice->noteOn(encodedNote, std::clamp(velocity, 0.0F, 1.0F));
  return true;
}

bool JunoDSPEngine::noteOff(int midiNote) noexcept {
  if (!impl_->prepared || !IsValidMidiNote(midiNote)) {
    return false;
  }

  auto& heldCount = impl_->heldNoteCounts[static_cast<std::size_t>(midiNote)];
  if (heldCount == 0U) {
    return false;
  }
  --heldCount;
  if (heldCount > 0U) {
    return true;
  }

  const auto encodedNote = static_cast<std::uint8_t>(midiNote);
  const auto voice = std::find_if(impl_->voices.begin(), impl_->voices.end(),
                                  [encodedNote](const auto& candidate) {
                                    return candidate.isActive() &&
                                           candidate.currentNote() == encodedNote;
                                  });
  if (voice != impl_->voices.end()) {
    (void)voice->noteOff(encodedNote);
  }
  // The gate was consumed even if polyphony pressure had already stolen its
  // physical voice.
  return true;
}

void JunoDSPEngine::allNotesOff() noexcept {
  impl_->heldNoteCounts.fill(0U);
  for (auto& voice : impl_->voices) {
    voice.release();
  }
}

bool JunoDSPEngine::setParameter(ParameterId parameter, float value) noexcept {
  if (!impl_->prepared || !std::isfinite(value)) {
    return false;
  }
  if (parameter == ParameterId::kOutputGain) {
    impl_->outputGain = std::clamp(value, 0.0F, 2.0F);
    return true;
  }
  if (parameter == ParameterId::kChorusMode) {
    const int mode = static_cast<int>(std::lround(std::clamp(value, 0.0F, 2.0F)));
    impl_->chorus.setMode(static_cast<ChorusMode>(mode));
    return true;
  }

  bool handled = false;
  for (auto& voice : impl_->voices) {
    handled = voice.setParameter(parameter, value) || handled;
  }
  return handled;
}

void JunoDSPEngine::render(std::span<float> left, std::span<float> right) noexcept {
  std::fill(left.begin(), left.end(), 0.0F);
  std::fill(right.begin(), right.end(), 0.0F);
  if (!impl_->prepared || left.size() != right.size() || left.empty() ||
      left.size() > impl_->config.maximumFramesPerBlock) {
    return;
  }

  for (std::size_t frame = 0; frame < left.size(); ++frame) {
    float mono = 0.0F;
    bool hasActiveVoice = false;
    for (auto& voice : impl_->voices) {
      mono += voice.processMono();
      hasActiveVoice = voice.isActive() || hasActiveVoice;
    }
    float chorusLeft = 0.0F;
    float chorusRight = 0.0F;
    impl_->chorus.process(mono, chorusLeft, chorusRight);
    if (hasActiveVoice) {
      left[frame] = chorusLeft * impl_->outputGain;
      right[frame] = chorusRight * impl_->outputGain;
    }
  }
}

bool JunoDSPEngine::isPrepared() const noexcept { return impl_->prepared; }

double JunoDSPEngine::sampleRate() const noexcept {
  return impl_->prepared ? impl_->config.sampleRate : 0.0;
}

std::uint32_t JunoDSPEngine::maximumFramesPerBlock() const noexcept {
  return impl_->prepared ? impl_->config.maximumFramesPerBlock : 0U;
}

std::size_t JunoDSPEngine::polyphony() const noexcept {
  return impl_->prepared ? impl_->voices.size() : 0U;
}

std::size_t JunoDSPEngine::activeVoiceCount() const noexcept {
  return static_cast<std::size_t>(
      std::count_if(impl_->voices.begin(), impl_->voices.end(),
                    [](const auto& voice) { return voice.isActive(); }));
}

}  // namespace daft::audio::juno
