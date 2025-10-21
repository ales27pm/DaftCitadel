#import "AudioEngineBridge.hpp"

#import <os/log.h>

namespace daft::audio::bridge {

namespace {
os_log_t Logger() {
  static os_log_t log = os_log_create("com.daft.audio", "engine");
  return log;
}
}  // namespace

std::unique_ptr<SceneGraph> AudioEngineBridge::graph_;

void AudioEngineBridge::initialize(double sampleRate, std::uint32_t) {
  graph_ = std::make_unique<SceneGraph>(sampleRate);
  os_log(Logger(), "Audio engine initialized at %.2f Hz", sampleRate);
}

void AudioEngineBridge::shutdown() {
  graph_.reset();
  os_log(Logger(), "Audio engine shutdown");
}

void AudioEngineBridge::render(float** outputs, std::size_t channelCount, std::size_t frameCount) {
  if (!graph_) {
    return;
  }
  AudioBufferView view(outputs, channelCount, frameCount);
  graph_->render(view);
}

bool AudioEngineBridge::addNode(const std::string& id, std::unique_ptr<DSPNode> node) {
  if (!graph_) {
    return false;
  }
  return graph_->addNode(id, std::move(node));
}

void AudioEngineBridge::removeNode(const std::string& id) {
  if (graph_) {
    graph_->removeNode(id);
  }
}

bool AudioEngineBridge::connect(const std::string& source, const std::string& destination) {
  if (!graph_) {
    return false;
  }
  return graph_->connect(source, destination);
}

void AudioEngineBridge::disconnect(const std::string& source, const std::string& destination) {
  if (graph_) {
    graph_->disconnect(source, destination);
  }
}

void AudioEngineBridge::scheduleGainRamp(const std::string& nodeId, std::uint64_t frame, double gain) {
  if (!graph_) {
    return;
  }
  graph_->scheduleAutomation(nodeId, [gain](DSPNode& node) { node.setParameter("gain", gain); }, frame);
}

}  // namespace daft::audio::bridge
