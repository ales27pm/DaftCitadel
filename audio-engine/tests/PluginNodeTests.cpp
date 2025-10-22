#include "audio_engine/PluginNode.h"

#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <vector>

namespace daft::audio::tests {
namespace {

struct RenderContext {
  int callCount = 0;
  float gain = 1.0F;
};

PluginRenderResult GainRenderCallback(PluginRenderRequest& request, void* userData) {
  auto* context = static_cast<RenderContext*>(userData);
  if (context == nullptr) {
    return PluginRenderResult{false, false};
  }
  ++context->callCount;
  for (std::size_t channel = 0; channel < request.audioBuffer.channelCount(); ++channel) {
    auto data = request.audioBuffer.channel(channel);
    for (auto& sample : data) {
      sample *= context->gain;
    }
  }
  return PluginRenderResult{true, false};
}

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

std::vector<float> RenderBuffer(PluginNode& node) {
  float channelData[4] = {0.25F, 0.5F, 0.75F, 1.0F};
  float* channels[] = {channelData};
  AudioBufferView view(channels, 1, 4);
  node.process(view);
  return std::vector<float>(channelData, channelData + 4);
}

void TestPassthroughWhenHostUnavailable() {
  PluginHostBridge::ClearRenderCallback();
  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;

  PluginNode node("host-instance", capabilities);
  node.prepare(48000.0);

  const auto rendered = RenderBuffer(node);
  AssertSamples(rendered, {0.25F, 0.5F, 0.75F, 1.0F}, 1e-6F, "Passthrough without host");

  PluginHostBridge::ClearRenderCallback();
}

void TestRenderInvokesHost() {
  RenderContext context;
  context.gain = 0.5F;
  PluginHostBridge::SetRenderCallback(&GainRenderCallback, &context);

  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;

  PluginNode node("host-instance", capabilities);
  node.prepare(44100.0);

  const auto rendered = RenderBuffer(node);
  AssertSamples(rendered, {0.125F, 0.25F, 0.375F, 0.5F}, 1e-6F, "Host applies gain");
  if (context.callCount != 1) {
    throw std::runtime_error("Render callback should be invoked exactly once");
  }

  PluginHostBridge::ClearRenderCallback();
}

void TestBypassSkipsHost() {
  RenderContext context;
  context.gain = 2.0F;
  PluginHostBridge::SetRenderCallback(&GainRenderCallback, &context);

  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;

  PluginNode node("host-instance", capabilities);
  node.prepare(44100.0);
  node.setParameter("bypassed", 1.0);

  const auto rendered = RenderBuffer(node);
  AssertSamples(rendered, {0.25F, 0.5F, 0.75F, 1.0F}, 1e-6F, "Bypassed node should passthrough");
  if (context.callCount != 0) {
    throw std::runtime_error("Render callback should not run when bypassed");
  }

  PluginHostBridge::ClearRenderCallback();
}

}  // namespace

void RunPluginNodeTests() {
  TestPassthroughWhenHostUnavailable();
  TestRenderInvokesHost();
  TestBypassSkipsHost();
}

}  // namespace daft::audio::tests
