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
  node->locate(clock_.frameTime());
  const auto result = nodes_.emplace(id, std::move(node));
  if (result.second) {
    nodeIncarnations_[id] = nextNodeIncarnation_++;
    nodeBuffers_.try_emplace(id);
    rebuildTopology();
  }
  return result.second;
}

void SceneGraph::removeNode(const std::string& id) {
  nodes_.erase(id);
  nodeIncarnations_.erase(id);
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
  if (wouldIntroduceCycle(source, destination)) {
    return false;
  }
  connections_.push_back({source, destination});
  rebuildTopology();
  return true;
}

bool SceneGraph::wouldIntroduceCycle(const std::string& source,
                                     const std::string& destination) const {
  if (destination == kOutputBusId) {
    return false;
  }
  if (source == destination) {
    return true;
  }

  std::vector<std::string> pending{destination};
  std::unordered_set<std::string> visited;
  while (!pending.empty()) {
    auto current = std::move(pending.back());
    pending.pop_back();
    if (!visited.insert(current).second) {
      continue;
    }
    if (current == source) {
      return true;
    }
    for (const auto& connection : connections_) {
      if (connection.source == current && connection.destination != kOutputBusId) {
        pending.push_back(connection.destination);
      }
    }
  }
  return false;
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
  outputBuffer.fill(0.0F);

  std::size_t renderedFrames = 0U;
  while (renderedFrames < outputBuffer.frameCount()) {
    if (transportLoopEnabled_ && clock_.frameTime() >= loopEndFrame_) {
      rewindTransportLoop();
    }

    const auto remainingFrames = outputBuffer.frameCount() - renderedFrames;
    auto sectionFrames = remainingFrames;
    if (transportLoopEnabled_) {
      const auto framesUntilLoopEnd = loopEndFrame_ - clock_.frameTime();
      sectionFrames = static_cast<std::size_t>(std::min<std::uint64_t>(
          static_cast<std::uint64_t>(remainingFrames), framesUntilLoopEnd));
    }
    if (sectionFrames == 0U) {
      // A valid loop always advances after rewind; this guard also prevents an
      // accidental control-state regression from spinning on the audio thread.
      break;
    }

    renderSection(outputBuffer, renderedFrames, sectionFrames);
    renderedFrames += sectionFrames;

    // Rewind immediately when a callback lands exactly on the exclusive loop
    // end. The next callback therefore observes loopStartFrame_ rather than a
    // transient out-of-range clock value.
    if (transportLoopEnabled_ && clock_.frameTime() == loopEndFrame_) {
      rewindTransportLoop();
    }
  }
}

void SceneGraph::renderSection(AudioBufferView outputBuffer,
                               std::size_t frameOffset,
                               std::size_t frameCount) {
  std::array<float*, kMaxChannels> sectionChannels{};
  for (std::size_t channel = 0U; channel < outputBuffer.channelCount(); ++channel) {
    sectionChannels[channel] = outputBuffer.channel(channel).data() + frameOffset;
  }
  AudioBufferView sectionOutput(sectionChannels.data(), outputBuffer.channelCount(),
                                frameCount);

  scheduler_.dispatchDueEvents();
  const auto channelCount = sectionOutput.channelCount();

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
      sectionOutput.addBufferInPlace(it->second.view(channelCount));
    }
  }

  clock_.advanceBy(static_cast<std::uint32_t>(frameCount));
}

void SceneGraph::locate(std::uint64_t frame) {
  clock_.locate(frame);
  for (auto& [_, node] : nodes_) {
    node->locate(frame);
  }
}

void SceneGraph::setTransportLoop(std::uint64_t startFrame,
                                  std::uint64_t endFrame, bool enabled) {
  if (enabled && startFrame >= endFrame) {
    throw std::invalid_argument(
        "Enabled transport loop requires startFrame < endFrame");
  }

  if (transportLoopEnabled_) {
    for (auto& [_, node] : nodes_) {
      if (auto* instrument = dynamic_cast<InstrumentNode*>(node.get())) {
        instrument->restoreTimelineAfterLoop(clock_.frameTime());
      }
    }
  }

  loopStartFrame_ = startFrame;
  loopEndFrame_ = endFrame;
  transportLoopEnabled_ = enabled;
  if (transportLoopEnabled_ && clock_.frameTime() >= loopEndFrame_) {
    rewindTransportLoop();
  }
}

void SceneGraph::rewindTransportLoop() {
  clock_.locate(loopStartFrame_);
  for (auto& [_, node] : nodes_) {
    if (auto* instrument = dynamic_cast<InstrumentNode*>(node.get())) {
      instrument->rewindTimelineForLoop(loopStartFrame_, loopEndFrame_);
    } else {
      node->locate(loopStartFrame_);
    }
  }
}

void SceneGraph::scheduleAutomation(const std::string& nodeId, std::function<void(DSPNode&)> cb,
                                    std::uint64_t frame) {
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) {
    throw std::runtime_error("Node not found");
  }
  const auto incarnationIt = nodeIncarnations_.find(nodeId);
  if (incarnationIt == nodeIncarnations_.end()) {
    throw std::runtime_error("Node incarnation not found");
  }
  const auto incarnation = incarnationIt->second;

  const bool ok = scheduler_.schedule({
      frame,
      [this, nodeId, incarnation, cb = std::move(cb)]() mutable {
        const auto currentIncarnation = nodeIncarnations_.find(nodeId);
        if (currentIncarnation == nodeIncarnations_.end() ||
            currentIncarnation->second != incarnation) {
          return;
        }
        const auto node = nodes_.find(nodeId);
        if (node != nodes_.end()) {
          cb(*node->second);
        }
      },
  });
  if (!ok) {
    throw std::runtime_error("Scheduler queue is full");
  }
}

void SceneGraph::scheduleInstrumentEvents(
    const std::string& nodeId, std::span<const InstrumentEvent> events,
    bool replace) {
  const auto node = nodes_.find(nodeId);
  if (node == nodes_.end()) {
    throw std::runtime_error("Node not found");
  }
  auto* instrument = dynamic_cast<InstrumentNode*>(node->second.get());
  if (instrument == nullptr) {
    throw std::runtime_error("Node is not an instrument");
  }
  if (!instrument->scheduleEvents(events, replace)) {
    throw std::runtime_error("Instrument event queue is full or contains an invalid event");
  }
}

void SceneGraph::setInstrumentParameter(const std::string& nodeId,
                                        std::uint16_t parameter, float value) {
  const auto node = nodes_.find(nodeId);
  if (node == nodes_.end()) {
    throw std::runtime_error("Node not found");
  }
  auto* instrument = dynamic_cast<InstrumentNode*>(node->second.get());
  if (instrument == nullptr) {
    throw std::runtime_error("Node is not an instrument");
  }
  if (!instrument->setImmediateParameter(parameter, value)) {
    throw std::runtime_error("Instrument parameter is invalid");
  }
}

void SceneGraph::allNotesOff(const std::string& nodeId) {
  const auto node = nodes_.find(nodeId);
  if (node == nodes_.end()) {
    throw std::runtime_error("Node not found");
  }
  auto* instrument = dynamic_cast<InstrumentNode*>(node->second.get());
  if (instrument == nullptr) {
    throw std::runtime_error("Node is not an instrument");
  }
  instrument->allNotesOff();
}

void SceneGraph::allNotesOff() {
  for (auto& [_, node] : nodes_) {
    if (auto* instrument = dynamic_cast<InstrumentNode*>(node.get())) {
      instrument->allNotesOff();
    }
  }
}

void SceneGraph::panicInstruments() noexcept {
  for (auto& [_, node] : nodes_) {
    if (auto* instrument = dynamic_cast<InstrumentNode*>(node.get())) {
      instrument->panic();
    }
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
  std::sort(queue.begin(), queue.end());
  for (auto& [_, destinations] : adjacency) {
    std::sort(destinations.begin(), destinations.end());
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

  if (renderOrder_.size() != nodes_.size()) {
    renderOrder_.clear();
    inboundEdges_.clear();
    outputSources_.clear();
    return;
  }

  if (!sourcesFeedingOutput.empty()) {
    outputSources_.assign(sourcesFeedingOutput.begin(), sourcesFeedingOutput.end());
    std::sort(outputSources_.begin(), outputSources_.end());
  } else {
    outputSources_.clear();
    for (const auto& [id, _] : nodes_) {
      if (!adjacency.count(id)) {
        outputSources_.push_back(id);
      }
    }
    std::sort(outputSources_.begin(), outputSources_.end());
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
