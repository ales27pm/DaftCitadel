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

  override fun getName(): String = NAME

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

  @ReactMethod
  fun shutdown(promise: Promise) {
    try {
      nativeShutdown()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("shutdown_failed", error)
    }
  }

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

  private external fun nativeInitialize(sampleRate: Double, framesPerBuffer: Int)
  private external fun nativeShutdown()
  private external fun nativeAddNode(nodeId: String, nodeType: String, options: Map<String, Double>)
  private external fun nativeRemoveNode(nodeId: String)
  private external fun nativeConnectNodes(source: String, destination: String)
  private external fun nativeDisconnectNodes(source: String, destination: String)
  private external fun nativeScheduleAutomation(nodeId: String, parameter: String, frame: Long, value: Double)
  private external fun nativeGetDiagnostics(): DoubleArray
  private external fun nativeMaxFramesPerBuffer(): Int

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

    private fun ensureLibraryLoaded() {
      if (libraryLoaded.compareAndSet(false, true)) {
        System.loadLibrary("daft_audio_engine_module")
      }
    }
  }
}
