#include "audio_engine/SceneGraph.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace daft::audio {
namespace {

[[nodiscard]] std::uint64_t SaturatingAdd(std::uint64_t value,
                                           std::uint64_t increment) noexcept {
  const auto maximum = std::numeric_limits<std::uint64_t>::max();
  return increment > maximum - value ? maximum : value + increment;
}

}  // namespace

SceneGraph::SceneGraph(double sampleRate, std::uint32_t framesPerBuffer)
    : sampleRate_(sampleRate), clock_(sampleRate, framesPerBuffer) {}

bool SceneGraph::addNode(const std::string& id,
                         std::unique_ptr<DSPNode> node) {
  if (!node || nodes_.count(id) != 0U ||
      realtimeNodes_.size() >
          static_cast<std::size_t>(
              std::numeric_limits<RealtimeNodeId>::max())) {
    return false;
  }

  node->prepare(sampleRate_);
  node->locate(clock_.frameTime());
  DSPNode* const nodePointer = node.get();
  InstrumentNode* const instrumentPointer =
      dynamic_cast<InstrumentNode*>(nodePointer);
  const auto result = nodes_.emplace(id, std::move(node));
  if (!result.second) {
    return false;
  }

  const auto realtimeId =
      static_cast<RealtimeNodeId>(realtimeNodes_.size());
  realtimeNodeIds_.emplace(id, realtimeId);
  realtimeNodes_.push_back(nodePointer);
  realtimeInstruments_.push_back(instrumentPointer);
  nodeBuffers_.try_emplace(id);
  rebuildTopology();
  return true;
}

void SceneGraph::removeNode(const std::string& id) {
  if (const auto realtimeIt = realtimeNodeIds_.find(id);
      realtimeIt != realtimeNodeIds_.end()) {
    const auto realtimeId = realtimeIt->second;
    if (static_cast<std::size_t>(realtimeId) < realtimeNodes_.size()) {
      realtimeNodes_[realtimeId] = nullptr;
      realtimeInstruments_[realtimeId] = nullptr;
    }
    discardAutomationForNode(realtimeId);
    realtimeNodeIds_.erase(realtimeIt);
  }

  nodes_.erase(id);
  nodeBuffers_.erase(id);
  connections_.erase(
      std::remove_if(connections_.begin(), connections_.end(),
                     [&](const auto& connection) {
                       return connection.source == id ||
                              connection.destination == id;
                     }),
      connections_.end());
  rebuildTopology();
}

bool SceneGraph::connect(const std::string& source,
                         const std::string& destination) {
  if (nodes_.count(source) == 0U) {
    return false;
  }
  if (destination != kOutputBusId && nodes_.count(destination) == 0U) {
    return false;
  }
  const auto duplicate =
      std::find_if(connections_.begin(), connections_.end(),
                   [&](const Connection& connection) {
                     return connection.source == source &&
                            connection.destination == destination;
                   }) != connections_.end();
  if (duplicate || wouldIntroduceCycle(source, destination)) {
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
      if (connection.source == current &&
          connection.destination != kOutputBusId) {
        pending.push_back(connection.destination);
      }
    }
  }
  return false;
}

void SceneGraph::disconnect(const std::string& source,
                            const std::string& destination) {
  connections_.erase(
      std::remove_if(connections_.begin(), connections_.end(),
                     [&](const auto& connection) {
                       return connection.source == source &&
                              connection.destination == destination;
                     }),
      connections_.end());
  rebuildTopology();
}

void SceneGraph::render(AudioBufferView outputBuffer) noexcept {
  if (outputBuffer.channelCount() > kMaxChannels ||
      outputBuffer.frameCount() > kMaxFrames) {
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
      break;
    }

    renderSection(outputBuffer, renderedFrames, sectionFrames);
    renderedFrames += sectionFrames;

    if (transportLoopEnabled_ && clock_.frameTime() == loopEndFrame_) {
      rewindTransportLoop();
    }
  }
}

void SceneGraph::renderSection(AudioBufferView outputBuffer,
                               std::size_t frameOffset,
                               std::size_t frameCount) noexcept {
  std::array<float*, kMaxChannels> sectionChannels{};
  for (std::size_t channel = 0U; channel < outputBuffer.channelCount();
       ++channel) {
    sectionChannels[channel] =
        outputBuffer.channel(channel).data() + frameOffset;
  }
  AudioBufferView sectionOutput(sectionChannels.data(),
                                outputBuffer.channelCount(), frameCount);

  dispatchDueParameterAutomation();
  const auto channelCount = sectionOutput.channelCount();
  ensureNodeBuffers(channelCount, frameCount);

  for (const auto& nodeId : renderOrder_) {
    const auto nodeIt = nodes_.find(nodeId);
    const auto bufferIt = nodeBuffers_.find(nodeId);
    if (nodeIt == nodes_.end() || bufferIt == nodeBuffers_.end()) {
      continue;
    }

    auto view = bufferIt->second.view(channelCount);
    view.fill(0.0F);

    if (const auto inboundIt = inboundEdges_.find(nodeId);
        inboundIt != inboundEdges_.end()) {
      for (const auto& sourceId : inboundIt->second) {
        if (auto sourceIt = nodeBuffers_.find(sourceId);
            sourceIt != nodeBuffers_.end()) {
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

void SceneGraph::locate(std::uint64_t frame) noexcept {
  clock_.locate(frame);
  for (std::size_t index = 1U; index < realtimeNodes_.size(); ++index) {
    if (auto* node = realtimeNodes_[index]; node != nullptr) {
      node->locate(frame);
    }
  }
}

void SceneGraph::setTransportLoop(std::uint64_t startFrame,
                                  std::uint64_t endFrame, bool enabled) {
  if (!setTransportLoopState(startFrame, endFrame, enabled)) {
    throw std::invalid_argument(
        "Enabled transport loop requires startFrame < endFrame");
  }
}

bool SceneGraph::setTransportLoopState(std::uint64_t startFrame,
                                       std::uint64_t endFrame,
                                       bool enabled) noexcept {
  if (enabled && startFrame >= endFrame) {
    return false;
  }

  if (transportLoopEnabled_) {
    for (std::size_t index = 1U; index < realtimeInstruments_.size();
         ++index) {
      if (auto* instrument = realtimeInstruments_[index];
          instrument != nullptr) {
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
  return true;
}

void SceneGraph::rewindTransportLoop() noexcept {
  clock_.locate(loopStartFrame_);
  for (std::size_t index = 1U; index < realtimeNodes_.size(); ++index) {
    auto* node = realtimeNodes_[index];
    if (node == nullptr) {
      continue;
    }
    if (auto* instrument = realtimeInstruments_[index];
        instrument != nullptr) {
      instrument->rewindTimelineForLoop(loopStartFrame_, loopEndFrame_);
    } else {
      node->locate(loopStartFrame_);
    }
  }
}

RealtimeNodeId SceneGraph::resolveRealtimeNodeId(
    const std::string& nodeId) const noexcept {
  const auto node = realtimeNodeIds_.find(nodeId);
  return node == realtimeNodeIds_.end() ? kInvalidRealtimeNodeId
                                        : node->second;
}

DSPNode* SceneGraph::nodeForRealtimeId(RealtimeNodeId nodeId) const noexcept {
  const auto index = static_cast<std::size_t>(nodeId);
  return nodeId != kInvalidRealtimeNodeId && index < realtimeNodes_.size()
             ? realtimeNodes_[index]
             : nullptr;
}

InstrumentNode* SceneGraph::instrumentForRealtimeId(
    RealtimeNodeId nodeId) const noexcept {
  const auto index = static_cast<std::size_t>(nodeId);
  return nodeId != kInvalidRealtimeNodeId &&
                 index < realtimeInstruments_.size()
             ? realtimeInstruments_[index]
             : nullptr;
}

std::optional<NodeParameterId> SceneGraph::resolveNodeParameterId(
    RealtimeNodeId nodeId, std::string_view parameter) const noexcept {
  const auto* node = nodeForRealtimeId(nodeId);
  return node == nullptr ? std::nullopt
                         : node->resolveParameterId(parameter);
}

bool SceneGraph::validateInstrumentEvent(
    RealtimeNodeId nodeId, const InstrumentEvent& event) const noexcept {
  const auto* instrument = instrumentForRealtimeId(nodeId);
  return instrument != nullptr && instrument->validateEvent(event);
}

bool SceneGraph::applyRealtimeCommand(
    const RealtimeControlCommand& command) noexcept {
  bool applied = false;
  switch (command.type) {
    case RealtimeCommandType::kScheduleInstrumentEvent: {
      InstrumentEvent event = command.instrumentEvent;
      event.frame = command.frameIsRelative
                        ? SaturatingAdd(clock_.frameTime(), command.frame)
                        : command.frame;
      if (command.frameIsRelative) {
        event.retainAcrossPanic = false;
      }
      applied = scheduleInstrumentEvent(command.nodeId, event);
      break;
    }
    case RealtimeCommandType::kClearInstrumentEvents: {
      auto* instrument = instrumentForRealtimeId(command.nodeId);
      if (instrument != nullptr) {
        instrument->clearScheduledEvents();
        applied = true;
      }
      break;
    }
    case RealtimeCommandType::kScheduleNodeParameter: {
      const auto frame = command.frameIsRelative
                             ? SaturatingAdd(clock_.frameTime(), command.frame)
                             : command.frame;
      applied = scheduleParameterAutomation(command.nodeId,
                                            command.parameterId, frame,
                                            command.parameterValue);
      break;
    }
    case RealtimeCommandType::kAllNotesOff:
      if (command.nodeId == kInvalidRealtimeNodeId) {
        allNotesOff();
        applied = true;
      } else {
        applied = allNotesOff(command.nodeId);
      }
      break;
    case RealtimeCommandType::kPanicAllInstruments:
      panicInstruments();
      applied = true;
      break;
    case RealtimeCommandType::kLocateTransport:
      locate(command.frame);
      applied = true;
      break;
    case RealtimeCommandType::kSetTransportLoop:
      applied = setTransportLoopState(command.frame, command.endFrame,
                                      command.enabled);
      break;
    default:
      break;
  }

  if (!applied) {
    realtimeCommandFailures_.fetch_add(1U, std::memory_order_relaxed);
  }
  return applied;
}

void SceneGraph::scheduleParameterAutomation(const std::string& nodeId,
                                              const std::string& parameter,
                                              std::uint64_t frame,
                                              double value) {
  const auto resolvedNode = resolveRealtimeNodeId(nodeId);
  if (resolvedNode == kInvalidRealtimeNodeId) {
    throw std::runtime_error("Node not found");
  }
  const auto resolvedParameter =
      resolveNodeParameterId(resolvedNode, parameter);
  if (!resolvedParameter) {
    throw std::runtime_error("Node parameter is invalid");
  }
  if (!scheduleParameterAutomation(resolvedNode, *resolvedParameter, frame,
                                   value)) {
    throw std::runtime_error(
        "Parameter automation queue is full or contains an invalid event");
  }
}

bool SceneGraph::scheduleParameterAutomation(
    RealtimeNodeId nodeId, NodeParameterId parameterId, std::uint64_t frame,
    double value) noexcept {
  if (nodeForRealtimeId(nodeId) == nullptr ||
      parameterId == kInvalidNodeParameterId || !std::isfinite(value)) {
    return false;
  }
  return insertParameterAutomation({frame, nodeId, parameterId, value});
}

bool SceneGraph::insertParameterAutomation(
    const ScheduledNodeParameter& event) noexcept {
  if (parameterAutomationCount_ >= parameterAutomation_.size()) {
    return false;
  }
  std::size_t insertion = parameterAutomationCount_;
  while (insertion > 0U &&
         parameterAutomation_[insertion - 1U].frame > event.frame) {
    parameterAutomation_[insertion] = parameterAutomation_[insertion - 1U];
    --insertion;
  }
  parameterAutomation_[insertion] = event;
  ++parameterAutomationCount_;
  return true;
}

void SceneGraph::dispatchDueParameterAutomation() noexcept {
  const auto now = clock_.frameTime();
  std::size_t dispatched = 0U;
  while (dispatched < parameterAutomationCount_ &&
         parameterAutomation_[dispatched].frame <= now) {
    const auto& event = parameterAutomation_[dispatched];
    if (auto* node = nodeForRealtimeId(event.nodeId); node != nullptr &&
        !node->setParameterById(event.parameterId, event.value)) {
      realtimeCommandFailures_.fetch_add(1U, std::memory_order_relaxed);
    }
    ++dispatched;
  }
  if (dispatched == 0U) {
    return;
  }
  for (std::size_t index = dispatched; index < parameterAutomationCount_;
       ++index) {
    parameterAutomation_[index - dispatched] = parameterAutomation_[index];
  }
  parameterAutomationCount_ -= dispatched;
}

void SceneGraph::discardAutomationForNode(RealtimeNodeId nodeId) noexcept {
  std::size_t retained = 0U;
  for (std::size_t index = 0U; index < parameterAutomationCount_; ++index) {
    if (parameterAutomation_[index].nodeId != nodeId) {
      parameterAutomation_[retained++] = parameterAutomation_[index];
    }
  }
  parameterAutomationCount_ = retained;
}

void SceneGraph::scheduleInstrumentEvents(
    const std::string& nodeId, std::span<const InstrumentEvent> events,
    bool replace) {
  const auto resolvedNode = resolveRealtimeNodeId(nodeId);
  auto* instrument = instrumentForRealtimeId(resolvedNode);
  if (instrument == nullptr) {
    throw std::runtime_error(resolvedNode == kInvalidRealtimeNodeId
                                 ? "Node not found"
                                 : "Node is not an instrument");
  }
  if (!instrument->scheduleEvents(events, replace)) {
    throw std::runtime_error(
        "Instrument event queue is full or contains an invalid event");
  }
}

bool SceneGraph::scheduleInstrumentEvent(
    RealtimeNodeId nodeId, const InstrumentEvent& event) noexcept {
  auto* instrument = instrumentForRealtimeId(nodeId);
  return instrument != nullptr && instrument->scheduleEvent(event);
}

void SceneGraph::setInstrumentParameter(const std::string& nodeId,
                                        std::uint16_t parameter,
                                        float value) {
  const auto resolvedNode = resolveRealtimeNodeId(nodeId);
  if (resolvedNode == kInvalidRealtimeNodeId) {
    throw std::runtime_error("Node not found");
  }
  if (!setInstrumentParameter(resolvedNode, parameter, value)) {
    throw std::runtime_error("Instrument parameter is invalid");
  }
}

bool SceneGraph::setInstrumentParameter(RealtimeNodeId nodeId,
                                        std::uint16_t parameter,
                                        float value) noexcept {
  auto* instrument = instrumentForRealtimeId(nodeId);
  return instrument != nullptr &&
         instrument->setImmediateParameter(parameter, value);
}

void SceneGraph::allNotesOff(const std::string& nodeId) {
  const auto resolvedNode = resolveRealtimeNodeId(nodeId);
  if (resolvedNode == kInvalidRealtimeNodeId) {
    throw std::runtime_error("Node not found");
  }
  if (!allNotesOff(resolvedNode)) {
    throw std::runtime_error("Node is not an instrument");
  }
}

bool SceneGraph::allNotesOff(RealtimeNodeId nodeId) noexcept {
  auto* instrument = instrumentForRealtimeId(nodeId);
  if (instrument == nullptr) {
    return false;
  }
  instrument->allNotesOff();
  return true;
}

void SceneGraph::allNotesOff() noexcept {
  for (std::size_t index = 1U; index < realtimeInstruments_.size(); ++index) {
    if (auto* instrument = realtimeInstruments_[index];
        instrument != nullptr) {
      instrument->allNotesOff();
    }
  }
}

void SceneGraph::panicInstruments() noexcept {
  for (std::size_t index = 1U; index < realtimeInstruments_.size(); ++index) {
    if (auto* instrument = realtimeInstruments_[index];
        instrument != nullptr) {
      instrument->panic();
    }
  }
}

std::size_t SceneGraph::activeInstrumentVoiceCount() const noexcept {
  std::size_t total = 0U;
  for (std::size_t index = 1U; index < realtimeInstruments_.size(); ++index) {
    if (const auto* instrument = realtimeInstruments_[index];
        instrument != nullptr) {
      total += instrument->activeVoiceCount();
    }
  }
  return total;
}

std::size_t SceneGraph::pendingInstrumentEventCount() const noexcept {
  std::size_t total = 0U;
  for (std::size_t index = 1U; index < realtimeInstruments_.size(); ++index) {
    if (const auto* instrument = realtimeInstruments_[index];
        instrument != nullptr) {
      total += instrument->pendingEventCount();
    }
  }
  return total;
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
    if (nodes_.count(connection.source) == 0U) {
      continue;
    }
    if (connection.destination == kOutputBusId) {
      sourcesFeedingOutput.insert(connection.source);
      continue;
    }
    if (nodes_.count(connection.destination) == 0U) {
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

  std::size_t index = 0U;
  while (index < queue.size()) {
    const auto current = queue[index++];
    renderOrder_.push_back(current);

    if (const auto adjacencyIt = adjacency.find(current);
        adjacencyIt != adjacency.end()) {
      for (const auto& destination : adjacencyIt->second) {
        auto degreeIt = indegree.find(destination);
        if (degreeIt != indegree.end() && degreeIt->second > 0U) {
          --degreeIt->second;
          if (degreeIt->second == 0U) {
            queue.push_back(destination);
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
    outputSources_.assign(sourcesFeedingOutput.begin(),
                          sourcesFeedingOutput.end());
    std::sort(outputSources_.begin(), outputSources_.end());
  } else {
    outputSources_.clear();
    for (const auto& [id, _] : nodes_) {
      if (adjacency.count(id) == 0U) {
        outputSources_.push_back(id);
      }
    }
    std::sort(outputSources_.begin(), outputSources_.end());
  }
}

void SceneGraph::ensureNodeBuffers(std::size_t channelCount,
                                   std::size_t frameCount) noexcept {
  for (const auto& [id, _] : nodes_) {
    if (auto buffer = nodeBuffers_.find(id); buffer != nodeBuffers_.end()) {
      buffer->second.configure(channelCount, frameCount);
    }
  }
  clock_.setFramesPerBuffer(static_cast<std::uint32_t>(frameCount));
}

}  // namespace daft::audio
