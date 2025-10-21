#include "audio_engine/DSPNode.h"

#include <algorithm>
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

void SineOscillatorNode::prepare(double sampleRate) {
  DSPNode::prepare(sampleRate);
  phase_ = 0.0;
}

void SineOscillatorNode::process(AudioBufferView buffer) {
  const double sampleRate = sampleRate();
  const double phaseDelta = (2.0 * std::numbers::pi * frequency_) / sampleRate;
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
  for (std::size_t ch = 0; ch < buffer.channelCount(); ++ch) {
    auto channelData = buffer.channel(ch);
    std::fill(channelData.begin(), channelData.end(), 0.0F);
  }

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

}  // namespace daft::audio
