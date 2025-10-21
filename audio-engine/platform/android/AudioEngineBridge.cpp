#include "AudioEngineBridge.h"

#include <android/log.h>
#include <chrono>
#include <exception>

#include "audio_engine/DSPNode.h"

namespace daft::audio::bridge {

namespace {
constexpr const char* kTag = "DaftAudioEngine";
}

std::unique_ptr<SceneGraph> AudioEngineBridge::graph_;
std::mutex AudioEngineBridge::mutex_;
std::atomic<std::uint64_t> AudioEngineBridge::xruns_{0};
std::atomic<double> AudioEngineBridge::lastRenderDurationMicros_{0.0};

void AudioEngineBridge::initialize(JNIEnv*, double sampleRate, std::uint32_t framesPerBuffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_ = std::make_unique<SceneGraph>(sampleRate, framesPerBuffer);
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine initialized at %.2f Hz", sampleRate);
}

void AudioEngineBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_.reset();
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine shutdown");
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
    __android_log_print(ANDROID_LOG_ERROR, kTag, "Render failed: %s", ex.what());
    return;
  } catch (...) {
    view.fill(0.0F);
    xruns_.fetch_add(1);
    lastRenderDurationMicros_.store(0.0);
    __android_log_print(ANDROID_LOG_ERROR, kTag, "Render failed with unknown error");
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
    __android_log_print(ANDROID_LOG_ERROR, kTag, "Failed to schedule automation: %s", ex.what());
  }
}

AudioEngineBridge::RenderDiagnostics AudioEngineBridge::getDiagnostics() {
  return RenderDiagnostics{xruns_.load(), lastRenderDurationMicros_.load()};
}

}  // namespace daft::audio::bridge
