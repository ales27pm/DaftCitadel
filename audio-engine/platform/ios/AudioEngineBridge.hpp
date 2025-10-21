#pragma once

#include <cstddef>
#include <memory>
#include <mutex>
#include <string>

#include "audio_engine/SceneGraph.h"

namespace daft::audio::bridge {

class AudioEngineBridge {
 public:
  static void initialize(double sampleRate, std::uint32_t framesPerBuffer);
  static void shutdown();
  static void render(float** outputs, std::size_t channelCount, std::size_t frameCount);

  static bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  static void removeNode(const std::string& id);
  static bool connect(const std::string& source, const std::string& destination);
  static void disconnect(const std::string& source, const std::string& destination);
  static void scheduleGainRamp(const std::string& nodeId, std::uint64_t frame, double gain);

 private:
  static std::unique_ptr<SceneGraph> graph_;
  static std::mutex mutex_;
};

}  // namespace daft::audio::bridge
