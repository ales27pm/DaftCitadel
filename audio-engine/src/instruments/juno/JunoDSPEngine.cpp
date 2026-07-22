#include "audio_engine/instruments/juno/JunoDSPEngine.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <utility>
#include <vector>

#include "audio_engine/instruments/juno/detail/JunoVoice.h"

namespace daft::audio::juno {

struct JunoDSPEngine::Impl {
  EngineConfig config{};
  std::vector<std::unique_ptr<detail::JunoVoice>> voices;
  float outputGain = 1.0F;
  bool prepared = false;
};

JunoDSPEngine::JunoDSPEngine() : impl_(std::make_unique<Impl>()) {}

JunoDSPEngine::~JunoDSPEngine() = default;

bool JunoDSPEngine::prepare(const EngineConfig& config) {
  if (!std::isfinite(config.sampleRate) || config.sampleRate < 8000.0 ||
      config.sampleRate > 384000.0 || config.maximumFramesPerBlock == 0U ||
      config.maximumFramesPerBlock > kMaximumFramesPerBlock || config.polyphony == 0U ||
      config.polyphony > kMaximumPolyphony) {
    return false;
  }

  try {
    std::vector<std::unique_ptr<detail::JunoVoice>> preparedVoices;
    preparedVoices.reserve(config.polyphony);
    for (std::size_t index = 0; index < config.polyphony; ++index) {
      auto voice = std::make_unique<detail::JunoVoice>();
      voice->prepare(static_cast<float>(config.sampleRate));
      preparedVoices.push_back(std::move(voice));
    }
    impl_->voices = std::move(preparedVoices);
  } catch (...) {
    return false;
  }

  impl_->config = config;
  impl_->outputGain = 1.0F;
  impl_->prepared = true;
  return true;
}

void JunoDSPEngine::reset() noexcept {
  for (auto& voice : impl_->voices) {
    voice->reset();
  }
}

bool JunoDSPEngine::noteOn(std::uint8_t midiNote, float velocity) noexcept {
  if (!impl_->prepared || midiNote > 127U || !std::isfinite(velocity)) {
    return false;
  }
  if (velocity < 0.0F) {
    return false;
  }
  if (velocity == 0.0F) {
    return noteOff(midiNote);
  }

  auto voice = std::find_if(impl_->voices.begin(), impl_->voices.end(),
                            [](const auto& candidate) { return !candidate->isActive(); });
  if (voice == impl_->voices.end()) {
    voice = impl_->voices.begin();
  }
  (*voice)->noteOn(midiNote, std::clamp(velocity, 0.0F, 1.0F));
  return true;
}

bool JunoDSPEngine::noteOff(std::uint8_t midiNote) noexcept {
  if (!impl_->prepared || midiNote > 127U) {
    return false;
  }
  for (auto& voice : impl_->voices) {
    if (voice->noteOff(midiNote)) {
      return true;
    }
  }
  return false;
}

void JunoDSPEngine::allNotesOff() noexcept {
  for (auto& voice : impl_->voices) {
    voice->release();
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

  bool handled = false;
  for (auto& voice : impl_->voices) {
    handled = voice->setParameter(parameter, value) || handled;
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

  for (auto& voice : impl_->voices) {
    for (std::size_t frame = 0; frame < left.size(); ++frame) {
      float voiceLeft = 0.0F;
      float voiceRight = 0.0F;
      voice->process(voiceLeft, voiceRight);
      left[frame] += voiceLeft * impl_->outputGain;
      right[frame] += voiceRight * impl_->outputGain;
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
                    [](const auto& voice) { return voice->isActive(); }));
}

}  // namespace daft::audio::juno
