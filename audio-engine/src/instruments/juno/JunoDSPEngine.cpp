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

[[nodiscard]] bool IsValidMidiChannel(std::uint8_t channel) noexcept {
  return channel < JunoDSPEngine::kMidiChannelCount;
}

[[nodiscard]] bool IsNormalized(float value) noexcept {
  return std::isfinite(value) && value >= 0.0F && value <= 1.0F;
}

[[nodiscard]] std::size_t NoteStateIndex(std::uint8_t channel,
                                         std::uint8_t note) noexcept {
  return static_cast<std::size_t>(channel) * JunoDSPEngine::kMidiNoteCount + note;
}

constexpr float kTwoPi = 6.28318530717958647692F;

}  // namespace

struct JunoDSPEngine::Impl {
  [[nodiscard]] auto findActiveVoice(std::uint8_t channel, std::uint8_t note) noexcept {
    return std::find_if(voices.begin(), voices.end(), [channel, note](const auto& candidate) {
      return candidate.isActive() && candidate.currentChannel() == channel &&
             candidate.currentNote() == note;
    });
  }

  EngineConfig config{};
  std::vector<detail::JunoVoice> voices;
  detail::BBDChorus chorus;
  std::array<std::uint16_t, kMidiChannelCount * kMidiNoteCount> heldNoteCounts{};
  std::array<bool, kMidiChannelCount * kMidiNoteCount> sustainedNotes{};
  std::array<bool, kMidiChannelCount> sustainPedals{};
  std::array<float, kMidiChannelCount> pitchBends{};
  std::array<float, kMidiChannelCount> channelAftertouch{};
  std::array<float, kMidiChannelCount * kMidiNoteCount> polyAftertouch{};
  std::uint64_t nextTriggerAge = 0;
  std::size_t chorusTailFramesRemaining = 0;
  float outputGain = kDefaultOutputGain;
  float lfoPhase = 0.0F;
  float lfoRateHz = kDefaultLfoRateHz;
  float lfoDepth = kDefaultLfoDepth;
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
  impl_->sustainedNotes.fill(false);
  impl_->sustainPedals.fill(false);
  impl_->pitchBends.fill(0.0F);
  impl_->channelAftertouch.fill(0.0F);
  impl_->polyAftertouch.fill(0.0F);
  impl_->nextTriggerAge = 0;
  impl_->chorusTailFramesRemaining = 0;
  impl_->outputGain = kDefaultOutputGain;
  impl_->lfoPhase = 0.0F;
  impl_->lfoRateHz = kDefaultLfoRateHz;
  impl_->lfoDepth = kDefaultLfoDepth;
  impl_->prepared = true;
  return true;
}

void JunoDSPEngine::reset() noexcept {
  for (auto& voice : impl_->voices) {
    voice.reset();
  }
  impl_->chorus.reset();
  impl_->heldNoteCounts.fill(0U);
  impl_->sustainedNotes.fill(false);
  impl_->sustainPedals.fill(false);
  impl_->pitchBends.fill(0.0F);
  impl_->channelAftertouch.fill(0.0F);
  impl_->polyAftertouch.fill(0.0F);
  impl_->nextTriggerAge = 0;
  impl_->chorusTailFramesRemaining = 0;
  impl_->lfoPhase = 0.0F;
}

bool JunoDSPEngine::noteOn(int midiNote, float velocity) noexcept {
  return noteOn(0U, midiNote, velocity);
}

bool JunoDSPEngine::noteOn(std::uint8_t channel, int midiNote, float velocity) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel) || !IsValidMidiNote(midiNote) ||
      !std::isfinite(velocity)) {
    return false;
  }
  if (velocity < 0.0F) {
    return false;
  }
  if (velocity == 0.0F) {
    return noteOff(channel, midiNote);
  }

  const auto encodedNote = static_cast<std::uint8_t>(midiNote);
  const auto noteIndex = NoteStateIndex(channel, encodedNote);
  auto& heldCount = impl_->heldNoteCounts[noteIndex];
  if (heldCount == std::numeric_limits<std::uint16_t>::max()) {
    return false;
  }

  impl_->sustainedNotes[noteIndex] = false;
  auto voice = impl_->findActiveVoice(channel, encodedNote);
  if (voice == impl_->voices.end()) {
    voice = std::find_if(impl_->voices.begin(), impl_->voices.end(),
                         [](const auto& candidate) { return !candidate.isActive(); });
  }
  if (voice == impl_->voices.end()) {
    voice = std::min_element(impl_->voices.begin(), impl_->voices.end(),
                             [](const auto& first, const auto& second) {
                               return first.triggerAge() < second.triggerAge();
                             });
  }
  ++heldCount;
  voice->noteOn(channel, encodedNote, std::clamp(velocity, 0.0F, 1.0F),
                impl_->nextTriggerAge++);
  voice->setPitchBend(impl_->pitchBends[channel]);
  voice->setChannelAftertouch(impl_->channelAftertouch[channel]);
  voice->setPolyAftertouch(impl_->polyAftertouch[noteIndex]);
  return true;
}

bool JunoDSPEngine::noteOff(int midiNote) noexcept {
  return noteOff(0U, midiNote);
}

bool JunoDSPEngine::noteOff(std::uint8_t channel, int midiNote) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel) || !IsValidMidiNote(midiNote)) {
    return false;
  }

  const auto encodedNote = static_cast<std::uint8_t>(midiNote);
  const auto noteIndex = NoteStateIndex(channel, encodedNote);
  auto& heldCount = impl_->heldNoteCounts[noteIndex];
  if (heldCount == 0U) {
    return false;
  }
  --heldCount;
  if (heldCount > 0U) {
    return true;
  }

  impl_->polyAftertouch[noteIndex] = 0.0F;
  const auto voice = impl_->findActiveVoice(channel, encodedNote);
  if (voice != impl_->voices.end()) {
    voice->setPolyAftertouch(0.0F);
  }
  if (impl_->sustainPedals[channel]) {
    impl_->sustainedNotes[noteIndex] = true;
    return true;
  }
  impl_->sustainedNotes[noteIndex] = false;
  if (voice != impl_->voices.end()) {
    (void)voice->noteOff(channel, encodedNote);
  }
  // The gate was consumed even if polyphony pressure had already stolen its
  // physical voice.
  return true;
}

void JunoDSPEngine::allNotesOff() noexcept {
  impl_->heldNoteCounts.fill(0U);
  impl_->sustainedNotes.fill(false);
  impl_->sustainPedals.fill(false);
  impl_->polyAftertouch.fill(0.0F);
  for (auto& voice : impl_->voices) {
    voice.setPolyAftertouch(0.0F);
    voice.release();
  }
}

bool JunoDSPEngine::allNotesOff(std::uint8_t channel) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel)) {
    return false;
  }
  impl_->sustainPedals[channel] = false;
  for (std::size_t note = 0U; note < kMidiNoteCount; ++note) {
    const auto index = NoteStateIndex(channel, static_cast<std::uint8_t>(note));
    impl_->heldNoteCounts[index] = 0U;
    impl_->sustainedNotes[index] = false;
    impl_->polyAftertouch[index] = 0.0F;
  }
  for (auto& voice : impl_->voices) {
    if (voice.isActive() && voice.currentChannel() == channel) {
      voice.setPolyAftertouch(0.0F);
      voice.release();
    }
  }
  return true;
}

bool JunoDSPEngine::setSustainPedal(std::uint8_t channel, bool enabled) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel)) {
    return false;
  }
  if (impl_->sustainPedals[channel] == enabled) {
    return true;
  }
  impl_->sustainPedals[channel] = enabled;
  if (enabled) {
    return true;
  }

  for (std::size_t note = 0U; note < kMidiNoteCount; ++note) {
    const auto encodedNote = static_cast<std::uint8_t>(note);
    const auto index = NoteStateIndex(channel, encodedNote);
    if (!impl_->sustainedNotes[index] || impl_->heldNoteCounts[index] > 0U) {
      continue;
    }
    impl_->sustainedNotes[index] = false;
    const auto voice = impl_->findActiveVoice(channel, encodedNote);
    if (voice != impl_->voices.end()) {
      (void)voice->noteOff(channel, encodedNote);
    }
  }
  return true;
}

bool JunoDSPEngine::setPitchBend(std::uint8_t channel, float normalizedBend) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel) || !std::isfinite(normalizedBend) ||
      normalizedBend < -1.0F || normalizedBend > 1.0F) {
    return false;
  }
  impl_->pitchBends[channel] = normalizedBend;
  for (auto& voice : impl_->voices) {
    if (voice.isActive() && voice.currentChannel() == channel) {
      voice.setPitchBend(normalizedBend);
    }
  }
  return true;
}

bool JunoDSPEngine::setChannelAftertouch(std::uint8_t channel, float pressure) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel) || !IsNormalized(pressure)) {
    return false;
  }
  impl_->channelAftertouch[channel] = pressure;
  for (auto& voice : impl_->voices) {
    if (voice.isActive() && voice.currentChannel() == channel) {
      voice.setChannelAftertouch(pressure);
    }
  }
  return true;
}

bool JunoDSPEngine::setPolyAftertouch(std::uint8_t channel, int midiNote,
                                      float pressure) noexcept {
  if (!impl_->prepared || !IsValidMidiChannel(channel) || !IsValidMidiNote(midiNote) ||
      !IsNormalized(pressure)) {
    return false;
  }
  const auto encodedNote = static_cast<std::uint8_t>(midiNote);
  impl_->polyAftertouch[NoteStateIndex(channel, encodedNote)] = pressure;
  const auto voice = impl_->findActiveVoice(channel, encodedNote);
  if (voice != impl_->voices.end()) {
    voice->setPolyAftertouch(pressure);
  }
  return true;
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
  if (parameter == ParameterId::kLfoRateHz) {
    impl_->lfoRateHz = std::clamp(value, kMinimumLfoRateHz, kMaximumLfoRateHz);
    return true;
  }
  if (parameter == ParameterId::kLfoDepth) {
    impl_->lfoDepth = std::clamp(value, kMinimumLfoDepth, kMaximumLfoDepth);
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
    const float lfoSemitones = std::sin(kTwoPi * impl_->lfoPhase) * impl_->lfoDepth *
                               kMaximumLfoPitchSemitones;
    const float lfoPitchMultiplier = std::exp2(lfoSemitones / 12.0F);
    float mono = 0.0F;
    bool hasActiveVoice = false;
    for (auto& voice : impl_->voices) {
      if (voice.isActive()) {
        voice.setLfoPitchMultiplier(lfoPitchMultiplier);
      }
      mono += voice.processMono();
      hasActiveVoice = voice.isActive() || hasActiveVoice;
    }
    float chorusLeft = 0.0F;
    float chorusRight = 0.0F;
    impl_->chorus.process(mono, chorusLeft, chorusRight);
    if (hasActiveVoice) {
      impl_->chorusTailFramesRemaining = impl_->chorus.drainFrameCount();
    }
    if (hasActiveVoice || impl_->chorusTailFramesRemaining > 0U) {
      left[frame] = chorusLeft * impl_->outputGain;
      right[frame] = chorusRight * impl_->outputGain;
    }
    if (!hasActiveVoice && impl_->chorusTailFramesRemaining > 0U) {
      --impl_->chorusTailFramesRemaining;
    }
    impl_->lfoPhase += impl_->lfoRateHz / static_cast<float>(impl_->config.sampleRate);
    if (impl_->lfoPhase >= 1.0F) {
      impl_->lfoPhase -= std::floor(impl_->lfoPhase);
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
