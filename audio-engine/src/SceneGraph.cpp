#include "audio_engine/SceneGraph.h"

#include <algorithm>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace daft::audio {

SceneGraph::SceneGraph(double sampleRate)
    : sampleRate_(sampleRate), clock_(sampleRate, 128), scheduler_(clock_) {}

bool SceneGraph::addNode(const std::string& id, std::unique_ptr<DSPNode> node) {
  if (!node) {
    return false;
  }
  node->prepare(sampleRate_);
  const auto result = nodes_.emplace(id, std::move(node));
  if (result.second) {
    nodeBuffers_.try_emplace(id);
  }
  return result.second;
}

void SceneGraph::removeNode(const std::string& id) {
  nodes_.erase(id);
  nodeBuffers_.erase(id);
  connections_.erase(std::remove_if(connections_.begin(), connections_.end(),
                                    [&](const auto& conn) {
                                      return conn.source == id || conn.destination == id;
                                    }),
                     connections_.end());
}

bool SceneGraph::connect(const std::string& source, const std::string& destination) {
  if (!nodes_.count(source)) {
    return false;
  }
  if (destination != kOutputBusId && !nodes_.count(destination)) {
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
  outputBuffer.fill(0.0F);

  const auto channelCount = outputBuffer.channelCount();
  const auto frameCount = outputBuffer.frameCount();

  for (auto& [id, buffer] : nodeBuffers_) {
    (void)id;
    buffer.configure(channelCount, frameCount);
    buffer.view(channelCount).fill(0.0F);
  }

  std::unordered_map<std::string, std::vector<std::string>> inbound;
  std::vector<std::string> outputSources;
  inbound.reserve(nodes_.size());

  std::unordered_set<std::string> nodesWithOutgoing;

  for (const auto& connection : connections_) {
    nodesWithOutgoing.insert(connection.source);
    if (connection.destination == kOutputBusId) {
      outputSources.push_back(connection.source);
    } else {
      inbound[connection.destination].push_back(connection.source);
    }
  }

  if (outputSources.empty()) {
    for (const auto& [nodeId, _] : nodes_) {
      if (nodesWithOutgoing.count(nodeId) == 0U) {
        outputSources.push_back(nodeId);
      }
    }
  }

  std::unordered_set<std::string> visiting;
  std::unordered_set<std::string> rendered;

  auto renderNode = [&](const std::string& nodeId, const auto& self) -> AudioBufferView {
    if (rendered.count(nodeId) > 0U) {
      auto bufferIt = nodeBuffers_.find(nodeId);
      if (bufferIt == nodeBuffers_.end()) {
        throw std::runtime_error("Buffer missing for node");
      }
      return bufferIt->second.view(channelCount);
    }

    if (visiting.count(nodeId) > 0U) {
      throw std::runtime_error("Cycle detected in scene graph");
    }

    const auto nodeIt = nodes_.find(nodeId);
    if (nodeIt == nodes_.end()) {
      throw std::runtime_error("Node missing during render");
    }

    auto bufferIt = nodeBuffers_.find(nodeId);
    if (bufferIt == nodeBuffers_.end()) {
      throw std::runtime_error("Buffer missing for node");
    }

    visiting.insert(nodeId);

    auto view = bufferIt->second.view(channelCount);
    view.fill(0.0F);

    if (const auto inboundIt = inbound.find(nodeId); inboundIt != inbound.end()) {
      for (const auto& sourceId : inboundIt->second) {
        auto sourceView = self(sourceId, self);
        view.addBufferInPlace(sourceView);
      }
    }

    nodeIt->second->process(view);

    visiting.erase(nodeId);
    rendered.insert(nodeId);
    return view;
  };

  for (const auto& sourceId : outputSources) {
    auto view = renderNode(sourceId, renderNode);
    outputBuffer.addBufferInPlace(view);
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
