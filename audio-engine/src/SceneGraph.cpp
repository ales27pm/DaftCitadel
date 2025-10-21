#include "audio_engine/SceneGraph.h"

#include <algorithm>
#include <stdexcept>

namespace daft::audio {

namespace {
constexpr std::size_t kMaxChannels = 4;
constexpr std::size_t kMaxFrames = 1024;
}

SceneGraph::SceneGraph(double sampleRate)
    : sampleRate_(sampleRate), clock_(sampleRate, 128), scheduler_(clock_) {}

bool SceneGraph::addNode(const std::string& id, std::unique_ptr<DSPNode> node) {
  if (!node) {
    return false;
  }
  node->prepare(sampleRate_);
  return nodes_.emplace(id, std::move(node)).second;
}

void SceneGraph::removeNode(const std::string& id) {
  nodes_.erase(id);
  connections_.erase(std::remove_if(connections_.begin(), connections_.end(),
                                    [&](const auto& conn) {
                                      return conn.source == id || conn.destination == id;
                                    }),
                     connections_.end());
}

bool SceneGraph::connect(const std::string& source, const std::string& destination) {
  if (!nodes_.count(source) || !nodes_.count(destination)) {
    return false;
  }
  connections_.push_back({source, destination});
  return true;
}

void SceneGraph::disconnect(const std::string& source, const std::string& destination) {
  connections_.erase(std::remove_if(connections_.begin(), connections_.end(),
                                    [&](const auto& conn) {
                                      return conn.source == source && conn.destination == destination;
                                    }),
                     connections_.end());
}

void SceneGraph::render(AudioBufferView outputBuffer) {
  if (outputBuffer.channelCount() > kMaxChannels || outputBuffer.frameCount() > kMaxFrames) {
    throw std::runtime_error("Output buffer exceeds supported dimensions");
  }
  scheduler_.dispatchDueEvents();

  StackAudioBuffer<kMaxChannels, kMaxFrames> scratch;
  scratch.setFrameCount(outputBuffer.frameCount());

  for (std::size_t ch = 0; ch < outputBuffer.channelCount(); ++ch) {
    auto out = outputBuffer.channel(ch);
    std::fill(out.begin(), out.end(), 0.0F);
  }

  float* scratchChannels[kMaxChannels];
  for (std::size_t ch = 0; ch < kMaxChannels; ++ch) {
    scratchChannels[ch] = scratch.channel(ch);
  }

  for (const auto& connection : connections_) {
    auto it = nodes_.find(connection.source);
    if (it == nodes_.end()) {
      continue;
    }
    scratch.clear();
    AudioBufferView scratchView(scratchChannels, outputBuffer.channelCount(),
                                outputBuffer.frameCount());
    it->second->process(scratchView);

    for (std::size_t ch = 0; ch < outputBuffer.channelCount(); ++ch) {
      auto out = outputBuffer.channel(ch);
      auto in = scratchView.channel(ch);
      for (std::size_t i = 0; i < outputBuffer.frameCount(); ++i) {
        out[i] += in[i];
      }
    }
  }

  clock_.advance();
}

void SceneGraph::scheduleAutomation(const std::string& nodeId, std::function<void(DSPNode&)> cb,
                                    std::uint64_t frame) {
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) {
    throw std::runtime_error("Node not found");
  }

  const bool ok = scheduler_.schedule({frame, [node = it->second.get(), cb = std::move(cb)]() mutable {
                                          cb(*node);
                                        }});
  if (!ok) {
    throw std::runtime_error("Scheduler queue is full");
  }
}

}  // namespace daft::audio
