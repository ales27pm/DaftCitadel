#include "audio_engine/AudioBuffer.h"
#include "audio_engine/DSPNode.h"

#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace daft::audio::tests {
namespace {

void AssertSamples(const std::vector<float>& actual, const std::vector<float>& expected, float epsilon,
                   const std::string& context) {
  if (actual.size() != expected.size()) {
    throw std::runtime_error(context + ": length mismatch");
  }
  for (std::size_t i = 0; i < actual.size(); ++i) {
    if (std::fabs(actual[i] - expected[i]) > epsilon) {
      throw std::runtime_error(context + ": sample " + std::to_string(i) + " expected " +
                               std::to_string(expected[i]) + " got " + std::to_string(actual[i]));
    }
  }
}

ClipPlayerNode::ClipBufferData CreateClipBuffer(const std::vector<std::vector<float>>& channels, double sampleRate) {
  auto storage = std::make_shared<std::vector<std::vector<float>>>(channels);
  ClipPlayerNode::ClipBufferData data;
  data.key = "test";
  data.sampleRate = sampleRate;
  data.frameCount = channels.empty() ? 0 : channels.front().size();
  data.owner = storage;
  data.channels.reserve(channels.size());
  for (const auto& channel : *storage) {
    data.channels.push_back(channel.data());
    if (channel.size() != data.frameCount) {
      throw std::runtime_error("Channel length mismatch");
    }
  }
  return data;
}

std::vector<float> RenderBlock(ClipPlayerNode& node, std::size_t frameCount) {
  StackAudioBuffer<1, 128> buffer;
  buffer.setFrameCount(frameCount);
  buffer.clear();
  float* channels[] = {buffer.channel(0)};
  AudioBufferView view(channels, 1, frameCount);
  node.process(view);
  return std::vector<float>(buffer.channel(0), buffer.channel(0) + frameCount);
}

void TestPlaybackScheduling() {
  ClipPlayerNode node;
  node.prepare(48000.0);
  node.setClipBuffer(CreateClipBuffer({{0.0F, 1.0F, 2.0F, 3.0F, 4.0F, 5.0F, 6.0F, 7.0F}}, 48000.0));
  node.setParameter("startframe", 4.0);
  node.setParameter("endframe", 12.0);
  node.setParameter("gain", 1.0);

  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 0.0F, 0.0F, 0.0F}, 1e-6F,
                "Clip silent before start");
  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 1.0F, 2.0F, 3.0F}, 1e-6F,
                "Clip first active block");
  AssertSamples(RenderBlock(node, 4), std::vector<float>{4.0F, 5.0F, 6.0F, 7.0F}, 1e-6F,
                "Clip second active block");
  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 0.0F, 0.0F, 0.0F}, 1e-6F,
                "Clip silent after end");
}

void TestFades() {
  ClipPlayerNode node;
  node.prepare(44100.0);
  node.setClipBuffer(CreateClipBuffer({{1.0F, 1.0F, 1.0F, 1.0F}}, 44100.0));
  node.setParameter("startframe", 0.0);
  node.setParameter("endframe", 4.0);
  node.setParameter("fadeinframes", 2.0);
  node.setParameter("fadeoutframes", 2.0);
  node.setParameter("gain", 0.5);

  const auto rendered = RenderBlock(node, 4);
  const std::vector<float> expected{0.25F, 0.5F, 0.5F, 0.25F};
  AssertSamples(rendered, expected, 1e-6F, "Clip fades");
}

void TestResetAllowsReplay() {
  ClipPlayerNode node;
  node.prepare(48000.0);
  node.setClipBuffer(CreateClipBuffer({{0.0F, 1.0F, 2.0F, 3.0F}}, 48000.0));
  node.setParameter("startframe", 4.0);
  node.setParameter("endframe", 8.0);

  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 0.0F, 0.0F, 0.0F}, 1e-6F,
                "Initial silence before clip");
  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 1.0F, 2.0F, 3.0F}, 1e-6F,
                "Initial playback block");

  node.reset();

  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 0.0F, 0.0F, 0.0F}, 1e-6F,
                "Silence after reset before start");
  AssertSamples(RenderBlock(node, 4), std::vector<float>{0.0F, 1.0F, 2.0F, 3.0F}, 1e-6F,
                "Playback repeats after reset");
}

}  // namespace

void RunClipPlayerNodeTests() {
  TestPlaybackScheduling();
  TestFades();
  TestResetAllowsReplay();
}

}  // namespace daft::audio::tests
