package com.daftcitadel.audio

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

@ReactModule(name = AudioEngineModule.NAME)
class AudioEngineModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), TurboModule {

  init {
    ensureLibraryLoaded()
  }

  private val maxFramesPerBuffer: Int by lazy { nativeMaxFramesPerBuffer() }

  /**
 * The module's name as exposed to React Native.
 *
 * @return The module name string used to register this native module.
 */
override fun getName(): String = NAME

  /**
   * Initializes the native audio engine with the specified sample rate and buffer size.
   *
   * Validates inputs and rejects the provided Promise with `"invalid_arguments"` when:
   * - `sampleRate` is not finite or not greater than 0,
   * - `framesPerBuffer` is not finite, not greater than 0, not an integer value, or exceeds the engine's maximum frames per buffer.
   * If native initialization fails the Promise is rejected with `"initialize_failed"`. On success the Promise is resolved with `null`.
   *
   * @param sampleRate Sample rate in hertz; must be > 0 and finite.
   * @param framesPerBuffer Desired buffer size in frames; must be an integer > 0 and ≤ the engine's maximum frames per buffer.
   * @param promise Promise resolved to `null` on success or rejected with an error code on failure.
   */
  @ReactMethod
  fun initialize(sampleRate: Double, framesPerBuffer: Double, promise: Promise) {
    if (!sampleRate.isFinite() || sampleRate <= 0.0) {
      promise.reject("invalid_arguments", "sampleRate must be positive and finite")
      return
    }
    if (!framesPerBuffer.isFinite() || framesPerBuffer <= 0.0) {
      promise.reject("invalid_arguments", "framesPerBuffer must be positive and finite")
      return
    }
    val framesInt = framesPerBuffer.toInt()
    if (abs(framesPerBuffer - framesInt.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "framesPerBuffer must be an integer value")
      return
    }
    val maxFrames = maxFramesPerBuffer
    if (framesInt == 0 || framesInt > maxFrames) {
      promise.reject(
        "invalid_arguments",
        "framesPerBuffer exceeds engine capacity (max $maxFrames)"
      )
      return
    }
    try {
      nativeInitialize(sampleRate, framesInt)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("initialize_failed", error)
    }
  }

  /**
   * Shuts down the native audio engine.
   *
   * Resolves the given promise with `null` on success. If shutdown fails, rejects the promise with
   * error code "shutdown_failed" and the underlying exception.
   *
   * @param promise Promise to resolve on success or reject with an error on failure.
   */
  @ReactMethod
  fun shutdown(promise: Promise) {
    try {
      nativeShutdown()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("shutdown_failed", error)
    }
  }

  /**
   * Adds a node to the audio engine graph using the provided identifier, type, and options.
   *
   * The `nodeId` and `nodeType` are trimmed and must be non-empty. The `options` map is sanitized into
   * a String-to-Double map where numeric, boolean, and parseable-string values are converted to `Double`.
   * On success the provided `promise` is resolved; on failure it is rejected with an error code.
   *
   * @param nodeId Unique identifier for the node (trimmed; required).
   * @param nodeType Type name of the node (trimmed; required).
   * @param options Configuration values for the node; values will be converted to `Double` when possible.
   * @param promise Promise that is resolved on success or rejected with an error on failure.
   */
  @ReactMethod
  fun addNode(nodeId: String, nodeType: String, options: ReadableMap, promise: Promise) {
    val sanitizedId = nodeId.trim()
    val sanitizedType = nodeType.trim()
    if (sanitizedId.isEmpty() || sanitizedType.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId and nodeType are required")
      return
    }
    val optionMap = options.toHashMap()
    val sanitizedOptions = sanitizeOptions(optionMap)
    try {
      nativeAddNode(sanitizedId, sanitizedType, sanitizedOptions)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("add_node_failed", error)
    }
  }

  /**
   * Removes a node from the audio engine by its identifier.
   *
   * Validates that `nodeId` is not empty; if validation fails the `promise` is rejected with
   * error code `"invalid_arguments"`. On success the `promise` is resolved with `null`. If the native
   * removal fails the `promise` is rejected with error code `"remove_node_failed"` and the underlying exception.
   *
   * @param nodeId The identifier of the node to remove (trimmed).
   * @param promise A React Native promise that is resolved on success or rejected on failure.
   */
  @ReactMethod
  fun removeNode(nodeId: String, promise: Promise) {
    val sanitizedId = nodeId.trim()
    if (sanitizedId.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId is required")
      return
    }
    try {
      nativeRemoveNode(sanitizedId)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("remove_node_failed", error)
    }
  }

  /**
   * Connects two audio nodes in the engine using their identifiers.
   *
   * @param source The source node identifier; leading and trailing whitespace are ignored and the identifier must not be empty.
   * @param destination The destination node identifier; leading and trailing whitespace are ignored and the identifier must not be empty.
   *
   * Resolves the provided Promise with `null` on success. Rejects the Promise with `"invalid_arguments"` if either identifier is empty, or with `"connect_failed"` and the underlying exception if the native connection fails.
   */
  @ReactMethod
  fun connectNodes(source: String, destination: String, promise: Promise) {
    val sanitizedSource = source.trim()
    val sanitizedDestination = destination.trim()
    if (sanitizedSource.isEmpty() || sanitizedDestination.isEmpty()) {
      promise.reject("invalid_arguments", "source and destination are required")
      return
    }
    try {
      nativeConnectNodes(sanitizedSource, sanitizedDestination)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("connect_failed", error)
    }
  }

  /**
   * Disconnects an existing connection from the source node to the destination node.
   *
   * @param source The source node ID.
   * @param destination The destination node ID.
   */
  @ReactMethod
  fun disconnectNodes(source: String, destination: String, promise: Promise) {
    val sanitizedSource = source.trim()
    val sanitizedDestination = destination.trim()
    if (sanitizedSource.isEmpty() || sanitizedDestination.isEmpty()) {
      promise.reject("invalid_arguments", "source and destination are required")
      return
    }
    try {
      nativeDisconnectNodes(sanitizedSource, sanitizedDestination)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("disconnect_failed", error)
    }
  }

  /**
   * Schedule a parameter automation event for a node at a specific frame.
   *
   * Schedules an automation for the named parameter of the given node at the integer frame index represented by `frame`. Resolves the provided promise with `null` on success. Rejects the promise with the error code `"invalid_arguments"` for validation failures (empty ids/parameters, non-finite values, negative or non-integer `frame`) or `"automation_failed"` if native scheduling fails.
   *
   * @param nodeId The node identifier; must be non-empty after trimming.
   * @param parameter The parameter name to automate; must be non-empty after trimming.
   * @param frame The target frame index; must be finite, greater than or equal to 0, and an integer value.
   * @param value The parameter value to apply at the given frame; must be finite.
   * @param promise Promise to resolve on success or reject with an error code on failure.
   */
  @ReactMethod
  fun scheduleParameterAutomation(
    nodeId: String,
    parameter: String,
    frame: Double,
    value: Double,
    promise: Promise
  ) {
    val sanitizedNodeId = nodeId.trim()
    val sanitizedParameter = parameter.trim()
    if (sanitizedNodeId.isEmpty() || sanitizedParameter.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId and parameter are required")
      return
    }
    if (!frame.isFinite() || frame < 0) {
      promise.reject("invalid_arguments", "frame must be non-negative")
      return
    }
    if (!value.isFinite()) {
      promise.reject("invalid_arguments", "value must be finite")
      return
    }
    val frameTicks = frame.roundToLong()
    if (abs(frame - frameTicks.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "frame must be an integer value")
      return
    }
    try {
      nativeScheduleAutomation(sanitizedNodeId, sanitizedParameter, frameTicks, value)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("automation_failed", error)
    }
  }

  /**
   * Fetches runtime render diagnostics from the native audio engine and delivers them to JavaScript.
   *
   * Resolves the provided promise with a map containing:
   * - "xruns": number of XRuns as a double.
   * - "lastRenderDurationMicros": last render duration in microseconds as a double.
   *
   * @param promise A Promise that is resolved with the diagnostics map on success or rejected with error code "diagnostics_failed" on failure.
   */
  @ReactMethod
  fun getRenderDiagnostics(promise: Promise) {
    try {
      val payload = nativeGetDiagnostics()
      val diagnostics = Arguments.createMap().apply {
        putDouble("xruns", payload[0])
        putDouble("lastRenderDurationMicros", payload[1])
      }
      promise.resolve(diagnostics)
    } catch (error: Exception) {
      promise.reject("diagnostics_failed", error)
    }
  }

  /**
 * Initialize the native audio engine with the specified audio configuration.
 *
 * Configures the engine to operate at the given sample rate (in hertz) and buffer size
 * expressed as frames per audio buffer.
 *
 * @param sampleRate Sample rate in Hz (e.g., 48000.0).
 * @param framesPerBuffer Number of audio frames per buffer (must be a positive integer). 
 */
private external fun nativeInitialize(sampleRate: Double, framesPerBuffer: Int)
  /**
 * Shuts down the native audio engine and releases its resources.
 *
 * Performs the native-side teardown required to stop audio processing and free associated resources.
 */
private external fun nativeShutdown()
  /**
 * Adds a new node to the native audio engine graph with the specified identifier, type, and numeric options.
 *
 * @param nodeId The node's unique identifier (expected to be a trimmed, non-empty string).
 * @param nodeType The node's type name (expected to be a trimmed, non-empty string).
 * @param options A map of option names to numeric values to configure the node; keys should be normalized lowercase strings.
 */
private external fun nativeAddNode(nodeId: String, nodeType: String, options: Map<String, Double>)
  /**
 * Removes the audio graph node identified by `nodeId` from the native audio engine.
 *
 * @param nodeId The identifier of the node to remove; expected to be a non-empty identifier previously added to the engine.
 */
private external fun nativeRemoveNode(nodeId: String)
  /**
 * Connects a source node to a destination node within the native audio engine graph.
 *
 * @param source ID of the source node to connect from.
 * @param destination ID of the destination node to connect to.
 */
private external fun nativeConnectNodes(source: String, destination: String)
  /**
 * Disconnects two audio graph nodes identified by their IDs.
 *
 * @param source The ID of the source node.
 * @param destination The ID of the destination node.
 */
private external fun nativeDisconnectNodes(source: String, destination: String)
  /**
 * Schedules an automation event for a node's parameter at a specific frame index with the given value.
 *
 * @param nodeId The node identifier to target (trimmed, non-empty).
 * @param parameter The parameter name to automate (trimmed, non-empty).
 * @param frame The frame index (tick) at which the automation event occurs; must be >= 0.
 * @param value The value to apply to the parameter at the specified frame.
 */
private external fun nativeScheduleAutomation(nodeId: String, parameter: String, frame: Long, value: Double)
  /**
 * Fetches render diagnostics from the native audio engine.
 *
 * @return A DoubleArray with two elements:
 *         - index 0 — the number of xruns (underruns),
 *         - index 1 — the last render duration in microseconds.
 */
private external fun nativeGetDiagnostics(): DoubleArray
  /**
 * Query the native audio engine for the maximum supported frames per buffer.
 *
 * @return The maximum number of frames allowed per audio buffer by the native engine (an integer greater than 0).
 */
private external fun nativeMaxFramesPerBuffer(): Int

  /**
   * Convert and normalize option entries into numeric values keyed by normalized names.
   *
   * @param options A map of option entries whose values may be numbers, booleans, strings, or null.
   * @return A map whose keys are trimmed and lowercased, and whose values are `Double`. Numbers are converted to `Double`, booleans map to `1.0` (true) or `0.0` (false), and strings are interpreted as boolean tokens (`"true"|"yes"|"on"` → `1.0`, `"false"|"no"|"off"` → `0.0`) or parsed as numeric values. Entries with empty keys, empty strings, nulls, or unparseable string values are omitted.
   */
  private fun sanitizeOptions(options: Map<String, Any?>): Map<String, Double> {
    if (options.isEmpty()) {
      return emptyMap()
    }
    val sanitized = HashMap<String, Double>(options.size)
    options.forEach { (rawKey, rawValue) ->
      val key = rawKey.trim().lowercase(Locale.US)
      if (key.isEmpty()) {
        return@forEach
      }
      when (rawValue) {
        is Number -> sanitized[key] = rawValue.toDouble()
        is Boolean -> sanitized[key] = if (rawValue) 1.0 else 0.0
        is String -> {
          val trimmed = rawValue.trim()
          if (trimmed.isEmpty()) {
            return@forEach
          }
          val lowered = trimmed.lowercase(Locale.US)
          when (lowered) {
            "true", "yes", "on" -> {
              sanitized[key] = 1.0
              return@forEach
            }
            "false", "no", "off" -> {
              sanitized[key] = 0.0
              return@forEach
            }
          }
          trimmed.toDoubleOrNull()?.let { sanitized[key] = it }
        }
      }
    }
    return sanitized
  }

  companion object {
    const val NAME = "AudioEngineModule"

    private val libraryLoaded = AtomicBoolean(false)

    /**
     * Ensures the native audio engine library "daft_audio_engine_module" is loaded for the process.
     *
     * Safe to call multiple times; the library will be loaded exactly once.
     */
    private fun ensureLibraryLoaded() {
      if (libraryLoaded.compareAndSet(false, true)) {
        System.loadLibrary("daft_audio_engine_module")
      }
    }
  }
}