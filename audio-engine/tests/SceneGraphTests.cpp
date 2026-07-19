#include "audio_engine/SceneGraph.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>

namespace daft::audio::tests {
namespace {

class SilentNode final : public DSPNode {
 public:
  void process(AudioBufferView) override {}
  void setParameter(const std::string&, double) override {}
};

class ConstantNode final : public DSPNode {
 public:
  explicit ConstantNode(float value) : value_(value) {}

  void process(AudioBufferView buffer) override { buffer.fill(value_); }
  void setParameter(const std::string&, double value) override {
    value_ = static_cast<float>(value);
  }

 private:
  float value_;
};

class LocationTrackingNode final : public DSPNode {
 public:
  void locate(std::uint64_t frame) override { locatedFrame = frame; }
  void process(AudioBufferView) override {}
  void setParameter(const std::string&, double) override {}

  std::uint64_t locatedFrame = 0;
};

AudioBufferView MakeMonoView(std::array<float, 64>& samples) {
  static std::array<float*, 1> channels{};
  channels[0] = samples.data();
  return AudioBufferView(channels.data(), channels.size(), samples.size());
}

void TestAutomationDoesNotOutliveNode() {
  SceneGraph graph(48000.0, 64);
  if (!graph.addNode("target", std::make_unique<SilentNode>())) {
    throw std::runtime_error("Failed to add automation target");
  }

  int callbackCount = 0;
  graph.scheduleAutomation("target", [&](DSPNode&) { ++callbackCount; }, 64);
  graph.removeNode("target");

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  graph.render(MakeMonoView(samples));
  if (callbackCount != 0) {
    throw std::runtime_error("Automation callback ran after its target was removed");
  }
}

void TestAutomationDoesNotTargetReusedId() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("target", std::make_unique<SilentNode>());

  int callbackCount = 0;
  graph.scheduleAutomation("target", [&](DSPNode&) { ++callbackCount; }, 64);
  graph.removeNode("target");
  graph.addNode("target", std::make_unique<SilentNode>());

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  graph.render(MakeMonoView(samples));
  if (callbackCount != 0) {
    throw std::runtime_error("Automation callback targeted a replacement node with a reused ID");
  }
}

void TestMixerProcessesGraphInputs() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("left", std::make_unique<ConstantNode>(0.25F));
  graph.addNode("right", std::make_unique<ConstantNode>(0.5F));
  auto mixer = std::make_unique<MixerNode>(2);
  mixer->setParameter("gain", 2.0);
  graph.addNode("mixer", std::move(mixer));

  if (!graph.connect("left", "mixer") || !graph.connect("right", "mixer") ||
      !graph.connect("mixer", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Failed to build mixer graph");
  }

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  for (const auto sample : samples) {
    if (std::fabs(sample - 1.5F) > 1e-6F) {
      throw std::runtime_error("Mixer discarded or incorrectly scaled graph input");
    }
  }
}

void TestGraphClockCanLocate() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("source", std::make_unique<ConstantNode>(0.25F));
  graph.connect("source", std::string(SceneGraph::kOutputBusId));

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  if (graph.currentFrame() != 64) {
    throw std::runtime_error("Graph clock did not advance after rendering");
  }

  graph.locate(4096);
  if (graph.currentFrame() != 4096) {
    throw std::runtime_error("Graph clock did not locate to the requested frame");
  }
}

void TestNewNodesLocateToCurrentGraphFrame() {
  SceneGraph graph(48000.0, 64);
  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));

  auto node = std::make_unique<LocationTrackingNode>();
  auto* nodePtr = node.get();
  if (!graph.addNode("late", std::move(node))) {
    throw std::runtime_error("Failed to add node after the graph clock advanced");
  }
  if (nodePtr->locatedFrame != 64) {
    throw std::runtime_error("New node did not locate to the current graph frame");
  }

  graph.removeNode("late");
  graph.locate(4096);
  auto replacement = std::make_unique<LocationTrackingNode>();
  auto* replacementPtr = replacement.get();
  if (!graph.addNode("late", std::move(replacement))) {
    throw std::runtime_error("Failed to add replacement node");
  }
  if (replacementPtr->locatedFrame != 4096) {
    throw std::runtime_error("Replacement node did not locate to the current graph frame");
  }
}

void TestGraphRejectsCycles() {
  SceneGraph graph(48000.0, 64);
  graph.addNode("source", std::make_unique<ConstantNode>(0.25F));
  graph.addNode("middle", std::make_unique<SilentNode>());
  graph.addNode("sink", std::make_unique<SilentNode>());

  if (!graph.connect("source", "middle") || !graph.connect("middle", "sink")) {
    throw std::runtime_error("Failed to build acyclic graph");
  }
  if (graph.connect("sink", "source")) {
    throw std::runtime_error("Graph accepted a multi-node cycle");
  }
  if (graph.connect("middle", "middle")) {
    throw std::runtime_error("Graph accepted a self-cycle");
  }
  if (!graph.connect("sink", std::string(SceneGraph::kOutputBusId))) {
    throw std::runtime_error("Cycle rejection corrupted valid graph connections");
  }

  std::array<float, 64> samples{};
  graph.render(MakeMonoView(samples));
  for (const auto sample : samples) {
    if (std::fabs(sample - 0.25F) > 1e-6F) {
      throw std::runtime_error("Acyclic graph rendered incorrectly after cycle rejection");
    }
  }
}

void TestTrackOutputAppliesGainAndPan() {
  TrackOutputNode output;
  output.setParameter("gain", 0.5);
  output.setParameter("pan", 1.0);

  std::array<float, 4> left{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float, 4> right{1.0F, 1.0F, 1.0F, 1.0F};
  std::array<float*, 2> channels{left.data(), right.data()};
  output.process(AudioBufferView(channels.data(), channels.size(), left.size()));

  for (const auto sample : left) {
    if (std::fabs(sample) > 1e-6F) {
      throw std::runtime_error("Hard-right pan did not silence the left channel");
    }
  }
  for (const auto sample : right) {
    if (std::fabs(sample - 0.5F) > 1e-6F) {
      throw std::runtime_error("Track output did not apply gain to the right channel");
    }
  }
}

}  // namespace

void RunSceneGraphTests() {
  TestAutomationDoesNotOutliveNode();
  TestAutomationDoesNotTargetReusedId();
  TestMixerProcessesGraphInputs();
  TestGraphClockCanLocate();
  TestNewNodesLocateToCurrentGraphFrame();
  TestGraphRejectsCycles();
  TestTrackOutputAppliesGainAndPan();
}

}  // namespace daft::audio::tests
