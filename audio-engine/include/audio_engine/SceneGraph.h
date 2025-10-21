#pragma once

#include <array>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/DSPNode.h"
#include "audio_engine/Scheduler.h"

namespace daft::audio {

class SceneGraph {
 public:
  explicit SceneGraph(double sampleRate);

  bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  void removeNode(const std::string& id);
  bool connect(const std::string& source, const std::string& destination);
  void disconnect(const std::string& source, const std::string& destination);

  void render(AudioBufferView outputBuffer);
  void scheduleAutomation(const std::string& nodeId, std::function<void(DSPNode&)> cb,
                          std::uint64_t frame);

  [[nodiscard]] double sampleRate() const { return sampleRate_; }

 private:
  struct Connection {
    std::string source;
    std::string destination;
  };

  double sampleRate_;
  std::unordered_map<std::string, std::unique_ptr<DSPNode>> nodes_;
  std::vector<Connection> connections_;
  RenderClock clock_;
  RealTimeScheduler<128> scheduler_;
};

}  // namespace daft::audio
