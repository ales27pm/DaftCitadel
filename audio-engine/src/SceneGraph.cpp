#include "audio_engine/SceneGraph.h"

#include <algorithm>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace daft::audio {

SceneGraph::SceneGraph(double sampleRate, std::uint32_t framesPerBuffer)
    : sampleRate_(sampleRate),
      clock_(sampleRate, framesPerBuffer),
      scheduler_(clock_) {}

bool SceneGraph::addNode(const std::string& id, std::unique_ptr<DSPNode> node) {
  if (!node) {
    return false;
  }
  node->prepare(sampleRate_);
  const auto result = nodes_.emplace(id, std::move(node));
  if (result.second) {
    nodeBuffers_.try_emplace(id);
    rebuildTopology();
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
  rebuildTopology();
}

bool SceneGraph::connect(const std::string& source, const std::string& destination) {
  if (!nodes_.count(source)) {
    return false;
  }
  if (destination != kOutputBusId && !nodes_.count(destination)) {
    return false;
  }
  const auto duplicate = std::find_if(connections_.begin(), connections_.end(),
                                      [&](const Connection& conn) {
                                        return conn.source == source && conn.destination == destination;
                                      }) != connections_.end();
  if (duplicate) {
    return false;
  }
  connections_.push_back({source, destination});
  rebuildTopology();
  return true;
}

void SceneGraph::disconnect(const std::string& source, const std::string& destination) {
  connections_.erase(std::remove_if(connections_.begin(), connections_.end(),
                                    [&](const auto& conn) {
                                      return conn.source == source && conn.destination == destination;
                                    }),
                     connections_.end());
  rebuildTopology();
}

void SceneGraph::render(AudioBufferView outputBuffer) {
  if (outputBuffer.channelCount() > kMaxChannels || outputBuffer.frameCount() > kMaxFrames) {
    outputBuffer.fill(0.0F);
    return;
  }
  scheduler_.dispatchDueEvents();
  outputBuffer.fill(0.0F);

  const auto channelCount = outputBuffer.channelCount();
  const auto frameCount = outputBuffer.frameCount();

  ensureNodeBuffers(channelCount, frameCount);

  for (const auto& nodeId : renderOrder_) {
    const auto nodeIt = nodes_.find(nodeId);
    if (nodeIt == nodes_.end()) {
      continue;
    }
    auto bufferIt = nodeBuffers_.find(nodeId);
    if (bufferIt == nodeBuffers_.end()) {
      continue;
    }

    auto view = bufferIt->second.view(channelCount);
    view.fill(0.0F);

    if (const auto inboundIt = inboundEdges_.find(nodeId); inboundIt != inboundEdges_.end()) {
      for (const auto& sourceId : inboundIt->second) {
        if (auto sourceIt = nodeBuffers_.find(sourceId); sourceIt != nodeBuffers_.end()) {
          view.addBufferInPlace(sourceIt->second.view(channelCount));
        }
      }
    }

    nodeIt->second->process(view);
  }

  for (const auto& sourceId : outputSources_) {
    if (auto it = nodeBuffers_.find(sourceId); it != nodeBuffers_.end()) {
      outputBuffer.addBufferInPlace(it->second.view(channelCount));
    }
  }

  clock_.advanceBy(static_cast<std::uint32_t>(frameCount));
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

void SceneGraph::rebuildTopology() {
  inboundEdges_.clear();
  outputSources_.clear();
  renderOrder_.clear();

  if (nodes_.empty()) {
    return;
  }

  std::unordered_map<std::string, std::size_t> indegree;
  indegree.reserve(nodes_.size());
  for (const auto& [id, _] : nodes_) {
    indegree.emplace(id, 0U);
  }

  std::unordered_map<std::string, std::vector<std::string>> adjacency;
  adjacency.reserve(nodes_.size());

  std::unordered_set<std::string> sourcesFeedingOutput;

  for (const auto& connection : connections_) {
    if (!nodes_.count(connection.source)) {
      continue;
    }
    if (connection.destination == kOutputBusId) {
      sourcesFeedingOutput.insert(connection.source);
      continue;
    }
    if (!nodes_.count(connection.destination)) {
      continue;
    }
    adjacency[connection.source].push_back(connection.destination);
    inboundEdges_[connection.destination].push_back(connection.source);
    ++indegree[connection.destination];
  }

  std::vector<std::string> queue;
  queue.reserve(nodes_.size());
  for (const auto& [id, degree] : indegree) {
    if (degree == 0U) {
      queue.push_back(id);
    }
  }

  std::size_t index = 0;
  while (index < queue.size()) {
    const auto current = queue[index++];
    renderOrder_.push_back(current);

    if (const auto adjIt = adjacency.find(current); adjIt != adjacency.end()) {
      for (const auto& dest : adjIt->second) {
        auto degIt = indegree.find(dest);
        if (degIt != indegree.end() && degIt->second > 0U) {
          --degIt->second;
          if (degIt->second == 0U) {
            queue.push_back(dest);
          }
        }
      }
    }
  }

  for (const auto& [id, degree] : indegree) {
    if (degree > 0U && std::find(renderOrder_.begin(), renderOrder_.end(), id) == renderOrder_.end()) {
      renderOrder_.push_back(id);
    }
  }

  if (!sourcesFeedingOutput.empty()) {
    outputSources_.assign(sourcesFeedingOutput.begin(), sourcesFeedingOutput.end());
  } else {
    outputSources_.clear();
    for (const auto& [id, _] : nodes_) {
      if (!adjacency.count(id)) {
        outputSources_.push_back(id);
      }
    }
  }
}

void SceneGraph::ensureNodeBuffers(std::size_t channelCount, std::size_t frameCount) {
  for (const auto& [id, _] : nodes_) {
    auto& buffer = nodeBuffers_[id];
    buffer.configure(channelCount, frameCount);
  }
  clock_.setFramesPerBuffer(static_cast<std::uint32_t>(frameCount));
}

}  // namespace daft::audio
