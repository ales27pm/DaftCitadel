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
  PluginBusCapabilities lastCapabilities{};
  std::string lastHostInstanceId;
  bool lastBypassed = false;
};

PluginRenderResult GainRenderCallback(PluginRenderRequest& request, void* userData) {
  auto* context = static_cast<RenderContext*>(userData);
  if (context == nullptr) {
    return PluginRenderResult{false, false};
  }
  ++context->callCount;
  context->lastHostInstanceId = std::string(request.hostInstanceId);
  context->lastCapabilities = request.capabilities;
  context->lastBypassed = request.bypassed;
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

void TestPassthroughWithEmptyHostInstanceId() {
  RenderContext context;
  context.gain = 2.0F;
  PluginHostBridge::SetRenderCallback(&GainRenderCallback, &context);

  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;

  PluginNode node("", capabilities);
  node.prepare(48000.0);

  const auto rendered = RenderBuffer(node);
  AssertSamples(rendered, {0.25F, 0.5F, 0.75F, 1.0F}, 1e-6F, "Passthrough with empty hostInstanceId");
  if (context.callCount != 0) {
    throw std::runtime_error("Render callback should not run when hostInstanceId is empty");
  }

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

void TestPluginNodeWithMidiCapabilities() {
  RenderContext context;
  context.gain = 1.0F;
  PluginHostBridge::SetRenderCallback(&GainRenderCallback, &context);

  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;
  capabilities.acceptsMidi = true;
  capabilities.emitsMidi = true;

  PluginNode node("midi-instance", capabilities);
  node.prepare(44100.0);

  const auto rendered = RenderBuffer(node);
  AssertSamples(rendered, {0.25F, 0.5F, 0.75F, 1.0F}, 1e-6F, "MIDI capabilities should passthrough audio when gain is 1.0");
  if (context.callCount != 1) {
    throw std::runtime_error("Render callback should run once for MIDI-capable node");
  }
  if (context.lastHostInstanceId != "midi-instance") {
    throw std::runtime_error("Host instance ID was not propagated to render callback");
  }
  if (!context.lastCapabilities.acceptsMidi || !context.lastCapabilities.emitsMidi) {
    throw std::runtime_error("MIDI capabilities were not forwarded to render callback");
  }

  PluginHostBridge::ClearRenderCallback();
}

void TestPluginNodeWithSidechainCapabilities() {
  RenderContext context;
  context.gain = 0.8F;
  PluginHostBridge::SetRenderCallback(&GainRenderCallback, &context);

  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;
  capabilities.acceptsSidechain = true;
  capabilities.emitsSidechain = true;

  PluginNode node("sidechain-instance", capabilities);
  node.prepare(44100.0);

  const auto rendered = RenderBuffer(node);
  AssertSamples(rendered, {0.2F, 0.4F, 0.6F, 0.8F}, 1e-6F, "Sidechain capabilities should still apply host gain");
  if (context.callCount != 1) {
    throw std::runtime_error("Render callback should run once for sidechain-capable node");
  }
  if (!context.lastCapabilities.acceptsSidechain || !context.lastCapabilities.emitsSidechain) {
    throw std::runtime_error("Sidechain capabilities were not forwarded to render callback");
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

void TestBypassToggleDuringProcessing() {
  RenderContext context;
  context.gain = 2.0F;
  PluginHostBridge::SetRenderCallback(&GainRenderCallback, &context);

  PluginBusCapabilities capabilities{};
  capabilities.acceptsAudio = true;
  capabilities.emitsAudio = true;

  PluginNode node("host-instance", capabilities);
  node.prepare(44100.0);

  const auto activeRender = RenderBuffer(node);
  AssertSamples(activeRender, {0.5F, 1.0F, 1.5F, 2.0F}, 1e-6F, "Host should apply gain before bypass");
  if (context.callCount != 1) {
    throw std::runtime_error("Render callback should run before bypass is enabled");
  }

  node.setParameter("bypassed", 1.0);
  const auto bypassedRender = RenderBuffer(node);
  AssertSamples(bypassedRender, {0.25F, 0.5F, 0.75F, 1.0F}, 1e-6F, "Bypassed node should passthrough after toggle");
  if (context.callCount != 1) {
    throw std::runtime_error("Render callback should not run while bypassed");
  }

  node.setParameter("bypassed", 0.0);
  const auto resumedRender = RenderBuffer(node);
  AssertSamples(resumedRender, {0.5F, 1.0F, 1.5F, 2.0F}, 1e-6F, "Host should resume processing after bypass is cleared");
  if (context.callCount != 2) {
    throw std::runtime_error("Render callback should resume after bypass is cleared");
  }

  PluginHostBridge::ClearRenderCallback();
}

void TestSetParameterUpdatesHostInstanceId() {
  PluginBusCapabilities capabilities{};
  PluginNode node("initial-instance", capabilities);

  node.setParameter("hostInstanceId", 42.0);
  if (node.hostInstanceId() != "42") {
    throw std::runtime_error("hostInstanceId parameter should update node host instance identifier");
  }
}

}  // namespace

void RunPluginNodeTests() {
  TestPassthroughWhenHostUnavailable();
  TestPassthroughWithEmptyHostInstanceId();
  TestRenderInvokesHost();
  TestPluginNodeWithMidiCapabilities();
  TestPluginNodeWithSidechainCapabilities();
  TestBypassSkipsHost();
  TestBypassToggleDuringProcessing();
  TestSetParameterUpdatesHostInstanceId();
}

}  // namespace daft::audio::tests
