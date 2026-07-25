#include "audio_engine/DSPNode.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>

namespace daft::audio {
namespace {

constexpr NodeParameterId kGainParameter = 1U;
constexpr NodeParameterId kTrackVolumeParameter = 2U;
constexpr NodeParameterId kTrackPanParameter = 3U;
constexpr NodeParameterId kFrequencyParameter = 1U;
constexpr NodeParameterId kClipStartFrameParameter = 1U;
constexpr NodeParameterId kClipEndFrameParameter = 2U;
constexpr NodeParameterId kClipFadeInFramesParameter = 3U;
constexpr NodeParameterId kClipFadeOutFramesParameter = 4U;
constexpr NodeParameterId kClipGainParameter = 5U;
constexpr NodeParameterId kClipBufferSampleRateParameter = 6U;
constexpr NodeParameterId kClipBufferChannelsParameter = 7U;
constexpr NodeParameterId kClipBufferFramesParameter = 8U;

}  // namespace

void GainNode::process(AudioBufferView buffer) noexcept {
  const auto frames = buffer.frameCount();
  const auto channels = buffer.channelCount();
  for (std::size_t ch = 0; ch < channels; ++ch) {
    auto channelData = buffer.channel(ch);
    for (std::size_t i = 0; i < frames; ++i) {
      channelData[i] = static_cast<float>(channelData[i] * gain_);
    }
  }
}

void GainNode::setParameter(const std::string& name, double value) {
  const auto parameter = resolveParameterId(name);
  if (parameter) {
    (void)setParameterById(*parameter, value);
  }
}

std::optional<NodeParameterId> GainNode::resolveParameterId(
    std::string_view name) const noexcept {
  return name == "gain" ? std::optional<NodeParameterId>(kGainParameter)
                        : std::nullopt;
}

bool GainNode::setParameterById(NodeParameterId parameter,
                                double value) noexcept {
  if (parameter != kGainParameter || !std::isfinite(value)) {
    return false;
  }
  gain_ = value;
  return true;
}

void TrackOutputNode::process(AudioBufferView buffer) noexcept {
  const auto channels = buffer.channelCount();
  for (std::size_t channel = 0; channel < channels; ++channel) {
    double channelGain = gain_;
    if (channels >= 2 && channel == 0 && pan_ > 0.0) {
      channelGain *= 1.0 - pan_;
    } else if (channels >= 2 && channel == 1 && pan_ < 0.0) {
      channelGain *= 1.0 + pan_;
    }
    auto samples = buffer.channel(channel);
    for (auto& sample : samples) {
      sample *= static_cast<float>(channelGain);
    }
  }
}

void TrackOutputNode::setParameter(const std::string& name, double value) {
  const auto parameter = resolveParameterId(name);
  if (parameter) {
    (void)setParameterById(*parameter, value);
  }
}

std::optional<NodeParameterId> TrackOutputNode::resolveParameterId(
    std::string_view name) const noexcept {
  if (name == "gain") {
    return kGainParameter;
  }
  if (name == "volume") {
    return kTrackVolumeParameter;
  }
  if (name == "pan") {
    return kTrackPanParameter;
  }
  return std::nullopt;
}

bool TrackOutputNode::setParameterById(NodeParameterId parameter,
                                       double value) noexcept {
  if (!std::isfinite(value)) {
    return false;
  }
  if (parameter == kGainParameter) {
    gain_ = std::max(0.0, value);
    return true;
  }
  if (parameter == kTrackVolumeParameter) {
    gain_ = std::pow(10.0, value / 20.0);
    return true;
  }
  if (parameter == kTrackPanParameter) {
    pan_ = std::clamp(value, -1.0, 1.0);
    return true;
  }
  return false;
}

void SineOscillatorNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  phase_ = 0.0;
}

void SineOscillatorNode::locate(std::uint64_t frame) noexcept {
  const double phaseDelta = (2.0 * std::numbers::pi * frequency_) / sampleRate();
  phase_ = std::fmod(static_cast<double>(frame) * phaseDelta,
                     2.0 * std::numbers::pi);
}

void SineOscillatorNode::process(AudioBufferView buffer) noexcept {
  const double rate = sampleRate();
  const double phaseDelta = (2.0 * std::numbers::pi * frequency_) / rate;
  for (std::size_t i = 0; i < buffer.frameCount(); ++i) {
    const float value = static_cast<float>(std::sin(phase_));
    phase_ += phaseDelta;
    if (phase_ > 2.0 * std::numbers::pi) {
      phase_ -= 2.0 * std::numbers::pi;
    }
    for (std::size_t ch = 0; ch < buffer.channelCount(); ++ch) {
      buffer.channel(ch)[i] = value;
    }
  }
}

void SineOscillatorNode::setParameter(const std::string& name, double value) {
  const auto parameter = resolveParameterId(name);
  if (parameter) {
    (void)setParameterById(*parameter, value);
  }
}

std::optional<NodeParameterId> SineOscillatorNode::resolveParameterId(
    std::string_view name) const noexcept {
  return name == "frequency"
             ? std::optional<NodeParameterId>(kFrequencyParameter)
             : std::nullopt;
}

bool SineOscillatorNode::setParameterById(NodeParameterId parameter,
                                          double value) noexcept {
  if (parameter != kFrequencyParameter || !std::isfinite(value)) {
    return false;
  }
  frequency_ = value;
  return true;
}

MixerNode::MixerNode(std::size_t inputCount) : inputs_(inputCount) {}

void MixerNode::process(AudioBufferView buffer) noexcept {
  // SceneGraph has already summed all connected sources into `buffer`. Preserve
  // that graph input and apply the mixer's gain instead of clearing it.
  for (std::size_t ch = 0; ch < buffer.channelCount(); ++ch) {
    auto channelData = buffer.channel(ch);
    for (auto& sample : channelData) {
      sample *= static_cast<float>(gain_);
    }
  }

  // Retain support for explicitly supplied inputs used by embedders outside the
  // SceneGraph. These inputs are additive to graph-connected sources.
  for (const auto& input : inputs_) {
    if (input.size() != buffer.frameCount()) {
      continue;
    }
    for (std::size_t i = 0; i < buffer.frameCount(); ++i) {
      const float sample = input[i] * static_cast<float>(gain_);
      for (std::size_t ch = 0; ch < buffer.channelCount(); ++ch) {
        buffer.channel(ch)[i] += sample;
      }
    }
  }
}

void MixerNode::setParameter(const std::string& name, double value) {
  const auto parameter = resolveParameterId(name);
  if (parameter) {
    (void)setParameterById(*parameter, value);
  }
}

std::optional<NodeParameterId> MixerNode::resolveParameterId(
    std::string_view name) const noexcept {
  return name == "gain" ? std::optional<NodeParameterId>(kGainParameter)
                        : std::nullopt;
}

bool MixerNode::setParameterById(NodeParameterId parameter,
                                 double value) noexcept {
  if (parameter != kGainParameter || !std::isfinite(value)) {
    return false;
  }
  gain_ = value;
  return true;
}

void MixerNode::updateInput(std::size_t index, std::span<const float> input) {
  if (index >= inputs_.size()) {
    return;
  }
  inputs_[index] = input;
}

void ClipPlayerNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  processedFrames_ = 0;
}

void ClipPlayerNode::reset() noexcept { processedFrames_ = 0; }

void ClipPlayerNode::locate(std::uint64_t frame) noexcept {
  processedFrames_ = frame;
}

void ClipPlayerNode::setClipBuffer(ClipBufferData data) {
  if (data.frameCount == 0 || data.channels.empty()) {
    data.clear();
  }
  clipBuffer_ = std::move(data);
  if (!clipBuffer_.empty()) {
    declaredBufferSampleRate_ = clipBuffer_.sampleRate;
    declaredBufferFrames_ = clipBuffer_.frameCount;
    declaredBufferChannels_ = clipBuffer_.channelCount();
  } else {
    declaredBufferSampleRate_ = 0.0;
    declaredBufferFrames_ = 0;
    declaredBufferChannels_ = 0;
  }
}

void ClipPlayerNode::process(AudioBufferView buffer) noexcept {
  const auto frameCount = buffer.frameCount();
  if (frameCount == 0) {
    return;
  }
  if (clipBuffer_.empty()) {
    processedFrames_ += frameCount;
    return;
  }

  const auto outputChannels = buffer.channelCount();
  const auto bufferChannels = clipBuffer_.channelCount();
  if (outputChannels == 0 || bufferChannels == 0 || clipBuffer_.frameCount == 0) {
    processedFrames_ += frameCount;
    return;
  }

  const std::uint64_t startFrame = startFrame_;
  const std::uint64_t endFrame = std::max(startFrame_, endFrame_);
  const std::uint64_t bufferFrameCount =
      static_cast<std::uint64_t>(clipBuffer_.frameCount);
  const std::uint64_t effectiveEnd =
      std::min<std::uint64_t>(endFrame, startFrame + bufferFrameCount);
  const std::uint64_t playbackFrames =
      effectiveEnd > startFrame ? (effectiveEnd - startFrame) : 0;
  const std::uint64_t fadeInFrames = std::min(fadeInFrames_, playbackFrames);
  const std::uint64_t fadeOutFrames = std::min(fadeOutFrames_, playbackFrames);
  const std::uint64_t fadeOutStart = effectiveEnd - fadeOutFrames;

  for (std::size_t frameIndex = 0; frameIndex < frameCount; ++frameIndex) {
    const std::uint64_t absoluteFrame = processedFrames_ + frameIndex;
    if (absoluteFrame < startFrame || absoluteFrame >= effectiveEnd) {
      continue;
    }

    const std::uint64_t bufferFrame = absoluteFrame - startFrame;
    if (bufferFrame >= bufferFrameCount) {
      continue;
    }

    double amplitude = gain_;
    if (fadeInFrames > 0 && absoluteFrame < startFrame + fadeInFrames) {
      const std::uint64_t offset = absoluteFrame - startFrame;
      amplitude *= fadeInFrames == 1
                       ? 0.0
                       : static_cast<double>(offset) /
                             static_cast<double>(fadeInFrames - 1);
    }
    if (fadeOutFrames > 0 && absoluteFrame >= fadeOutStart) {
      const std::uint64_t remaining = effectiveEnd - absoluteFrame - 1;
      amplitude *= fadeOutFrames == 1
                       ? 0.0
                       : static_cast<double>(remaining) /
                             static_cast<double>(fadeOutFrames - 1);
    }

    for (std::size_t channel = 0; channel < outputChannels; ++channel) {
      const std::size_t sourceChannel =
          bufferChannels == 1 ? 0 : std::min(channel, bufferChannels - 1);
      const auto* source = clipBuffer_.channels[sourceChannel];
      if (source == nullptr) {
        continue;
      }
      const float sample = source[static_cast<std::size_t>(bufferFrame)];
      buffer.channel(channel)[frameIndex] =
          static_cast<float>(sample * amplitude);
    }
  }

  processedFrames_ += frameCount;
}

void ClipPlayerNode::setParameter(const std::string& name, double value) {
  const auto parameter = resolveParameterId(name);
  if (parameter) {
    (void)setParameterById(*parameter, value);
  }
}

std::optional<NodeParameterId> ClipPlayerNode::resolveParameterId(
    std::string_view name) const noexcept {
  if (name == "startframe") {
    return kClipStartFrameParameter;
  }
  if (name == "endframe") {
    return kClipEndFrameParameter;
  }
  if (name == "fadeinframes") {
    return kClipFadeInFramesParameter;
  }
  if (name == "fadeoutframes") {
    return kClipFadeOutFramesParameter;
  }
  if (name == "gain") {
    return kClipGainParameter;
  }
  if (name == "buffersamplerate") {
    return kClipBufferSampleRateParameter;
  }
  if (name == "bufferchannels") {
    return kClipBufferChannelsParameter;
  }
  if (name == "bufferframes") {
    return kClipBufferFramesParameter;
  }
  return std::nullopt;
}

bool ClipPlayerNode::setParameterById(NodeParameterId parameter,
                                      double value) noexcept {
  if (parameter == kClipStartFrameParameter) {
    startFrame_ = sanitizeFrameValue(value);
    return true;
  }
  if (parameter == kClipEndFrameParameter) {
    endFrame_ = sanitizeFrameValue(value);
    return true;
  }
  if (parameter == kClipFadeInFramesParameter) {
    fadeInFrames_ = sanitizeCountValue(value);
    return true;
  }
  if (parameter == kClipFadeOutFramesParameter) {
    fadeOutFrames_ = sanitizeCountValue(value);
    return true;
  }
  if (parameter == kClipGainParameter) {
    if (!std::isfinite(value)) {
      return false;
    }
    gain_ = value;
    return true;
  }
  if (parameter == kClipBufferSampleRateParameter) {
    declaredBufferSampleRate_ =
        std::isfinite(value) && value > 0.0 ? value : 0.0;
    return true;
  }
  if (parameter == kClipBufferChannelsParameter) {
    declaredBufferChannels_ = sanitizeCountValue(value);
    return true;
  }
  if (parameter == kClipBufferFramesParameter) {
    declaredBufferFrames_ = sanitizeFrameValue(value);
    return true;
  }
  return false;
}

std::uint64_t ClipPlayerNode::sanitizeFrameValue(double value) noexcept {
  if (!std::isfinite(value) || value <= 0.0) {
    return 0;
  }
  const double clamped = std::min(
      value, static_cast<double>(std::numeric_limits<std::uint64_t>::max()));
  return static_cast<std::uint64_t>(std::floor(clamped + 0.5));
}

std::uint64_t ClipPlayerNode::sanitizeCountValue(double value) noexcept {
  if (!std::isfinite(value) || value <= 0.0) {
    return 0;
  }
  const double clamped = std::min(
      value, static_cast<double>(std::numeric_limits<std::uint64_t>::max()));
  return static_cast<std::uint64_t>(std::floor(clamped + 0.5));
}

}  // namespace daft::audio
