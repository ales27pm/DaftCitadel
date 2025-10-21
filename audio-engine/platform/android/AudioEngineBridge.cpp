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

/**
 * @brief Initializes the audio engine and creates a new scene graph.
 *
 * Sets up the internal SceneGraph using the provided sample rate and frames-per-buffer, and resets render diagnostics (xruns and last render duration) to zero.
 *
 * @param sampleRate Sample rate in Hertz for the audio engine.
 * @param framesPerBuffer Number of frames per audio buffer.
 */
void AudioEngineBridge::initialize(JNIEnv*, double sampleRate, std::uint32_t framesPerBuffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_ = std::make_unique<SceneGraph>(sampleRate, framesPerBuffer);
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine initialized at %.2f Hz", sampleRate);
}

/**
 * @brief Shuts down the audio engine and clears internal state.
 *
 * Destroys the internal SceneGraph, resets the xrun counter and last render
 * duration to zero, and releases resources held by the bridge.
 */
void AudioEngineBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  graph_.reset();
  xruns_.store(0);
  lastRenderDurationMicros_.store(0.0);
  __android_log_print(ANDROID_LOG_INFO, kTag, "Audio engine shutdown");
}

/**
 * @brief Renders audio into the provided output buffers and updates render diagnostics.
 *
 * Attempts a non-blocking render of the internal audio graph into the provided channel buffers.
 * If the graph is unavailable, the render lock cannot be obtained, or an exception occurs during
 * rendering, the output buffers are filled with zeros, the xrun counter is incremented, and the
 * last render duration is reset to 0. On successful render the elapsed time in microseconds is
 * stored in the diagnostics state.
 *
 * @param outputs Array of pointers to per-channel float sample buffers (length == channelCount).
 *                Each buffer must be able to hold frameCount samples.
 * @param channelCount Number of channels (size of the outputs array).
 * @param frameCount Number of frames to render per channel.
 */
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

/**
 * @brief Adds a DSP node to the active scene graph.
 *
 * @param id Identifier for the node within the graph.
 * @param node Unique pointer to the DSP node; ownership is transferred to the graph on success.
 * @return true if the node was added to the graph, false if there is no active graph or the add failed.
 */
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

/**
 * @brief Schedules a parameter change for a node to take effect at a specific future frame.
 *
 * If the internal scene graph is not available, the call is a no-op. Exceptions derived from
 * `std::exception` thrown while scheduling are caught and logged; other exception types are not caught.
 *
 * @param nodeId Identifier of the target node.
 * @param parameter Name of the parameter to set on the node.
 * @param frame Frame index at which the parameter change should be applied.
 * @param value Value to assign to the parameter at the scheduled frame.
 */
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

/**
 * @brief Retrieve current render diagnostics.
 *
 * Provides the number of xruns (missed or overrun render calls) and the duration
 * of the last render call in microseconds.
 *
 * @return RenderDiagnostics Struct containing:
 *  - xruns: number of missed/overrun render calls.
 *  - lastRenderDurationMicros: duration of the last render call in microseconds.
 */
AudioEngineBridge::RenderDiagnostics AudioEngineBridge::getDiagnostics() {
  return RenderDiagnostics{xruns_.load(), lastRenderDurationMicros_.load()};
}

}  // namespace daft::audio::bridge