#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/Clock.h"

namespace daft::audio {

class DSPNode {
 public:
  DSPNode() = default;
  virtual ~DSPNode() = default;

  DSPNode(const DSPNode&) = delete;
  DSPNode& operator=(const DSPNode&) = delete;
  DSPNode(DSPNode&&) = delete;
  DSPNode& operator=(DSPNode&&) = delete;

  virtual void prepare(double sampleRate) { sampleRate_ = sampleRate; }
  virtual void reset() {}
  virtual void process(AudioBufferView buffer) = 0;
  virtual void setParameter(const std::string& name, double value) = 0;

  [[nodiscard]] double sampleRate() const { return sampleRate_; }

 private:
  double sampleRate_ = 48000.0;
};

class GainNode final : public DSPNode {
 public:
  void process(AudioBufferView buffer) override;
  void setParameter(const std::string& name, double value) override;

 private:
  double gain_ = 1.0;
};

class SineOscillatorNode final : public DSPNode {
 public:
  void prepare(double sampleRate) override;
  void process(AudioBufferView buffer) override;
  void setParameter(const std::string& name, double value) override;

 private:
  double phase_ = 0.0;
  double frequency_ = 440.0;
};

class MixerNode final : public DSPNode {
 public:
  explicit MixerNode(std::size_t inputCount);
  void process(AudioBufferView buffer) override;
  void setParameter(const std::string& name, double value) override;
  void updateInput(std::size_t index, std::span<const float> input);

 private:
  std::vector<std::span<const float>> inputs_;
  double gain_ = 1.0;
};

class ClipPlayerNode final : public DSPNode {
 public:
  struct ClipBufferData {
    std::string key;
    double sampleRate = 0.0;
    std::size_t frameCount = 0;
    std::vector<const float*> channels;
    std::shared_ptr<void> owner;

    [[nodiscard]] std::size_t channelCount() const { return channels.size(); }
    void clear() {
      key.clear();
      sampleRate = 0.0;
      frameCount = 0;
      channels.clear();
      owner.reset();
    }
    [[nodiscard]] bool empty() const { return frameCount == 0 || channels.empty(); }
  };

  void prepare(double sampleRate) override;
  void reset() override;
  void process(AudioBufferView buffer) override;
  void setParameter(const std::string& name, double value) override;

  void setClipBuffer(ClipBufferData data);
  [[nodiscard]] const ClipBufferData& clipBuffer() const noexcept { return clipBuffer_; }

 private:
  static std::uint64_t sanitizeFrameValue(double value);
  static std::uint64_t sanitizeCountValue(double value);

  ClipBufferData clipBuffer_{};
  std::uint64_t startFrame_ = 0;
  std::uint64_t endFrame_ = 0;
  std::uint64_t fadeInFrames_ = 0;
  std::uint64_t fadeOutFrames_ = 0;
  double gain_ = 1.0;
  double declaredBufferSampleRate_ = 0.0;
  std::uint64_t declaredBufferFrames_ = 0;
  std::uint64_t declaredBufferChannels_ = 0;
  std::uint64_t processedFrames_ = 0;
};

}  // namespace daft::audio
