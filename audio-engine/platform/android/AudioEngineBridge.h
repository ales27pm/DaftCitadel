#pragma once

#include <jni.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include "audio_engine/SceneGraph.h"

/**
 * Holds runtime diagnostics from the audio render thread.
 *
 * Contains counters and timing information useful for monitoring audio performance.
 */

/**
 * Initializes the audio engine bridge with the provided JNI environment, sample rate, and buffer size.
 *
 * @param env JNI environment pointer used for any required Java interop.
 * @param sampleRate Sample rate, in Hz, that the audio engine will use.
 * @param framesPerBuffer Number of frames per audio buffer used by the engine.
 */

/**
 * Shuts down the audio engine bridge and releases any associated resources.
 */

/**
 * Renders audio into the provided output buffers for the given channel and frame counts.
 *
 * The outputs parameter points to an array of channel buffers; each buffer must be able to hold frameCount samples.
 *
 * @param outputs Pointer to an array of channel buffers to receive rendered audio.
 * @param channelCount Number of channels (length of the outputs array).
 * @param frameCount Number of frames to render into each channel buffer.
 */

/**
 * Adds a DSP node to the engine's internal graph under the given identifier.
 *
 * @param id Unique identifier for the node within the graph.
 * @param node Ownership of the node to add.
 * @returns `true` if the node was added successfully, `false` otherwise.
 */

/**
 * Removes the DSP node identified by the given identifier from the engine's graph.
 *
 * @param id Identifier of the node to remove.
 */

/**
 * Connects the output of the source node to the input of the destination node within the graph.
 *
 * @param source Identifier of the source node.
 * @param destination Identifier of the destination node.
 * @returns `true` if the connection was established successfully, `false` otherwise.
 */

/**
 * Disconnects the connection between the specified source and destination nodes.
 *
 * @param source Identifier of the source node.
 * @param destination Identifier of the destination node.
 */

/**
 * Schedules an automation event for a parameter of a node at a specific frame with the given value.
 *
 * @param nodeId Identifier of the node whose parameter will be automated.
 * @param parameter Name of the parameter to automate.
 * @param frame Frame index at which the automation value should take effect.
 * @param value Value to apply to the parameter at the scheduled frame.
 */

/**
 * Retrieves current render diagnostics including the XRUN count and the duration of the last render.
 *
 * @returns A RenderDiagnostics struct containing `xruns` (total XRUN events) and `lastRenderDurationMicros` (last render duration in microseconds).
 */
namespace daft::audio::bridge {

class AudioEngineBridge {
 public:
  struct RenderDiagnostics {
    std::uint64_t xruns;
    double lastRenderDurationMicros;
  };

  struct ClipBuffer {
    double sampleRate = 0.0;
    std::size_t frameCount = 0;
    std::vector<std::vector<float>> channelSamples;

    [[nodiscard]] std::size_t channelCount() const { return channelSamples.size(); }
    [[nodiscard]] std::span<const float> channel(std::size_t index) const {
      if (index >= channelSamples.size()) {
        return {};
      }
      return std::span<const float>(channelSamples[index].data(), channelSamples[index].size());
    }
  };

  static void initialize(JNIEnv* env, double sampleRate, std::uint32_t framesPerBuffer);
  static void shutdown();
  static void render(float** outputs, std::size_t channelCount, std::size_t frameCount);

  static bool addNode(const std::string& id, std::unique_ptr<DSPNode> node);
  static void removeNode(const std::string& id);
  static bool connect(const std::string& source, const std::string& destination);
  static void disconnect(const std::string& source, const std::string& destination);
  static void scheduleParameterAutomation(const std::string& nodeId, const std::string& parameter,
                                          std::uint64_t frame, double value);
  static bool registerClipBuffer(const std::string& key, double sampleRate, std::size_t channelCount,
                                 std::size_t frameCount, std::vector<std::vector<float>> channelData);
  static std::shared_ptr<const ClipBuffer> clipBufferForKey(const std::string& key);
  static RenderDiagnostics getDiagnostics();

 private:
  static std::unique_ptr<SceneGraph> graph_;
  static std::mutex mutex_;
  static std::atomic<std::uint64_t> xruns_;
  static std::atomic<double> lastRenderDurationMicros_;
  static std::unordered_map<std::string, std::shared_ptr<ClipBuffer>> clipBuffers_;
};

}  // namespace daft::audio::bridge