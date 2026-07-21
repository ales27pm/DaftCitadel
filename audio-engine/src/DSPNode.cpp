#include "audio_engine/DSPNode.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>

namespace daft::audio {

void GainNode::process(AudioBufferView buffer) {
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
  if (name == "gain") {
    gain_ = value;
  }
}

void TrackOutputNode::process(AudioBufferView buffer) {
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
  if (!std::isfinite(value)) {
    return;
  }
  if (name == "gain") {
    gain_ = std::max(0.0, value);
    return;
  }
  if (name == "volume") {
    gain_ = std::pow(10.0, value / 20.0);
    return;
  }
  if (name == "pan") {
    pan_ = std::clamp(value, -1.0, 1.0);
  }
}

void SineOscillatorNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  phase_ = 0.0;
}

void SineOscillatorNode::locate(std::uint64_t frame) {
  const double phaseDelta = (2.0 * std::numbers::pi * frequency_) / sampleRate();
  phase_ = std::fmod(static_cast<double>(frame) * phaseDelta, 2.0 * std::numbers::pi);
}

void SineOscillatorNode::process(AudioBufferView buffer) {
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
  if (name == "frequency") {
    frequency_ = value;
  }
}

MixerNode::MixerNode(std::size_t inputCount) : inputs_(inputCount) {}

void MixerNode::process(AudioBufferView buffer) {
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
  if (name == "gain") {
    gain_ = value;
  }
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

void ClipPlayerNode::reset() { processedFrames_ = 0; }

void ClipPlayerNode::locate(std::uint64_t frame) { processedFrames_ = frame; }

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

void ClipPlayerNode::process(AudioBufferView buffer) {
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
  const std::uint64_t bufferFrameCount = static_cast<std::uint64_t>(clipBuffer_.frameCount);
  const std::uint64_t effectiveEnd = std::min<std::uint64_t>(endFrame, startFrame + bufferFrameCount);
  const std::uint64_t playbackFrames = effectiveEnd > startFrame ? (effectiveEnd - startFrame) : 0;
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
                       : static_cast<double>(offset) / static_cast<double>(fadeInFrames - 1);
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
      buffer.channel(channel)[frameIndex] = static_cast<float>(sample * amplitude);
    }
  }

  processedFrames_ += frameCount;
}

void ClipPlayerNode::setParameter(const std::string& name, double value) {
  if (name == "startframe") {
    startFrame_ = sanitizeFrameValue(value);
    return;
  }
  if (name == "endframe") {
    endFrame_ = sanitizeFrameValue(value);
    return;
  }
  if (name == "fadeinframes") {
    fadeInFrames_ = sanitizeCountValue(value);
    return;
  }
  if (name == "fadeoutframes") {
    fadeOutFrames_ = sanitizeCountValue(value);
    return;
  }
  if (name == "gain") {
    if (std::isfinite(value)) {
      gain_ = value;
    }
    return;
  }
  if (name == "buffersamplerate") {
    declaredBufferSampleRate_ = std::isfinite(value) && value > 0.0 ? value : 0.0;
    return;
  }
  if (name == "bufferchannels") {
    declaredBufferChannels_ = sanitizeCountValue(value);
    return;
  }
  if (name == "bufferframes") {
    declaredBufferFrames_ = sanitizeFrameValue(value);
  }
}

std::uint64_t ClipPlayerNode::sanitizeFrameValue(double value) {
  if (!std::isfinite(value)) {
    return 0;
  }
  if (value <= 0.0) {
    return 0;
  }
  const double clamped = std::min(value, static_cast<double>(std::numeric_limits<std::uint64_t>::max()));
  return static_cast<std::uint64_t>(std::floor(clamped + 0.5));
}

std::uint64_t ClipPlayerNode::sanitizeCountValue(double value) {
  if (!std::isfinite(value) || value <= 0.0) {
    return 0;
  }
  const double clamped = std::min(value, static_cast<double>(std::numeric_limits<std::uint64_t>::max()));
  return static_cast<std::uint64_t>(std::floor(clamped + 0.5));
}

}  // namespace daft::audio
