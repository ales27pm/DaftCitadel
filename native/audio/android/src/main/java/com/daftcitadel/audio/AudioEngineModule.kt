package com.daftcitadel.audio

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong
import kotlin.math.roundToInt
import android.util.Base64
import java.nio.ByteBuffer
import java.nio.ByteOrder

@ReactModule(name = AudioEngineModule.NAME)
class AudioEngineModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), TurboModule {

  init {
    ensureLibraryLoaded()
  }

  private val maxFramesPerBuffer: Int by lazy { nativeMaxFramesPerBuffer() }
  private val deviceDriver = AudioTrackDeviceDriver(::nativeRenderInterleaved)
  @Volatile private var engineInitialized = false
  @Volatile private var deviceConfiguration: DeviceConfiguration? = null

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
    val deviceSampleRate = sampleRate.roundToInt()
    if (abs(sampleRate - deviceSampleRate.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "sampleRate must be an integer value")
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
      deviceDriver.stop()
      clearConfigurationState()
      nativeInitialize(sampleRate, framesInt)
      deviceConfiguration = DeviceConfiguration(deviceSampleRate, framesInt)
      engineInitialized = true
      promise.resolve(null)
    } catch (error: Exception) {
      clearConfigurationState()
      deviceDriver.stop()
      runCatching { nativeShutdown() }
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
      deviceDriver.stop()
      nativeShutdown()
      clearConfigurationState()
      promise.resolve(null)
    } catch (error: Exception) {
      clearConfigurationState()
      promise.reject("shutdown_failed", error)
    }
  }

  override fun invalidate() {
    clearConfigurationState()
    deviceDriver.stop()
    runCatching { nativeShutdown() }
    super.invalidate()
  }

  /**
   * Adds a node to the audio engine graph using the provided identifier, type, and options.
   *
   * The `nodeId` and `nodeType` are trimmed and must be non-empty. The `options` map is sanitized into
   * a normalized map while preserving string identifiers required by clip and plugin nodes.
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
   * Registers a PCM clip buffer for later playback by native clip nodes.
   *
   * Validates that the provided buffer metadata and channel payloads are well formed and forwards
   * the data to the native bridge. Channel payloads are accepted as:
   * - Float sample arrays (ReadableArray of numbers),
   * - Base64-encoded Float32 PCM strings,
   * - Node-style Buffer maps ({ type: "Buffer", data: number[] }).
   *
   * On validation failure the promise is rejected with `"invalid_arguments"`; native errors yield
   * `"register_clip_failed"`.
   */
  @ReactMethod
  fun registerClipBuffer(
    bufferKey: String,
    sampleRate: Double,
    channels: Double,
    frames: Double,
    channelData: ReadableArray,
    promise: Promise
  ) {
    val sanitizedKey = bufferKey.trim()
    if (sanitizedKey.isEmpty()) {
      promise.reject("invalid_arguments", "bufferKey is required")
      return
    }
    if (!sampleRate.isFinite() || sampleRate <= 0.0) {
      promise.reject("invalid_arguments", "sampleRate must be positive and finite")
      return
    }
    if (!channels.isFinite() || channels <= 0.0) {
      promise.reject("invalid_arguments", "channels must be positive and finite")
      return
    }
    val channelCount = channels.toInt()
    if (abs(channels - channelCount.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "channels must be an integer value")
      return
    }
    if (channelCount == 0 || channelCount > 64) {
      promise.reject("invalid_arguments", "channels must be between 1 and 64")
      return
    }
    if (!frames.isFinite() || frames <= 0.0) {
      promise.reject("invalid_arguments", "frames must be positive and finite")
      return
    }
    val frameCountLong = frames.roundToLong()
    if (abs(frames - frameCountLong.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "frames must be an integer value")
      return
    }
    if (frameCountLong <= 0 || frameCountLong > 10_000_000L) {
      promise.reject("invalid_arguments", "frames must be between 1 and 10000000")
      return
    }
    if (frameCountLong > Int.MAX_VALUE) {
      promise.reject("invalid_arguments", "frames exceed platform limits")
      return
    }
    if (channelData.size() != channelCount) {
      promise.reject("invalid_arguments", "channelData length must equal channels")
      return
    }

    val frameCount = frameCountLong.toInt()
    val channelMatrix = Array(channelCount) { FloatArray(frameCount) }

    try {
      for (index in 0 until channelCount) {
        val samples = extractChannelSamples(channelData, index, frameCount)
        if (samples.size != frameCount) {
          throw IllegalArgumentException("channelData[$index] length does not match frames")
        }
        samples.copyInto(channelMatrix[index])
      }
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
      return
    }

    try {
      nativeRegisterClipBuffer(sanitizedKey, sampleRate, channelCount, frameCount, channelMatrix)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("register_clip_failed", error)
    }
  }

  @ReactMethod
  fun unregisterClipBuffer(bufferKey: String, promise: Promise) {
    val sanitizedKey = bufferKey.trim()
    if (sanitizedKey.isEmpty()) {
      promise.reject("invalid_arguments", "bufferKey is required")
      return
    }
    try {
      nativeUnregisterClipBuffer(sanitizedKey)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("unregister_clip_failed", error)
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
    val sanitizedParameter = parameter.trim().lowercase(Locale.US)
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

  @ReactMethod
  fun sendMidiEvent(
    nodeId: String,
    type: Double,
    channel: Double,
    data1: Double,
    data2: Double,
    frameOffset: Double,
    promise: Promise
  ) {
    val sanitizedNodeId = nodeId.trim()
    if (sanitizedNodeId.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId is required")
      return
    }
    try {
      nativeSendMidiEvent(
        sanitizedNodeId,
        requireUnsignedInteger(type, "type", 5).toInt(),
        requireUnsignedInteger(channel, "channel", 15).toInt(),
        requireUnsignedInteger(data1, "data1", 127).toInt(),
        requireUnsignedInteger(data2, "data2", 127).toInt(),
        requireUnsignedInteger(frameOffset, "frameOffset", MAX_SAFE_JS_INTEGER)
      )
      promise.resolve(null)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("midi_event_failed", error)
    }
  }

  @ReactMethod
  fun sendMidiEvents(nodeId: String, events: ReadableArray, replace: Boolean, promise: Promise) {
    val sanitizedNodeId = nodeId.trim()
    if (sanitizedNodeId.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId is required")
      return
    }
    try {
      val count = events.size()
      val frames = LongArray(count)
      val types = IntArray(count)
      val channels = IntArray(count)
      val data1 = IntArray(count)
      val data2 = IntArray(count)
      for (index in 0 until count) {
        if (events.getType(index) != ReadableType.Map) {
          throw IllegalArgumentException("MIDI event at index $index must be an object")
        }
        val event = events.getMap(index)
          ?: throw IllegalArgumentException("MIDI event at index $index is missing")
        frames[index] = readUnsignedInteger(event, "frame", MAX_SAFE_JS_INTEGER)
        types[index] = readUnsignedInteger(event, "type", 5).toInt()
        channels[index] = readUnsignedInteger(event, "channel", 15).toInt()
        data1[index] = readUnsignedInteger(event, "data1", 127).toInt()
        data2[index] = readUnsignedInteger(event, "data2", 127).toInt()
      }
      nativeSendMidiEvents(sanitizedNodeId, frames, types, channels, data1, data2, replace)
      promise.resolve(null)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("midi_batch_failed", error)
    }
  }

  @ReactMethod
  fun setInstrumentParameter(
    nodeId: String,
    parameterId: Double,
    value: Double,
    frameOffset: Double,
    promise: Promise
  ) {
    val sanitizedNodeId = nodeId.trim()
    if (sanitizedNodeId.isEmpty() || !value.isFinite()) {
      promise.reject("invalid_arguments", "nodeId and a finite value are required")
      return
    }
    try {
      val parameter = requireUnsignedInteger(parameterId, "parameterId", 65535)
      if (parameter == 0L) {
        throw IllegalArgumentException("parameterId must be greater than zero")
      }
      nativeSetInstrumentParameter(
        sanitizedNodeId,
        parameter.toInt(),
        value,
        requireUnsignedInteger(frameOffset, "frameOffset", MAX_SAFE_JS_INTEGER)
      )
      promise.resolve(null)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("instrument_parameter_failed", error)
    }
  }

  @ReactMethod
  fun sendInstrumentParameters(
    nodeId: String,
    events: ReadableArray,
    replace: Boolean,
    promise: Promise
  ) {
    val sanitizedNodeId = nodeId.trim()
    if (sanitizedNodeId.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId is required")
      return
    }
    try {
      val count = events.size()
      val frames = LongArray(count)
      val parameterIds = IntArray(count)
      val values = DoubleArray(count)
      for (index in 0 until count) {
        if (events.getType(index) != ReadableType.Map) {
          throw IllegalArgumentException(
            "Instrument parameter event at index $index must be an object"
          )
        }
        val event = events.getMap(index)
          ?: throw IllegalArgumentException(
            "Instrument parameter event at index $index is missing"
          )
        frames[index] = readUnsignedInteger(event, "frame", MAX_SAFE_JS_INTEGER)
        parameterIds[index] = readUnsignedInteger(event, "parameterId", 65535).toInt()
        if (parameterIds[index] == 0) {
          throw IllegalArgumentException("parameterId must be greater than zero")
        }
        values[index] = readFiniteNumber(event, "value")
      }
      nativeSendInstrumentParameters(
        sanitizedNodeId,
        frames,
        parameterIds,
        values,
        replace
      )
      promise.resolve(null)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("instrument_parameter_batch_failed", error)
    }
  }

  @ReactMethod
  fun allNotesOff(nodeId: String, promise: Promise) {
    val sanitizedNodeId = nodeId.trim()
    if (sanitizedNodeId.isEmpty()) {
      promise.reject("invalid_arguments", "nodeId is required")
      return
    }
    try {
      nativeAllNotesOff(sanitizedNodeId)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("all_notes_off_failed", error)
    }
  }

  @ReactMethod
  fun startTransport(promise: Promise) {
    var startedDeviceForRequest = false
    try {
      val configuration = deviceConfiguration
      check(engineInitialized && configuration != null) { "Audio engine is not initialized" }
      if (!deviceDriver.isRunning()) {
        deviceDriver.start(configuration.sampleRate, configuration.framesPerBuffer)
        startedDeviceForRequest = true
      }
      check(deviceDriver.isRunning()) { "AudioTrack render driver failed to start" }
      nativeStartTransport()
      promise.resolve(null)
    } catch (error: Exception) {
      if (startedDeviceForRequest) {
        deviceDriver.stop()
      }
      promise.reject("transport_start_failed", error)
    }
  }

  @ReactMethod
  fun stopTransport(promise: Promise) {
    try {
      nativeStopTransport()
      deviceDriver.stop()
      promise.resolve(null)
    } catch (error: Exception) {
      deviceDriver.stop()
      promise.reject("transport_stop_failed", error)
    }
  }

  @ReactMethod
  fun locateTransport(frame: Double, promise: Promise) {
    if (!frame.isFinite() || frame < 0.0) {
      promise.reject("invalid_arguments", "frame must be a non-negative integer")
      return
    }
    val frameTicks = frame.roundToLong()
    if (abs(frame - frameTicks.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "frame must be a non-negative integer")
      return
    }
    try {
      nativeLocateTransport(frameTicks)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("transport_locate_failed", error)
    }
  }

  @ReactMethod
  fun setTransportLoop(
    startFrame: Double,
    endFrame: Double,
    enabled: Boolean,
    promise: Promise
  ) {
    try {
      val startTicks = requireUnsignedInteger(
        startFrame,
        "startFrame",
        MAX_SAFE_JS_INTEGER
      )
      val endTicks = requireUnsignedInteger(endFrame, "endFrame", MAX_SAFE_JS_INTEGER)
      if (enabled && startTicks >= endTicks) {
        throw IllegalArgumentException(
          "Enabled transport loop requires startFrame < endFrame"
        )
      }
      nativeSetTransportLoop(startTicks, endTicks, enabled)
      promise.resolve(null)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("transport_loop_failed", error)
    }
  }

  @ReactMethod
  fun getTransportState(promise: Promise) {
    try {
      val state = nativeGetTransportState()
      val payload = Arguments.createMap().apply {
        putDouble("currentFrame", state[0])
        putBoolean("isPlaying", state[1] != 0.0)
      }
      promise.resolve(payload)
    } catch (error: Exception) {
      promise.reject("transport_state_failed", error)
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
        if (payload.size >= 3) {
          putDouble("clipBufferBytes", payload[2])
        }
        putBoolean("initialized", engineInitialized)
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
 * Adds a new node to the native audio engine graph with the specified identifier, type, and options.
 *
 * @param nodeId The node's unique identifier (expected to be a trimmed, non-empty string).
 * @param nodeType The node's type name (expected to be a trimmed, non-empty string).
 * @param options A map of normalized option names to numeric or string values.
 */
private external fun nativeAddNode(nodeId: String, nodeType: String, options: Map<String, Any>)
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
private external fun nativeSendMidiEvent(
  nodeId: String,
  type: Int,
  channel: Int,
  data1: Int,
  data2: Int,
  frameOffset: Long
)
private external fun nativeSendMidiEvents(
  nodeId: String,
  frames: LongArray,
  types: IntArray,
  channels: IntArray,
  data1: IntArray,
  data2: IntArray,
  replace: Boolean
)
private external fun nativeSetInstrumentParameter(
  nodeId: String,
  parameterId: Int,
  value: Double,
  frameOffset: Long
)
private external fun nativeSendInstrumentParameters(
  nodeId: String,
  frames: LongArray,
  parameterIds: IntArray,
  values: DoubleArray,
  replace: Boolean
)
private external fun nativeAllNotesOff(nodeId: String)
private external fun nativeStartTransport()
private external fun nativeStopTransport()
private external fun nativeLocateTransport(frame: Long)
private external fun nativeSetTransportLoop(
  startFrame: Long,
  endFrame: Long,
  enabled: Boolean
)
private external fun nativeGetTransportState(): DoubleArray
private external fun nativeRenderInterleaved(output: FloatArray, channels: Int, frames: Int)
  /**
   * Registers a multi-channel Float32 clip buffer with the native audio engine.
   *
   * @param bufferKey Identifier for the buffer that native clip nodes will reference.
   * @param sampleRate Sample rate of the buffer in Hz.
   * @param channels Number of channels.
   * @param frames Frame count stored in each channel array.
   * @param channelData Planar Float32 PCM: channelData[c][f] with size [channels][frames].
   */
  private external fun nativeRegisterClipBuffer(
    bufferKey: String,
    sampleRate: Double,
    channels: Int,
    frames: Int,
    channelData: Array<FloatArray>
  )
  private external fun nativeUnregisterClipBuffer(bufferKey: String)
  /**
 * Fetches render diagnostics from the native audio engine.
 *
 * @return A DoubleArray with three elements:
 *         - index 0 — the number of xruns (underruns),
 *         - index 1 — the last render duration in microseconds,
 *         - index 2 — total clip buffer bytes currently registered.
 */
private external fun nativeGetDiagnostics(): DoubleArray
  /**
 * Query the native audio engine for the maximum supported frames per buffer.
 *
 * @return The maximum number of frames allowed per audio buffer by the native engine (an integer greater than 0).
 */
private external fun nativeMaxFramesPerBuffer(): Int

  private fun requireUnsignedInteger(value: Double, field: String, maximum: Long): Long {
    if (!value.isFinite() || value < 0.0 || value > maximum.toDouble()) {
      throw IllegalArgumentException("$field must be a non-negative integer within range")
    }
    val integer = value.toLong()
    if (value != integer.toDouble()) {
      throw IllegalArgumentException("$field must be a non-negative integer within range")
    }
    return integer
  }

  private fun readFiniteNumber(map: ReadableMap, key: String): Double {
    if (!map.hasKey(key) || map.isNull(key) || map.getType(key) != ReadableType.Number) {
      throw IllegalArgumentException("$key must be a number")
    }
    val value = map.getDouble(key)
    if (!value.isFinite()) {
      throw IllegalArgumentException("$key must be finite")
    }
    return value
  }

  private fun readUnsignedInteger(map: ReadableMap, key: String, maximum: Long): Long =
    requireUnsignedInteger(readFiniteNumber(map, key), key, maximum)

  private fun clearConfigurationState() {
    engineInitialized = false
    deviceConfiguration = null
  }

  /**
   * Convert and normalize option entries while retaining native node identifiers.
   *
   * @param options A map of option entries whose values may be numbers, booleans, strings, or null.
   * @return A map whose keys are trimmed and lowercased. Numbers and booleans
   * are represented as `Double`; non-empty strings are preserved so JNI can
   * retain values such as `bufferKey` and `hostInstanceId` while also parsing
   * numeric/boolean string tokens where appropriate.
   */
  private fun sanitizeOptions(options: Map<String, Any?>): Map<String, Any> {
    if (options.isEmpty()) {
      return emptyMap()
    }
    val sanitized = HashMap<String, Any>(options.size)
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
          sanitized[key] = trimmed
        }
      }
    }
    return sanitized
  }

  private fun extractChannelSamples(channelData: ReadableArray, index: Int, frameCount: Int): FloatArray {
    return when (channelData.getType(index)) {
      ReadableType.Array -> convertReadableArrayToFloatChannel(channelData.getArray(index), frameCount)
      ReadableType.Map -> parseChannelMap(channelData.getMap(index), frameCount)
      ReadableType.String -> decodeBase64Channel(channelData.getString(index), frameCount)
      else -> throw IllegalArgumentException("channelData[$index] must be Float array, base64 string, or Buffer map")
    }
  }

  private fun parseChannelMap(map: ReadableMap?, frameCount: Int): FloatArray {
    if (map == null) {
      throw IllegalArgumentException("channelData entry cannot be null")
    }
    val loweredType = if (map.hasKey("type") && !map.isNull("type") && map.getType("type") == ReadableType.String) {
      map.getString("type")?.trim()?.lowercase(Locale.US)
    } else {
      null
    }
    if (map.hasKey("base64") && map.getType("base64") == ReadableType.String) {
      return decodeBase64Channel(map.getString("base64"), frameCount)
    }
    if (map.hasKey("data")) {
      return when (map.getType("data")) {
        ReadableType.Array -> {
          val dataArray = map.getArray("data")
          if (loweredType == "buffer" || loweredType == "bytes" || loweredType == "arraybuffer") {
            convertByteReadableArray(dataArray, frameCount)
          } else {
            convertReadableArrayToFloatChannel(dataArray, frameCount)
          }
        }
        ReadableType.String -> decodeBase64Channel(map.getString("data"), frameCount)
        else -> throw IllegalArgumentException("Unsupported channel payload in data map")
      }
    }
    if (map.hasKey("buffer")) {
      return when (map.getType("buffer")) {
        ReadableType.Map -> parseChannelMap(map.getMap("buffer"), frameCount)
        ReadableType.Array -> convertByteReadableArray(map.getArray("buffer"), frameCount)
        ReadableType.String -> decodeBase64Channel(map.getString("buffer"), frameCount)
        else -> throw IllegalArgumentException("Unsupported buffer payload in channel map")
      }
    }
    throw IllegalArgumentException("channelData map does not contain supported payload")
  }

  private fun convertReadableArrayToFloatChannel(array: ReadableArray?, frameCount: Int): FloatArray {
    if (array == null || array.size() < frameCount) {
      throw IllegalArgumentException("channel sample array is shorter than frames")
    }
    val floats = FloatArray(frameCount)
    for (i in 0 until frameCount) {
      val value = array.getDouble(i)
      if (!value.isFinite()) {
        throw IllegalArgumentException("channel sample value must be finite")
      }
      floats[i] = value.toFloat()
    }
    return floats
  }

  private fun convertByteReadableArray(array: ReadableArray?, frameCount: Int): FloatArray {
    if (array == null) {
      throw IllegalArgumentException("channel byte payload is missing")
    }
    val expectedBytes = frameCount * java.lang.Float.BYTES
    if (array.size() < expectedBytes) {
      throw IllegalArgumentException("channel byte payload is shorter than expected")
    }
    val byteBuffer = ByteBuffer.allocate(expectedBytes).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until expectedBytes) {
      val numeric = array.getDouble(i)
      if (!numeric.isFinite()) {
        throw IllegalArgumentException("channel byte payload must contain finite values")
      }
      val byteValue = numeric.toInt()
      if (byteValue < 0 || byteValue > 255) {
        throw IllegalArgumentException("channel byte payload contains invalid byte value")
      }
      byteBuffer.put(byteValue.toByte())
    }
    byteBuffer.rewind()
    val floatBuffer = byteBuffer.asFloatBuffer()
    if (floatBuffer.remaining() < frameCount) {
      throw IllegalArgumentException("channel byte payload cannot supply requested frames")
    }
    val floats = FloatArray(frameCount)
    floatBuffer.get(floats)
    return floats
  }

  private fun decodeBase64Channel(payload: String?, frameCount: Int): FloatArray {
    if (payload.isNullOrEmpty()) {
      throw IllegalArgumentException("channel base64 payload is empty")
    }
    val decoded = Base64.decode(payload, Base64.DEFAULT)
    val requiredBytes = frameCount * java.lang.Float.BYTES
    if (decoded.size < requiredBytes) {
      throw IllegalArgumentException("channel base64 payload is shorter than expected")
    }
    val floatBuffer = ByteBuffer.wrap(decoded).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
    if (floatBuffer.remaining() < frameCount) {
      throw IllegalArgumentException("channel base64 payload cannot supply requested frames")
    }
    val floats = FloatArray(frameCount)
    floatBuffer.get(floats)
    return floats
  }

  companion object {
    const val NAME = "AudioEngineModule"
    private const val MAX_SAFE_JS_INTEGER = 9_007_199_254_740_991L

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

  private data class DeviceConfiguration(
    val sampleRate: Int,
    val framesPerBuffer: Int
  )
}
