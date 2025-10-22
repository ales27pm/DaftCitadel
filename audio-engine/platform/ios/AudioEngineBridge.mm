#import "AudioEngineBridge.hpp"

#import <os/log.h>

#include <chrono>
#include <cmath>
#include <exception>
#include <mutex>
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
std::unordered_map<std::string, AudioEngineBridge::ClipBufferEntry> AudioEngineBridge::clipBuffers_;

void AudioEngineBridge::initialize(double sampleRate, std::uint32_t framesPerBuffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_ = std::make_unique<SceneGraph>(sampleRate, framesPerBuffer);
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  os_log(Logger(), "Audio engine initialized at %.2f Hz", sampleRate);
}

void AudioEngineBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_.reset();
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  clipBuffers_.clear();
  os_log(Logger(), "Audio engine shutdown");
}

void AudioEngineBridge::render(float** outputs, std::size_t channelCount, std::size_t frameCount) {
  AudioBufferView view(outputs, channelCount, frameCount);
  std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) {
    view.fill(0.0F);
    xruns_.fetch_add(1);
    lastRenderDurationMicros_.store(0.0);
    return;
  }
  if (!graph_) {
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

bool AudioEngineBridge::addNode(const std::string& id, std::unique_ptr<DSPNode> node) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!graph_) {
    return false;
  }
  return graph_->addNode(id, std::move(node));
}

void AudioEngineBridge::removeNode(const std::string& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (graph_) {
    graph_->removeNode(id);
  }
}

bool AudioEngineBridge::connect(const std::string& source, const std::string& destination) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!graph_) {
    return false;
  }
  return graph_->connect(source, destination);
}

void AudioEngineBridge::disconnect(const std::string& source, const std::string& destination) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (graph_) {
    graph_->disconnect(source, destination);
  }
}

void AudioEngineBridge::scheduleParameterAutomation(const std::string& nodeId, const std::string& parameter,
                                                    std::uint64_t frame, double value) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!graph_) {
    return;
  }
  try {
    graph_->scheduleAutomation(nodeId,
                               [parameter, value](DSPNode& node) { node.setParameter(parameter, value); }, frame);
  } catch (const std::exception& ex) {
    os_log_error(Logger(), "Failed to schedule automation: %{public}s", ex.what());
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

}  // namespace daft::audio::bridge
