#include "AudioEngineBridge.h"

#include <android/log.h>

#include <array>
#include <cmath>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace daft::audio::bridge {

namespace {
constexpr const char* kTag = "DaftAudioEngine";
}

std::unique_ptr<SceneGraph> AudioEngineBridge::graph_;
std::mutex AudioEngineBridge::mutex_;
RealtimeControlPlane AudioEngineBridge::realtimePlane_;
std::atomic<std::uint64_t> AudioEngineBridge::publicationToken_{0U};
std::unordered_map<std::string, AudioEngineBridge::ClipBufferEntry>
    AudioEngineBridge::clipBuffers_;

void AudioEngineBridge::initialize(JNIEnv*, double sampleRate,
                                   std::uint32_t framesPerBuffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  stopRealtimePlaneLocked();
  realtimePlane_.publishGraph(nullptr, 0U);

  auto preparedGraph =
      std::make_unique<SceneGraph>(sampleRate, framesPerBuffer);
  auto publication = publicationToken_.load(std::memory_order_relaxed) + 1U;
  if (publication == 0U) {
    publication = 1U;
  }

  graph_ = std::move(preparedGraph);
  clipBuffers_.clear();
  realtimePlane_.resetQuiescent();
  realtimePlane_.publishGraph(graph_.get(), publication);
  publicationToken_.store(publication, std::memory_order_release);
  __android_log_print(ANDROID_LOG_INFO, kTag,
                      "Audio engine initialized at %.2f Hz", sampleRate);
}

void AudioEngineBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  stopRealtimePlaneLocked();
  realtimePlane_.publishGraph(nullptr, 0U);
  graph_.reset();
  clipBuffers_.clear();
  realtimePlane_.resetQuiescent();
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine shutdown");
}

void AudioEngineBridge::requireInitializedLocked() {
  if (!graph_) {
    throw std::runtime_error("Audio engine is not initialized");
  }
}

void AudioEngineBridge::requireTransportStoppedLocked() {
  if (realtimePlane_.isPlaying()) {
    throw std::runtime_error(
        "Audio graph structure cannot change while transport is playing");
  }
}

void AudioEngineBridge::stopRealtimePlaneLocked() noexcept {
  if (realtimePlane_.isPlaying()) {
    RealtimeControlCommand panic{};
    panic.type = RealtimeCommandType::kPanicAllInstruments;
    (void)realtimePlane_.enqueue(panic);
  }
  realtimePlane_.setPlaying(false);
  realtimePlane_.waitUntilRenderIdle();
  if (graph_) {
    graph_->panicInstruments();
  }
  realtimePlane_.discardCommandsQuiescent();
}

RealtimeNodeId AudioEngineBridge::requireRealtimeNodeLocked(
    const std::string& nodeId) {
  requireInitializedLocked();
  const auto resolved = graph_->resolveRealtimeNodeId(nodeId);
  if (resolved == kInvalidRealtimeNodeId) {
    throw std::runtime_error("Node not found");
  }
  return resolved;
}

bool AudioEngineBridge::enqueueLocked(
    const RealtimeControlCommand& command) noexcept {
  return realtimePlane_.enqueue(command);
}

void AudioEngineBridge::render(float** outputs, std::size_t channelCount,
                               std::size_t frameCount) noexcept {
  AudioBufferView view(outputs, channelCount, frameCount);
  const auto publication =
      publicationToken_.load(std::memory_order_acquire);
  realtimePlane_.render(view, publication);
}

void AudioEngineBridge::startTransport() {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  const auto publication =
      publicationToken_.load(std::memory_order_acquire);
  realtimePlane_.publishGraph(graph_.get(), publication);
  realtimePlane_.setPlaying(true);
}

void AudioEngineBridge::stopTransport() {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  stopRealtimePlaneLocked();
}

void AudioEngineBridge::locateTransport(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  if (realtimePlane_.isPlaying()) {
    RealtimeControlCommand command{};
    command.type = RealtimeCommandType::kLocateTransport;
    command.frame = frame;
    if (!enqueueLocked(command)) {
      throw std::runtime_error("Realtime command queue is full");
    }
    return;
  }
  graph_->locate(frame);
}

void AudioEngineBridge::setTransportLoop(std::uint64_t startFrame,
                                         std::uint64_t endFrame,
                                         bool enabled) {
  if (enabled && startFrame >= endFrame) {
    throw std::invalid_argument(
        "Enabled transport loop requires startFrame < endFrame");
  }

  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  if (realtimePlane_.isPlaying()) {
    RealtimeControlCommand command{};
    command.type = RealtimeCommandType::kSetTransportLoop;
    command.frame = startFrame;
    command.endFrame = endFrame;
    command.enabled = enabled;
    if (!enqueueLocked(command)) {
      throw std::runtime_error("Realtime command queue is full");
    }
    return;
  }
  graph_->setTransportLoop(startFrame, endFrame, enabled);
}

AudioEngineBridge::TransportState AudioEngineBridge::getTransportState() {
  std::lock_guard<std::mutex> lock(mutex_);
  return {graph_ ? graph_->currentFrame() : 0U,
          graph_ != nullptr && realtimePlane_.isPlaying()};
}

bool AudioEngineBridge::addNode(const std::string& id,
                                std::unique_ptr<DSPNode> node) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  requireTransportStoppedLocked();
  return graph_->addNode(id, std::move(node));
}

void AudioEngineBridge::removeNode(const std::string& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  requireTransportStoppedLocked();
  graph_->removeNode(id);
}

bool AudioEngineBridge::connect(const std::string& source,
                                const std::string& destination) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  requireTransportStoppedLocked();
  return graph_->connect(source, destination);
}

void AudioEngineBridge::disconnect(const std::string& source,
                                   const std::string& destination) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  requireTransportStoppedLocked();
  graph_->disconnect(source, destination);
}

void AudioEngineBridge::scheduleParameterAutomation(
    const std::string& nodeId, const std::string& parameter,
    std::uint64_t frame, double value) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  const auto resolvedNode = requireRealtimeNodeLocked(nodeId);
  const auto resolvedParameter =
      graph_->resolveNodeParameterId(resolvedNode, parameter);
  if (!resolvedParameter) {
    throw std::runtime_error("Node parameter is invalid");
  }

  if (realtimePlane_.isPlaying()) {
    RealtimeControlCommand command{};
    command.type = RealtimeCommandType::kScheduleNodeParameter;
    command.nodeId = resolvedNode;
    command.parameterId = *resolvedParameter;
    command.frame = frame;
    command.parameterValue = value;
    if (!enqueueLocked(command)) {
      throw std::runtime_error("Realtime command queue is full");
    }
    return;
  }

  if (!graph_->scheduleParameterAutomation(resolvedNode, *resolvedParameter,
                                           frame, value)) {
    throw std::runtime_error(
        "Parameter automation queue is full or contains an invalid event");
  }
}

void AudioEngineBridge::scheduleInstrumentEventFromNow(
    const std::string& nodeId, InstrumentEvent event,
    std::uint64_t frameOffset) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  const auto resolvedNode = requireRealtimeNodeLocked(nodeId);
  event.retainAcrossPanic = false;
  if (!graph_->validateInstrumentEvent(resolvedNode, event)) {
    throw std::invalid_argument("Instrument event is invalid");
  }

  if (realtimePlane_.isPlaying()) {
    RealtimeControlCommand command{};
    command.type = RealtimeCommandType::kScheduleInstrumentEvent;
    command.nodeId = resolvedNode;
    command.frame = frameOffset;
    command.frameIsRelative = true;
    command.instrumentEvent = event;
    if (!enqueueLocked(command)) {
      throw std::runtime_error("Realtime command queue is full");
    }
    return;
  }

  const auto currentFrame = graph_->currentFrame();
  if (frameOffset >
      std::numeric_limits<std::uint64_t>::max() - currentFrame) {
    throw std::out_of_range("Instrument event frame overflow");
  }
  event.frame = currentFrame + frameOffset;
  if (!graph_->scheduleInstrumentEvent(resolvedNode, event)) {
    throw std::runtime_error(
        "Instrument event queue is full or contains an invalid event");
  }
}

void AudioEngineBridge::scheduleInstrumentEvents(
    const std::string& nodeId, std::span<const InstrumentEvent> events,
    bool replace) {
  if (events.size() > InstrumentNode::kEventCapacity) {
    throw std::out_of_range("Instrument event batch exceeds fixed capacity");
  }

  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  const auto resolvedNode = requireRealtimeNodeLocked(nodeId);
  for (const auto& event : events) {
    if (!graph_->validateInstrumentEvent(resolvedNode, event)) {
      throw std::invalid_argument("Instrument event batch is invalid");
    }
  }

  if (!realtimePlane_.isPlaying()) {
    graph_->scheduleInstrumentEvents(nodeId, events, replace);
    return;
  }

  std::array<RealtimeControlCommand,
             InstrumentNode::kEventCapacity + 1U>
      commands{};
  std::size_t commandCount = 0U;
  if (replace) {
    commands[commandCount].type =
        RealtimeCommandType::kClearInstrumentEvents;
    commands[commandCount].nodeId = resolvedNode;
    ++commandCount;
  }
  for (const auto& event : events) {
    auto& command = commands[commandCount++];
    command.type = RealtimeCommandType::kScheduleInstrumentEvent;
    command.nodeId = resolvedNode;
    command.frame = event.frame;
    command.instrumentEvent = event;
  }
  if (!realtimePlane_.enqueueBatch(
          std::span<const RealtimeControlCommand>(commands.data(),
                                                  commandCount))) {
    throw std::runtime_error("Realtime command queue is full");
  }
}

void AudioEngineBridge::allNotesOff(const std::string& nodeId) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  const auto resolvedNode = requireRealtimeNodeLocked(nodeId);
  if (realtimePlane_.isPlaying()) {
    RealtimeControlCommand command{};
    command.type = RealtimeCommandType::kAllNotesOff;
    command.nodeId = resolvedNode;
    if (!enqueueLocked(command)) {
      throw std::runtime_error("Realtime command queue is full");
    }
    return;
  }
  if (!graph_->allNotesOff(resolvedNode)) {
    throw std::runtime_error("Node is not an instrument");
  }
}

bool AudioEngineBridge::registerClipBuffer(
    const std::string& key, double sampleRate, std::size_t channelCount,
    std::size_t frameCount,
    std::vector<std::vector<float>> channelData) {
  if (key.empty() || !std::isfinite(sampleRate) || sampleRate <= 0.0 ||
      channelCount == 0U || frameCount == 0U ||
      channelData.size() != channelCount) {
    return false;
  }
  for (const auto& channel : channelData) {
    if (channel.size() != frameCount) {
      return false;
    }
  }

  auto buffer = std::make_shared<ClipBuffer>();
  buffer->sampleRate = sampleRate;
  buffer->frameCount = frameCount;
  buffer->channelSamples = std::move(channelData);
  const std::size_t byteSize =
      channelCount * frameCount * sizeof(float);

  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  auto [entryIt, inserted] = clipBuffers_.try_emplace(key);
  auto& entry = entryIt->second;
  entry.buffer = std::move(buffer);
  entry.byteSize = byteSize;
  if (inserted || entry.referenceCount == 0U) {
    entry.referenceCount = 1U;
  }
  return true;
}

bool AudioEngineBridge::unregisterClipBuffer(const std::string& key) {
  if (key.empty()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  auto it = clipBuffers_.find(key);
  if (it == clipBuffers_.end()) {
    return true;
  }
  auto& entry = it->second;
  if (entry.referenceCount > 0U) {
    --entry.referenceCount;
  }
  if (entry.referenceCount == 0U) {
    clipBuffers_.erase(it);
  }
  return true;
}

std::shared_ptr<const AudioEngineBridge::ClipBuffer>
AudioEngineBridge::clipBufferForKey(const std::string& key) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireInitializedLocked();
  if (const auto it = clipBuffers_.find(key); it != clipBuffers_.end()) {
    return it->second.buffer;
  }
  return nullptr;
}

AudioEngineBridge::RenderDiagnostics AudioEngineBridge::getDiagnostics() {
  RenderDiagnostics diagnostics{};
  std::lock_guard<std::mutex> lock(mutex_);
  if (!graph_) {
    return diagnostics;
  }

  const auto realtime = realtimePlane_.diagnostics();
  diagnostics.xruns = realtime.xruns;
  diagnostics.lastRenderDurationMicros =
      static_cast<double>(realtime.lastRenderMicros);
  diagnostics.initialized = true;
  diagnostics.activeVoices = realtime.activeVoices;
  diagnostics.pendingInstrumentEvents =
      realtime.pendingInstrumentEvents;
  diagnostics.realtimeQueueDepth = realtime.commandQueueDepth;
  diagnostics.realtimeQueueOverflows = realtime.commandQueueOverflows;
  diagnostics.realtimeCommandFailures = realtime.commandFailures;
  diagnostics.renderCount = realtime.renderStatistics.renderCount;
  diagnostics.maximumRenderDurationMicros =
      static_cast<double>(realtime.renderStatistics.maximumRenderMicros);
  diagnostics.p50RenderDurationMicros =
      static_cast<double>(realtime.renderStatistics.p50RenderMicros);
  diagnostics.p95RenderDurationMicros =
      static_cast<double>(realtime.renderStatistics.p95RenderMicros);
  diagnostics.p99RenderDurationMicros =
      static_cast<double>(realtime.renderStatistics.p99RenderMicros);
  if (realtime.renderStatistics.renderCount > 0U) {
    diagnostics.averageRenderDurationMicros =
        static_cast<double>(realtime.renderStatistics.totalRenderMicros) /
        static_cast<double>(realtime.renderStatistics.renderCount);
  }
  for (const auto& [_, entry] : clipBuffers_) {
    diagnostics.clipBufferBytes += entry.byteSize;
  }
  return diagnostics;
}

}  // namespace daft::audio::bridge
