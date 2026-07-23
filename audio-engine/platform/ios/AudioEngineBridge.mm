#import "AudioEngineBridge.hpp"

#import <os/log.h>

#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace daft::audio::bridge {

namespace {
os_log_t Logger() {
  static os_log_t log = os_log_create("com.daft.audio", "engine");
  return log;
}
}  // namespace

std::unique_ptr<SceneGraph> AudioEngineBridge::graph_;
std::mutex AudioEngineBridge::mutex_;
std::atomic<std::uint64_t> AudioEngineBridge::xruns_{0};
std::atomic<double> AudioEngineBridge::lastRenderDurationMicros_{0.0};
bool AudioEngineBridge::isPlaying_{false};
std::atomic<AudioEngineBridge::EngineGeneration> AudioEngineBridge::generation_{0};
std::unordered_map<std::string, AudioEngineBridge::ClipBufferEntry> AudioEngineBridge::clipBuffers_;

AudioEngineBridge::EngineGeneration AudioEngineBridge::initialize(double sampleRate,
                                                                  std::uint32_t framesPerBuffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_ = std::make_unique<SceneGraph>(sampleRate, framesPerBuffer);
  auto generation = generation_.load(std::memory_order_relaxed) + 1;
  if (generation == 0) {
    generation = 1;
  }
  generation_.store(generation, std::memory_order_release);
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  isPlaying_ = false;
  clipBuffers_.clear();
  os_log(Logger(), "Audio engine initialized at %.2f Hz (generation %llu)", sampleRate,
         static_cast<unsigned long long>(generation));
  return generation;
}

bool AudioEngineBridge::shutdownIfOwner(EngineGeneration generation) noexcept {
  try {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto activeGeneration = generation_.load(std::memory_order_acquire);
    if (generation == 0 || generation != activeGeneration) {
      os_log_info(Logger(), "Ignored stale audio engine shutdown for generation %llu; active generation is %llu",
                  static_cast<unsigned long long>(generation),
                  static_cast<unsigned long long>(activeGeneration));
      return false;
    }
    graph_.reset();
    xruns_.store(0);
    lastRenderDurationMicros_.store(0.0);
    isPlaying_ = false;
    clipBuffers_.clear();
    os_log(Logger(), "Audio engine generation %llu shutdown",
           static_cast<unsigned long long>(generation));
    return true;
  } catch (...) {
    os_log_error(Logger(), "Audio engine shutdown failed for generation %llu",
                 static_cast<unsigned long long>(generation));
    return false;
  }
}

bool AudioEngineBridge::isInitialized(EngineGeneration generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ownsGenerationLocked(generation);
}

bool AudioEngineBridge::ownsGenerationLocked(EngineGeneration generation) noexcept {
  return generation != 0 &&
         generation == generation_.load(std::memory_order_acquire) && graph_ != nullptr;
}

void AudioEngineBridge::requireGenerationLocked(EngineGeneration generation) {
  if (!ownsGenerationLocked(generation)) {
    throw std::runtime_error("Audio engine generation is not active");
  }
}

void AudioEngineBridge::render(EngineGeneration generation, float** outputs,
                               std::size_t channelCount, std::size_t frameCount) {
  // The embedding app owns AVAudioEngine/Audio Unit device setup and must call
  // this function from its render callback. This bridge owns graph/transport state.
  AudioBufferView view(outputs, channelCount, frameCount);
  std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) {
    view.fill(0.0F);
    if (generation != 0 &&
        generation == generation_.load(std::memory_order_acquire)) {
      xruns_.fetch_add(1);
      lastRenderDurationMicros_.store(0.0);
    }
    return;
  }
  if (!ownsGenerationLocked(generation)) {
    view.fill(0.0F);
    return;
  }
  if (!isPlaying_) {
    view.fill(0.0F);
    lastRenderDurationMicros_.store(0.0);
    return;
  }
  const auto start = std::chrono::steady_clock::now();
  try {
    graph_->render(view);
  } catch (const std::exception& ex) {
    view.fill(0.0F);
    xruns_.fetch_add(1);
    lastRenderDurationMicros_.store(0.0);
    os_log_error(Logger(), "Render failed: %{public}s", ex.what());
    return;
  } catch (...) {
    view.fill(0.0F);
    xruns_.fetch_add(1);
    lastRenderDurationMicros_.store(0.0);
    os_log_error(Logger(), "Render failed with unknown error");
    return;
  }
  const auto end = std::chrono::steady_clock::now();
  const auto micros = std::chrono::duration<double, std::micro>(end - start).count();
  lastRenderDurationMicros_.store(micros);
}

void AudioEngineBridge::startTransport(EngineGeneration generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  isPlaying_ = true;
}

void AudioEngineBridge::stopTransport(EngineGeneration generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->panicInstruments();
  isPlaying_ = false;
}

void AudioEngineBridge::locateTransport(EngineGeneration generation, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->locate(frame);
}

void AudioEngineBridge::setTransportLoop(EngineGeneration generation,
                                         std::uint64_t startFrame,
                                         std::uint64_t endFrame,
                                         bool enabled) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->setTransportLoop(startFrame, endFrame, enabled);
}

AudioEngineBridge::TransportState AudioEngineBridge::getTransportState(
    EngineGeneration generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  return {graph_->currentFrame(), isPlaying_};
}

bool AudioEngineBridge::addNode(EngineGeneration generation, const std::string& id,
                                std::unique_ptr<DSPNode> node) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  return graph_->addNode(id, std::move(node));
}

void AudioEngineBridge::removeNode(EngineGeneration generation, const std::string& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->removeNode(id);
}

bool AudioEngineBridge::connect(EngineGeneration generation, const std::string& source,
                                const std::string& destination) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  return graph_->connect(source, destination);
}

void AudioEngineBridge::disconnect(EngineGeneration generation, const std::string& source,
                                   const std::string& destination) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->disconnect(source, destination);
}

void AudioEngineBridge::scheduleParameterAutomation(EngineGeneration generation,
                                                    const std::string& nodeId,
                                                    const std::string& parameter,
                                                    std::uint64_t frame, double value) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->scheduleAutomation(nodeId,
                             [parameter, value](DSPNode& node) { node.setParameter(parameter, value); }, frame);
}

void AudioEngineBridge::scheduleInstrumentEventFromNow(
    EngineGeneration generation, const std::string& nodeId, InstrumentEvent event,
    std::uint64_t frameOffset) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  const auto currentFrame = graph_->currentFrame();
  if (frameOffset > std::numeric_limits<std::uint64_t>::max() - currentFrame) {
    throw std::out_of_range("Instrument event frame overflow");
  }
  if (event.type == InstrumentEventType::kParameter && frameOffset == 0U) {
    graph_->setInstrumentParameter(nodeId, event.parameter, event.value);
    return;
  }
  event.frame = currentFrame + frameOffset;
  event.retainAcrossPanic = false;
  graph_->scheduleInstrumentEvents(nodeId, std::span<const InstrumentEvent>(&event, 1U));
}

void AudioEngineBridge::scheduleInstrumentEvents(
    EngineGeneration generation, const std::string& nodeId,
    std::span<const InstrumentEvent> events, bool replace) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->scheduleInstrumentEvents(nodeId, events, replace);
}

void AudioEngineBridge::allNotesOff(EngineGeneration generation,
                                    const std::string& nodeId) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  graph_->allNotesOff(nodeId);
}

bool AudioEngineBridge::registerClipBuffer(EngineGeneration generation, const std::string& key,
                                           double sampleRate, std::size_t channelCount,
                                           std::size_t frameCount,
                                           std::vector<std::vector<float>> channelData) {
  if (key.empty() || !std::isfinite(sampleRate) || sampleRate <= 0.0 || channelCount == 0 || frameCount == 0) {
    return false;
  }
  if (channelData.size() != channelCount) {
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
  const std::size_t byteSize = channelCount * frameCount * sizeof(float);

  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  auto [entryIt, inserted] = clipBuffers_.try_emplace(key);
  auto& entry = entryIt->second;
  entry.buffer = std::move(buffer);
  entry.byteSize = byteSize;
  if (inserted || entry.referenceCount == 0) {
    entry.referenceCount = 1;
  }
  return true;
}

bool AudioEngineBridge::unregisterClipBuffer(EngineGeneration generation,
                                             const std::string& key) {
  if (key.empty()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  auto it = clipBuffers_.find(key);
  if (it == clipBuffers_.end()) {
    return true;
  }
  auto& entry = it->second;
  if (entry.referenceCount > 0) {
    entry.referenceCount -= 1;
  }
  if (entry.referenceCount == 0) {
    clipBuffers_.erase(it);
  }
  return true;
}

std::shared_ptr<const AudioEngineBridge::ClipBuffer> AudioEngineBridge::clipBufferForKey(
    EngineGeneration generation, const std::string& key) {
  std::lock_guard<std::mutex> lock(mutex_);
  requireGenerationLocked(generation);
  if (const auto it = clipBuffers_.find(key); it != clipBuffers_.end()) {
    return it->second.buffer;
  }
  return nullptr;
}

AudioEngineBridge::RenderDiagnostics AudioEngineBridge::getDiagnostics(
    EngineGeneration generation) {
  RenderDiagnostics diagnostics{0, 0.0, 0, false};
  std::lock_guard<std::mutex> lock(mutex_);
  if (!ownsGenerationLocked(generation)) {
    return diagnostics;
  }
  diagnostics.xruns = xruns_.load();
  diagnostics.lastRenderDurationMicros = lastRenderDurationMicros_.load();
  diagnostics.initialized = true;
  for (const auto& [_, entry] : clipBuffers_) {
    diagnostics.clipBufferBytes += entry.byteSize;
  }
  return diagnostics;
}

}  // namespace daft::audio::bridge
