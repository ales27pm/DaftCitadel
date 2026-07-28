package com.daftcitadel.audio

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Locale
import java.util.TreeMap
import java.math.BigDecimal
import kotlin.math.abs
import kotlin.math.roundToLong
import android.util.Base64
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONObject
import kotlin.math.roundToInt

@ReactModule(name = AudioEngineModule.NAME)
class AudioEngineModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), TurboModule {

  init {
    ensureLibraryLoaded()
  }

  private val maxFramesPerBuffer: Int by lazy { nativeMaxFramesPerBuffer() }
  private val nativeActive = AtomicBoolean(false)
  private val recoveryScheduled = AtomicBoolean(false)

  private data class DeviceConfiguration(
    val sampleRate: Int,
    val framesPerBuffer: Int
  )

  @Volatile
  private var deviceConfiguration: DeviceConfiguration? = null

  @Volatile
  private var audioConfigurationRecoveryError: Throwable? = null

  private val deviceDriver = AudioTrackDeviceDriver(
    renderInterleaved = ::nativeRenderInterleaved,
    onAudioConfigurationChange = ::scheduleAudioConfigurationRecovery
  )

  private fun scheduleAudioConfigurationRecovery() {
    if (!nativeActive.get() ||
      !deviceDriver.isRunning() ||
      !recoveryScheduled.compareAndSet(false, true)
    ) {
      return
    }
    reactContext.runOnNativeModulesQueueThread {
      try {
        recoverAfterAudioConfigurationChange()
      } finally {
        recoveryScheduled.set(false)
      }
    }
  }

  private fun recoverAfterAudioConfigurationChange() {
    val configuration = deviceConfiguration ?: return
    val wasDriverRunning = deviceDriver.isRunning()
    if (!nativeActive.get() || !wasDriverRunning) {
      return
    }

    deviceDriver.stop()
    try {
      val recovery =
        decodeGraphApplyResult(nativeRecoverAfterAudioConfigurationChange())
      if (recovery.getString("status") != "committed") {
        val detail =
          recovery.getMap("failure")?.getString("detail")
            ?: "Native graph recovery was rejected"
        throw IllegalStateException(detail)
      }
      deviceDriver.start(
        configuration.sampleRate,
        configuration.framesPerBuffer
      )
      check(deviceDriver.isRunning()) {
        "Audio device did not restart after configuration recovery"
      }
      audioConfigurationRecoveryError = null
    } catch (error: Throwable) {
      deviceDriver.stop()
      runCatching { nativeStopTransport() }
      audioConfigurationRecoveryError = error
      Log.e(TAG, "Audio configuration recovery failed", error)
    }
  }

  private fun requireSafeCounter(request: ReadableMap, key: String): Long {
    require(request.hasKey(key) && request.getType(key) == ReadableType.Number) {
      "$key must be numeric"
    }
    val value = request.getDouble(key)
    require(
      value.isFinite() &&
        value >= 0.0 &&
        value <= 9_007_199_254_740_991.0 &&
        value == value.toLong().toDouble()
    ) {
      "$key must be a non-negative safe integer"
    }
    return value.toLong()
  }

  private fun requireBoundedInteger(
    request: ReadableMap,
    key: String,
    minimum: Int,
    maximum: Int
  ): Int {
    require(request.hasKey(key) && request.getType(key) == ReadableType.Number) {
      "$key must be numeric"
    }
    val value = request.getDouble(key)
    require(
      value.isFinite() &&
        value >= minimum.toDouble() &&
        value <= maximum.toDouble() &&
        value == value.toInt().toDouble()
    ) {
      "$key must be an integer between $minimum and $maximum"
    }
    return value.toInt()
  }

  private fun canonicalJsonValue(value: Any?): String = when (value) {
    null -> "null"
    is Boolean -> value.toString()
    is String -> JSONObject.quote(value)
    is Number -> {
      val numeric = value.toDouble()
      require(numeric.isFinite()) {
        "Node options must contain only finite numbers"
      }
      if (numeric == 0.0) {
        "0"
      } else {
        BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
      }
    }
    is List<*> ->
      value.joinToString(separator = ",", prefix = "[", postfix = "]") {
        canonicalJsonValue(it)
      }
    is Array<*> ->
      value.joinToString(separator = ",", prefix = "[", postfix = "]") {
        canonicalJsonValue(it)
      }
    is Map<*, *> -> {
      val entries = value.entries.map { (key, nestedValue) ->
        require(key is String) {
          "Node option object keys must be strings"
        }
        key to nestedValue
      }.sortedBy { it.first }
      entries.joinToString(separator = ",", prefix = "{", postfix = "}") {
        (key, nestedValue) ->
        "${JSONObject.quote(key)}:${canonicalJsonValue(nestedValue)}"
      }
    }
    else -> throw IllegalArgumentException(
      "Node options contain unsupported value type '${value::class.java.simpleName}'"
    )
  }

  private fun canonicalOptions(options: Map<String, Any?>): String {
    val normalized = TreeMap<String, Any?>()
    options.keys.sorted().forEach { key ->
      normalized[key.lowercase(Locale.US)] = options[key]
    }
    return canonicalJsonValue(normalized)
  }

  private fun decodeGraphDescription(
    payload: Array<String>,
    offset: Int = 0
  ): Pair<WritableMap, Int> {
    require(payload.size >= offset + 5) {
      "Native graph description is truncated"
    }
    val generation = payload[offset].toLongOrNull()
      ?: throw IllegalStateException("Native graph generation is invalid")
    val graphHash = payload[offset + 1]
    val routeEpoch = payload[offset + 2].toLongOrNull()
      ?: throw IllegalStateException("Native graph route epoch is invalid")
    val engineInstance = payload[offset + 3].toLongOrNull()
      ?: throw IllegalStateException("Native graph engine instance is invalid")
    val nodeCount = payload[offset + 4].toIntOrNull()
      ?: throw IllegalStateException("Native graph node count is invalid")
    require(generation >= 0L && routeEpoch >= 0L && engineInstance >= 0L) {
      "Native graph identity must be non-negative"
    }
    require(graphHash.isNotEmpty() && nodeCount >= 0) {
      "Native graph hash and node count are invalid"
    }
    val nextOffset = offset + 5 + nodeCount
    require(payload.size >= nextOffset) {
      "Native graph node list is truncated"
    }
    val nodeIds = Arguments.createArray()
    for (index in 0 until nodeCount) {
      nodeIds.pushString(payload[offset + 5 + index])
    }
    val description = Arguments.createMap().apply {
      putDouble("generation", generation.toDouble())
      putString("graphHash", graphHash)
      putArray("nodeIds", nodeIds)
      putDouble("routeEpoch", routeEpoch.toDouble())
      putDouble("engineInstance", engineInstance.toDouble())
    }
    return description to nextOffset
  }

  private fun decodeGraphApplyResult(payload: Array<String>): WritableMap {
    require(payload.size >= 2) {
      "Native graph apply result is truncated"
    }
    val status = payload[0]
    val transactionId = payload[1]
    val (graph, failureOffset) = decodeGraphDescription(payload, 2)
    require(payload.size >= failureOffset + 4) {
      "Native graph failure payload is truncated"
    }
    return Arguments.createMap().apply {
      putString("status", status)
      putString("transactionId", transactionId)
      putMap("graph", graph)
      val stage = payload[failureOffset]
      if (stage.isNotEmpty() && stage != "none") {
        putMap("failure", Arguments.createMap().apply {
          putString("stage", stage)
          putString("code", payload[failureOffset + 1])
          putString("nodeId", payload[failureOffset + 2])
          putString("detail", payload[failureOffset + 3])
        })
      }
    }
  }

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
    val deviceSampleRate = sampleRate.roundToInt()
    try {
      deviceDriver.stop()
      nativeInitialize(sampleRate, framesInt)
      deviceConfiguration = DeviceConfiguration(deviceSampleRate, framesInt)
      audioConfigurationRecoveryError = null
      nativeActive.set(true)
      promise.resolve(null)
    } catch (error: Exception) {
      deviceConfiguration = null
      nativeActive.set(false)
      promise.reject("initialize_failed", error)
    }
  }

  @ReactMethod
  fun describeGraph(promise: Promise) {
    try {
      promise.resolve(decodeGraphDescription(nativeDescribeGraph()).first)
    } catch (error: Exception) {
      promise.reject("describe_graph_failed", error)
    }
  }

  @ReactMethod
  fun applyGraph(request: ReadableMap, promise: Promise) {
    try {
      require(
        request.hasKey("transactionId") &&
          request.getType("transactionId") == ReadableType.String
      ) {
        "transactionId is required"
      }
      val transactionId = request.getString("transactionId")?.trim().orEmpty()
      require(transactionId.isNotEmpty()) {
        "transactionId is required"
      }
      val expectedGeneration =
        requireSafeCounter(request, "expectedGeneration")
      val expectedRouteEpoch =
        requireSafeCounter(request, "expectedRouteEpoch")
      val expectedEngineInstance =
        requireSafeCounter(request, "expectedEngineInstance")
      require(
        request.hasKey("nodes") &&
          request.getType("nodes") == ReadableType.Array
      ) {
        "nodes must be an array"
      }
      require(
        request.hasKey("connections") &&
          request.getType("connections") == ReadableType.Array
      ) {
        "connections must be an array"
      }

      val rawNodes = requireNotNull(request.getArray("nodes"))
      val nodeIds = ArrayList<String>(rawNodes.size())
      val nodeTypes = ArrayList<String>(rawNodes.size())
      val nodeOptions = ArrayList<Map<String, Any?>>(rawNodes.size())
      val optionFingerprints = ArrayList<String>(rawNodes.size())
      for (index in 0 until rawNodes.size()) {
        val node = requireNotNull(rawNodes.getMap(index)) {
          "Every node must be an object"
        }
        require(
          node.hasKey("id") &&
            node.getType("id") == ReadableType.String &&
            node.hasKey("type") &&
            node.getType("type") == ReadableType.String &&
            node.hasKey("options") &&
            node.getType("options") == ReadableType.Map
        ) {
          "Each node needs id, type, and object options"
        }
        val nodeId = node.getString("id")?.trim().orEmpty()
        val nodeType =
          node.getString("type")?.trim()?.lowercase(Locale.US).orEmpty()
        require(nodeId.isNotEmpty() && nodeType.isNotEmpty()) {
          "Node id and type cannot be empty"
        }
        val options = requireNotNull(node.getMap("options")).toHashMap()
        nodeIds.add(nodeId)
        nodeTypes.add(nodeType)
        nodeOptions.add(options)
        optionFingerprints.add(canonicalOptions(options))
      }

      val rawConnections = requireNotNull(request.getArray("connections"))
      val connectionSources = ArrayList<String>(rawConnections.size())
      val connectionDestinations = ArrayList<String>(rawConnections.size())
      for (index in 0 until rawConnections.size()) {
        val connection = requireNotNull(rawConnections.getMap(index)) {
          "Every connection must be an object"
        }
        require(
          connection.hasKey("source") &&
            connection.getType("source") == ReadableType.String &&
            connection.hasKey("destination") &&
            connection.getType("destination") == ReadableType.String
        ) {
          "Every connection needs source and destination strings"
        }
        val source = connection.getString("source")?.trim().orEmpty()
        val destination =
          connection.getString("destination")?.trim().orEmpty()
        require(source.isNotEmpty() && destination.isNotEmpty()) {
          "Connection endpoints cannot be empty"
        }
        connectionSources.add(source)
        connectionDestinations.add(destination)
      }

      val payload = nativeApplyGraph(
        transactionId,
        expectedGeneration,
        expectedRouteEpoch,
        expectedEngineInstance,
        nodeIds.toTypedArray(),
        nodeTypes.toTypedArray(),
        nodeOptions.toTypedArray(),
        optionFingerprints.toTypedArray(),
        connectionSources.toTypedArray(),
        connectionDestinations.toTypedArray()
      )
      promise.resolve(decodeGraphApplyResult(payload))
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("apply_graph_failed", error)
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
      deviceConfiguration = null
      audioConfigurationRecoveryError = null
      recoveryScheduled.set(false)
      if (nativeActive.getAndSet(false)) {
        nativeShutdown()
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("shutdown_failed", error)
    }
  }

  override fun invalidate() {
    deviceDriver.stop()
    deviceConfiguration = null
    audioConfigurationRecoveryError = null
    recoveryScheduled.set(false)
    if (nativeActive.getAndSet(false)) {
      try {
        nativeShutdown()
      } catch (_: Exception) {
        // React Native invalidation cannot report a promise failure.
      }
    }
    super.invalidate()
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

  @ReactMethod
  fun sendInstrumentMidi(nodeId: String, event: ReadableMap?, promise: Promise) {
    val sanitizedNodeId = nodeId.trim()
    if (sanitizedNodeId.isEmpty() || event == null) {
      promise.reject("invalid_arguments", "nodeId and event are required")
      return
    }

    try {
      val type = requireBoundedInteger(event, "type", 0, 5)
      val channel = requireBoundedInteger(event, "channel", 0, 15)
      val data1 = requireBoundedInteger(event, "data1", 0, 127)
      val data2 = requireBoundedInteger(event, "data2", 0, 127)
      val frameOffset =
        if (event.hasKey("frameOffset")) {
          requireSafeCounter(event, "frameOffset")
        } else {
          0L
        }

      nativeSendInstrumentMidi(
        sanitizedNodeId,
        type,
        channel,
        data1,
        data2,
        frameOffset
      )
      promise.resolve(null)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error)
    } catch (error: Exception) {
      promise.reject("instrument_event_failed", error)
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
    val configuration = deviceConfiguration
    if (configuration == null) {
      promise.reject(
        "transport_start_failed",
        "Audio device configuration is unavailable"
      )
      return
    }
    try {
      nativeStartTransport()
      if (!deviceDriver.isRunning()) {
        deviceDriver.start(configuration.sampleRate, configuration.framesPerBuffer)
      }
      check(deviceDriver.isRunning()) {
        "Audio device failed to start"
      }
      audioConfigurationRecoveryError = null
      promise.resolve(null)
    } catch (error: Exception) {
      deviceDriver.stop()
      runCatching { nativeStopTransport() }
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
    if (!frame.isFinite() || frame < 0) {
      promise.reject("invalid_arguments", "frame must be non-negative and finite")
      return
    }
    val frameTicks = frame.roundToLong()
    if (abs(frame - frameTicks.toDouble()) > 1e-6) {
      promise.reject("invalid_arguments", "frame must be an integer value")
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
  fun setTransportLoop(startFrame: Double, endFrame: Double, enabled: Boolean, promise: Promise) {
    if (!startFrame.isFinite() || startFrame < 0 || !endFrame.isFinite() || endFrame < 0) {
      promise.reject("invalid_arguments", "transport loop frames must be non-negative and finite")
      return
    }
    val startTicks = startFrame.roundToLong()
    val endTicks = endFrame.roundToLong()
    if (abs(startFrame - startTicks.toDouble()) > 1e-6 ||
      abs(endFrame - endTicks.toDouble()) > 1e-6
    ) {
      promise.reject("invalid_arguments", "transport loop frames must be integer values")
      return
    }
    try {
      nativeSetTransportLoop(startTicks, endTicks, enabled)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("transport_loop_failed", error)
    }
  }

  @ReactMethod
  fun getTransportState(promise: Promise) {
    try {
      val payload = nativeGetTransportState()
      val state = Arguments.createMap().apply {
        putDouble("currentFrame", payload[0])
        putDouble("frame", payload[0])
        putBoolean("isPlaying", payload[1] != 0.0)
      }
      promise.resolve(state)
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
    val recoveryError = audioConfigurationRecoveryError
    if (recoveryError != null) {
      promise.reject("audio_configuration_recovery_failed", recoveryError)
      return
    }
    try {
      val payload = nativeGetDiagnostics()
      val diagnostics = Arguments.createMap().apply {
        putDouble("xruns", payload[0])
        putDouble("lastRenderDurationMicros", payload[1])
        if (payload.size >= 3) {
          putDouble("clipBufferBytes", payload[2])
        }
        if (payload.size >= 4) {
          putDouble("activeVoices", payload[3])
        }
        if (payload.size >= 5) {
          putDouble("pendingInstrumentEvents", payload[4])
        }
        if (payload.size >= 6) {
          putDouble("realtimeQueueDepth", payload[5])
        }
        if (payload.size >= 7) {
          putDouble("realtimeQueueOverflows", payload[6])
        }
        if (payload.size >= 8) {
          putDouble("realtimeCommandFailures", payload[7])
        }
        if (payload.size >= 9) {
          putDouble("renderCount", payload[8])
        }
        if (payload.size >= 10) {
          putDouble("averageRenderDurationMicros", payload[9])
        }
        if (payload.size >= 11) {
          putDouble("maximumRenderDurationMicros", payload[10])
        }
        if (payload.size >= 12) {
          putDouble("p50RenderDurationMicros", payload[11])
        }
        if (payload.size >= 13) {
          putDouble("p95RenderDurationMicros", payload[12])
        }
        if (payload.size >= 14) {
          putDouble("p99RenderDurationMicros", payload[13])
        }
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
private external fun nativeRenderInterleaved(
  output: FloatArray,
  channelCount: Int,
  frameCount: Int
)
private external fun nativeRecoverAfterAudioConfigurationChange(): Array<String>
private external fun nativeDescribeGraph(): Array<String>
private external fun nativeApplyGraph(
  transactionId: String,
  expectedGeneration: Long,
  expectedRouteEpoch: Long,
  expectedEngineInstance: Long,
  nodeIds: Array<String>,
  nodeTypes: Array<String>,
  nodeOptions: Array<Map<String, Any?>>,
  optionFingerprints: Array<String>,
  connectionSources: Array<String>,
  connectionDestinations: Array<String>
): Array<String>
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
private external fun nativeSendInstrumentMidi(
  nodeId: String,
  type: Int,
  channel: Int,
  data1: Int,
  data2: Int,
  frameOffset: Long
)
private external fun nativeAllNotesOff(nodeId: String)
private external fun nativeStartTransport()
private external fun nativeStopTransport()
private external fun nativeLocateTransport(frame: Long)
private external fun nativeSetTransportLoop(startFrame: Long, endFrame: Long, enabled: Boolean)
private external fun nativeGetTransportState(): DoubleArray
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
 * @return A DoubleArray with 14 elements when available:
 *         - index 0 — the number of xruns (underruns),
 *         - index 1 — the last render duration in microseconds,
 *         - index 2 — total clip buffer bytes currently registered,
 *         - index 3 — active voices,
 *         - index 4 — pending instrument events,
 *         - index 5 — realtime command queue depth,
 *         - index 6 — realtime queue overflows,
 *         - index 7 — realtime command failures,
 *         - index 8 — render count,
 *         - index 9 — average render duration in microseconds,
 *         - index 10 — maximum render duration in microseconds,
 *         - index 11 — p50 render duration in microseconds,
 *         - index 12 — p95 render duration in microseconds,
 *         - index 13 — p99 render duration in microseconds.
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
    private const val TAG = "DaftAudioEngine"

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
