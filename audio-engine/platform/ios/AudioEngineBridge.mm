#import "AudioEngineBridge.hpp"

#import <os/log.h>

#include <chrono>
#include <cmath>
#include <exception>
#include <memory>

#include "audio_engine/DSPNode.h"

namespace daft::audio::bridge {

namespace {
os_log_t Logger() {
  static os_log_t log = os_log_create("com.daft.audio", "engine");
  return log;
}
}  // namespace

std::atomic<std::shared_ptr<SceneGraph>> AudioEngineBridge::graph_{nullptr};
std::mutex AudioEngineBridge::mutex_;
std::atomic<std::uint64_t> AudioEngineBridge::xruns_{0};
std::atomic<double> AudioEngineBridge::lastRenderDurationMicros_{0.0};
std::unordered_map<std::string, AudioEngineBridge::ClipBufferEntry> AudioEngineBridge::clipBuffers_;
AudioEngineBridge::ParameterAutomationQueue AudioEngineBridge::commandQueue_;

void AudioEngineBridge::initialize(double sampleRate, std::uint32_t framesPerBuffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_.store(std::make_shared<SceneGraph>(sampleRate, framesPerBuffer), std::memory_order_release);
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  clipBuffers_.clear();
  commandQueue_.reset();
  os_log(Logger(), "Audio engine initialized at %.2f Hz", sampleRate);
}

void AudioEngineBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_.store(nullptr, std::memory_order_release);
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  clipBuffers_.clear();
  commandQueue_.reset();
  os_log(Logger(), "Audio engine shutdown");
}

void AudioEngineBridge::render(float** outputs, std::size_t channelCount, std::size_t frameCount) {
  AudioBufferView view(outputs, channelCount, frameCount);
  const auto graph = graph_.load(std::memory_order_acquire);
  if (!graph) {
    view.fill(0.0F);
    xruns_.fetch_add(1);
    lastRenderDurationMicros_.store(0.0);
    return;
  }

  applyParameterAutomation(graph);

  const auto start = std::chrono::steady_clock::now();
  try {
    graph->render(view);
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

bool AudioEngineBridge::addNode(const std::string& id, std::unique_ptr<DSPNode> node) {
  const auto graph = graph_.load(std::memory_order_acquire);
  if (!graph) {
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  return graph->addNode(id, std::move(node));
}

void AudioEngineBridge::removeNode(const std::string& id) {
  const auto graph = graph_.load(std::memory_order_acquire);
  if (!graph) {
    return;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  graph->removeNode(id);
}

bool AudioEngineBridge::connect(const std::string& source, const std::string& destination) {
  const auto graph = graph_.load(std::memory_order_acquire);
  if (!graph) {
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  return graph->connect(source, destination);
}

void AudioEngineBridge::disconnect(const std::string& source, const std::string& destination) {
  const auto graph = graph_.load(std::memory_order_acquire);
  if (!graph) {
    return;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  graph->disconnect(source, destination);
}

void AudioEngineBridge::scheduleParameterAutomation(const std::string& nodeId, const std::string& parameter,
                                                  std::uint64_t frame, double value) {
  const bool queued = commandQueue_.push({nodeId, parameter, frame, value});
  if (!queued) {
    os_log_error(Logger(), "Failed to queue automation: command queue full");
  }
}

bool AudioEngineBridge::registerClipBuffer(const std::string& key, double sampleRate, std::size_t channelCount,
                                           std::size_t frameCount, std::vector<std::vector<float>> channelData) {
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
  auto& entry = clipBuffers_[key];
  entry.buffer = std::move(buffer);
  entry.byteSize = byteSize;
  entry.referenceCount += 1;
  return true;
}

bool AudioEngineBridge::unregisterClipBuffer(const std::string& key) {
  if (key.empty()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
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

std::shared_ptr<const AudioEngineBridge::ClipBuffer> AudioEngineBridge::clipBufferForKey(const std::string& key) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (const auto it = clipBuffers_.find(key); it != clipBuffers_.end()) {
    return it->second.buffer;
  }
  return nullptr;
}

AudioEngineBridge::RenderDiagnostics AudioEngineBridge::getDiagnostics() {
  RenderDiagnostics diagnostics{xruns_.load(), lastRenderDurationMicros_.load(), 0};
  std::lock_guard<std::mutex> lock(mutex_);
  for (const auto& [_, entry] : clipBuffers_) {
    diagnostics.clipBufferBytes += entry.byteSize;
  }
  return diagnostics;
}

void AudioEngineBridge::applyParameterAutomation(const std::shared_ptr<SceneGraph>& graph) {
  ParameterAutomationCommand command{};
  while (commandQueue_.pop(command)) {
    const bool scheduled = graph->scheduleAutomation(
      command.nodeId,
      [parameter = std::move(command.parameter), value = command.value](DSPNode& node) {
        node.setParameter(parameter, value);
      },
      command.frame);
    if (!scheduled) {
      os_log_error(Logger(), "Failed to apply automation: node missing or scheduler full");
    }
  }
}

}  // namespace daft::audio::bridge
