#pragma once

#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <span>

namespace daft::audio {

template <std::size_t MaxChannels, std::size_t MaxFrames>
class StackAudioBuffer {
 public:
  StackAudioBuffer() : frameCount_(0) {}

  void setFrameCount(std::size_t frames) { frameCount_ = frames <= MaxFrames ? frames : MaxFrames; }

  [[nodiscard]] std::size_t frameCount() const { return frameCount_; }

  [[nodiscard]] std::size_t channelCount() const { return MaxChannels; }

  [[nodiscard]] float* channel(std::size_t index) {
    assert(index < MaxChannels);
    return data_[index].data();
  }

  [[nodiscard]] const float* channel(std::size_t index) const {
    assert(index < MaxChannels);
    return data_[index].data();
  }

  void clear() {
    for (auto& channelData : data_) {
      for (std::size_t i = 0; i < frameCount_; ++i) {
        channelData[i] = 0.0F;
      }
    }
  }

 private:
  std::array<std::array<float, MaxFrames>, MaxChannels> data_{};
  std::size_t frameCount_;
};

class AudioBufferView {
 public:
  AudioBufferView(float** channels, std::size_t channelCount, std::size_t frameCount)
      : channels_(channels), channelCount_(channelCount), frameCount_(frameCount) {}

  [[nodiscard]] std::size_t frameCount() const { return frameCount_; }

  [[nodiscard]] std::size_t channelCount() const { return channelCount_; }

  [[nodiscard]] std::span<float> channel(std::size_t index) {
    assert(index < channelCount_);
    return {channels_[index], frameCount_};
  }

  [[nodiscard]] std::span<const float> channel(std::size_t index) const {
    assert(index < channelCount_);
    return {channels_[index], frameCount_};
  }

  void fill(float value) {
    for (std::size_t ch = 0; ch < channelCount_; ++ch) {
      std::fill_n(channels_[ch], frameCount_, value);
    }
  }

  void addBufferInPlace(const AudioBufferView& other) {
    assert(other.channelCount() == channelCount_);
    assert(other.frameCount() == frameCount_);
    for (std::size_t ch = 0; ch < channelCount_; ++ch) {
      auto* dest = channels_[ch];
      const auto* src = other.channels_[ch];
      for (std::size_t i = 0; i < frameCount_; ++i) {
        dest[i] += src[i];
      }
    }
  }

 private:
  float** channels_;
  std::size_t channelCount_;
  std::size_t frameCount_;
};

}  // namespace daft::audio
