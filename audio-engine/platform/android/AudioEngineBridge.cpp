#include "AudioEngineBridge.h"

#include <android/log.h>

#include "audio_engine/DSPNode.h"

namespace daft::audio::bridge {

namespace {
constexpr const char* kTag = "DaftAudioEngine";
}

std::unique_ptr<SceneGraph> AudioEngineBridge::graph_;
std::mutex AudioEngineBridge::mutex_;

void AudioEngineBridge::initialize(JNIEnv*, double sampleRate, std::uint32_t) {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_ = std::make_unique<SceneGraph>(sampleRate);
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine initialized at %.2f Hz", sampleRate);
}

void AudioEngineBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_.reset();
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine shutdown");
}

void AudioEngineBridge::render(float** outputs, std::size_t channelCount, std::size_t frameCount) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!graph_) {
    return;
  }
  AudioBufferView view(outputs, channelCount, frameCount);
  graph_->render(view);
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

void AudioEngineBridge::scheduleGainRamp(const std::string& nodeId, std::uint64_t frame, double gain) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!graph_) {
    return;
  }
  graph_->scheduleAutomation(nodeId, [gain](DSPNode& node) { node.setParameter("gain", gain); }, frame);
}

}  // namespace daft::audio::bridge
