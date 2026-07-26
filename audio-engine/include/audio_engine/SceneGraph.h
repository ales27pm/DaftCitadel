#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "audio_engine/AudioBuffer.h"
#include "audio_engine/DSPNode.h"
#include "audio_engine/Scheduler.h"
#include "audio_engine/Clock.h"

/**
   * Construct a scene graph configured for audio processing.
   * @param sampleRate The audio sample rate in Hz used for processing.
   * @param framesPerBuffer The expected number of frames per render buffer.
   */
  
  /**
   * Add a DSP node to the scene graph under the given identifier.
   * @param id Identifier for the node; must be unique within the graph.
   * @param node Ownership of the node to insert into the graph.
   * @returns `true` if the node was added successfully, `false` if an entry with the same id already exists.
   */
  
  /**
   * Remove the node associated with the given identifier from the scene graph.
   * @param id Identifier of the node to remove; no action is taken if the id is not present.
   */
  
  /**
   * Create a directed connection from a source node to a destination node.
   * @param source Identifier of the source node.
   * @param destination Identifier of the destination node.
   * @returns `true` if the connection was established, `false` if the connection could not be created (e.g., nodes missing or connection invalid).
   */
  
  /**
   * Remove the directed connection between the specified source and destination nodes.
   * @param source Identifier of the source node.
   * @param destination Identifier of the destination node.
   */
  
  /**
   * Render audio by processing the graph topology and write the mixed output into the provided buffer.
   * @param outputBuffer View into the destination buffer that will receive the rendered audio.
   */
  
  /**
   * Schedule a one-time automation callback to be invoked for a node at a specific render frame.
   * @param nodeId Identifier of the node to automate.
   * @param cb Callback invoked with the target node to perform parameter updates.
   * @param frame Absolute render frame at which the callback should execute.
   */
  
  /**
   * Return the configured audio sample rate for this scene graph.
   * @returns The sample rate in Hz.
   */
  
  /**
   * Identifier used for the graph's output bus.
   */
  
  /**
   * Return the maximum number of supported audio channels.
   * @returns The compile-time upper limit on supported channels.
   */
  
  /**
   * Return the maximum supported frames per buffer.
   * @returns The compile-time upper limit on frames per buffer.
   */
  namespace daft::audio {

class SceneGraph {
 public:
  explicit SceneGraph(double sampleRate, std::uint32_t framesPerBuffer);

  bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  void removeNode(const std::string& id);
  bool connect(const std::string& source, const std::string& destination);
  void disconnect(const std::string& source, const std::string& destination);

  void render(AudioBufferView outputBuffer);
  void scheduleAutomation(const std::string& nodeId, std::function<void(DSPNode&)> cb,
                          std::uint64_t frame);

  [[nodiscard]] double sampleRate() const { return sampleRate_; }

  static constexpr std::string_view kOutputBusId = "__output__";

  static constexpr std::size_t maxSupportedChannels() { return kMaxChannels; }
  static constexpr std::size_t maxSupportedFramesPerBuffer() { return kMaxFrames; }

 private:
  static constexpr std::size_t kMaxChannels = 4;
  static constexpr std::size_t kMaxFrames = 1024;

  struct Connection {
    std::string source;
    std::string destination;
  };

  struct NodeBuffer {
    StackAudioBuffer<kMaxChannels, kMaxFrames> storage{};
    std::array<float*, kMaxChannels> channelPointers{};

    void configure(std::size_t channelCount, std::size_t frameCount) {
      storage.setFrameCount(frameCount);
      for (std::size_t ch = 0; ch < kMaxChannels; ++ch) {
        channelPointers[ch] = ch < channelCount ? storage.channel(ch) : nullptr;
      }
    }

    [[nodiscard]] AudioBufferView view(std::size_t channelCount) {
      return AudioBufferView(channelPointers.data(), channelCount, storage.frameCount());
    }
  };

  double sampleRate_;
  std::unordered_map<std::string, std::unique_ptr<DSPNode>> nodes_;
  std::vector<Connection> connections_;
  RenderClock clock_;
  RealTimeScheduler<128> scheduler_;
  std::unordered_map<std::string, NodeBuffer> nodeBuffers_;
  std::vector<std::string> renderOrder_;
  std::unordered_map<std::string, std::vector<std::string>> inboundEdges_;
  std::vector<std::string> outputSources_;

  void rebuildTopology();
  void ensureNodeBuffers(std::size_t channelCount, std::size_t frameCount);
}; 

}  // namespace daft::audio