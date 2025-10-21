package com.daftcitadel.plugins

import android.content.Context
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import java.io.BufferedWriter
import java.io.File
import java.io.FileReader
import java.io.IOException
import java.io.OutputStreamWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import org.json.JSONObject

@ReactModule(name = VST3PluginHostModule.NAME)
class VST3PluginHostModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

  private val hostManager = Vst3HostManager(reactContext) { instanceId, descriptor, reason, sandboxPath ->
    sendEvent("pluginCrashed", Arguments.createMap().apply {
      putString("instanceId", instanceId)
      putMap("descriptor", descriptor.toWritableMap())
      putString("timestamp", hostManager.timestamp())
      putString("reason", reason)
      putBoolean("recovered", false)
      putString("restartToken", UUID.randomUUID().toString())
      sandboxPath?.let { putString("sandboxPath", it) }
    })
  }

  init {
    reactContext.addLifecycleEventListener(this)
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun queryAvailablePlugins(format: String?, promise: Promise) {
    hostManager.queryAvailablePlugins(format)
      .map { it.toWritableMap() }
      .let { Arguments.createArray().apply { it.forEach { pushMap(it) } } }
      .also(promise::resolve)
  }

  @ReactMethod
  fun instantiatePlugin(identifier: String, options: ReadableMap, promise: Promise) {
    try {
      val sandboxId = if (options.hasKey("sandboxIdentifier")) options.getString("sandboxIdentifier") else null
      val instance = hostManager.instantiatePlugin(identifier, sandboxId)
      promise.resolve(instance.toWritableMap())
    } catch (error: Exception) {
      promise.reject("instantiate_failed", error)
    }
  }

  @ReactMethod
  fun releasePlugin(instanceId: String, promise: Promise) {
    hostManager.releaseInstance(instanceId)
    promise.resolve(null)
  }

  @ReactMethod
  fun loadPreset(instanceId: String, preset: ReadableMap, promise: Promise) {
    try {
      hostManager.sendCommand(instanceId, mapOf("type" to "preset", "preset" to preset.toHashMap()))
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("preset_failed", error)
    }
  }

  @ReactMethod
  fun setParameterValue(instanceId: String, parameterId: String, value: Double, promise: Promise) {
    try {
      hostManager.sendCommand(
        instanceId,
        mapOf("type" to "parameter", "parameterId" to parameterId, "value" to value)
      )
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("parameter_failed", error)
    }
  }

  @ReactMethod
  fun scheduleAutomation(instanceId: String, parameterId: String, curve: ReadableArray, promise: Promise) {
    val points = mutableListOf<Map<String, Any?>>()
    for (i in 0 until curve.size()) {
      val entry = curve.getMap(i)?.toHashMap() ?: continue
      points.add(entry)
    }
    try {
      hostManager.sendCommand(
        instanceId,
        mapOf("type" to "automation", "parameterId" to parameterId, "points" to points)
      )
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("automation_failed", error)
    }
  }

  @ReactMethod
  fun ensureSandbox(identifier: String, promise: Promise) {
    try {
      val path = hostManager.ensureSandbox(identifier)
      promise.resolve(Arguments.createMap().apply { putString("sandboxPath", path.absolutePath) })
    } catch (error: Exception) {
      sendEvent(
        "sandboxPermissionRequired",
        Arguments.createMap().apply {
          putString("identifier", identifier)
          putArray("requiredEntitlements", Arguments.createArray().apply {
            pushString("android.permission.READ_EXTERNAL_STORAGE")
            pushString("android.permission.WRITE_EXTERNAL_STORAGE")
          })
          putString("reason", error.localizedMessage)
        }
      )
      promise.reject("sandbox_failed", error)
    }
  }

  @ReactMethod
  fun acknowledgeCrash(instanceId: String, promise: Promise) {
    hostManager.releaseInstance(instanceId)
    promise.resolve(null)
  }

  override fun onHostResume() {}
  override fun onHostPause() {}

  override fun onHostDestroy() {
    hostManager.shutdown()
  }

  private fun sendEvent(event: String, payload: WritableMap) {
    reactContext
      .getJSModule(RCTDeviceEventEmitter::class.java)
      .emit(event, payload)
  }

  companion object {
    const val NAME = "PluginHostModule"
  }
}

data class Vst3PluginDescriptor(
  val identifier: String,
  val name: String,
  val manufacturer: String,
  val version: String,
  val path: File,
  val parameters: List<Vst3ParameterDescriptor>,
)

fun Vst3PluginDescriptor.toWritableMap(): WritableMap = Arguments.createMap().apply {
  putString("identifier", identifier)
  putString("name", name)
  putString("format", "vst3")
  putString("manufacturer", manufacturer)
  putString("version", version)
  putBoolean("supportsSandbox", true)
  putInt("audioInputChannels", 2)
  putInt("audioOutputChannels", 2)
  putBoolean("midiInput", true)
  putBoolean("midiOutput", true)
  putArray("parameters", Arguments.createArray().apply {
    parameters.forEach { pushMap(it.toWritableMap()) }
  })
}

data class Vst3ParameterDescriptor(
  val id: String,
  val name: String,
  val minValue: Double,
  val maxValue: Double,
  val defaultValue: Double,
  val automationRate: String,
)

fun Vst3ParameterDescriptor.toWritableMap(): WritableMap = Arguments.createMap().apply {
  putString("id", id)
  putString("name", name)
  putDouble("minValue", minValue)
  putDouble("maxValue", maxValue)
  putDouble("defaultValue", defaultValue)
  putString("automationRate", automationRate)
}

data class Vst3PluginInstance(
  val instanceId: String,
  val descriptor: Vst3PluginDescriptor,
  val sandbox: File?,
  private val process: PluginProcess,
) {
  fun toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("instanceId", instanceId)
    putMap("descriptor", descriptor.toWritableMap())
    putDouble("cpuLoadPercent", process.cpuLoad())
    putInt("latencySamples", 0)
    sandbox?.let { putString("sandboxPath", it.absolutePath) }
  }

  fun sendCommand(command: Map<String, Any?>) {
    process.sendCommand(command)
  }

  fun dispose() {
    process.stop()
  }
}

class Vst3HostManager(
  private val context: Context,
  private val onCrash: (String, Vst3PluginDescriptor, String, String?) -> Unit,
) {
  private val descriptors = ConcurrentHashMap<String, Vst3PluginDescriptor>()
  private val instances = ConcurrentHashMap<String, Vst3PluginInstance>()

  fun queryAvailablePlugins(format: String?): List<Vst3PluginDescriptor> {
    if (format != null && format.lowercase() != "vst3") {
      return emptyList()
    }
    val results = mutableListOf<Vst3PluginDescriptor>()
    pluginRoots().forEach { root ->
      root.listFiles { file -> file.extension.equals("vst3", ignoreCase = true) }?.forEach { bundle ->
        parseDescriptor(bundle)?.let {
          descriptors[it.identifier] = it
          results.add(it)
        }
      }
    }
    return results
  }

  fun instantiatePlugin(identifier: String, sandboxIdentifier: String?): Vst3PluginInstance {
    val descriptor = descriptors[identifier] ?: queryAvailablePlugins("vst3").firstOrNull { it.identifier == identifier }
      ?: throw IllegalArgumentException("Unknown plugin: $identifier")
    val sandbox = sandboxIdentifier?.let { ensureSandbox(it) }
    val instanceId = UUID.randomUUID().toString()
    val process = PluginProcess(context, descriptor, sandbox) { reason ->
      onCrash(instanceId, descriptor, reason, sandbox?.absolutePath)
      instances.remove(instanceId)
    }
    val instance = Vst3PluginInstance(instanceId, descriptor, sandbox, process)
    instances[instance.instanceId] = instance
    return instance
  }

  fun releaseInstance(instanceId: String) {
    instances.remove(instanceId)?.dispose()
  }

  fun sendCommand(instanceId: String, command: Map<String, Any?>) {
    val instance = instances[instanceId] ?: throw IllegalArgumentException("Unknown instance $instanceId")
    instance.sendCommand(command)
  }

  fun ensureSandbox(identifier: String): File {
    val base = File(context.filesDir, "plugin-sandboxes")
    if (!base.exists()) {
      base.mkdirs()
    }
    val sandbox = File(base, identifier)
    if (!sandbox.exists()) {
      sandbox.mkdirs()
    }
    return sandbox
  }

  fun shutdown() {
    instances.values.forEach { it.dispose() }
    instances.clear()
  }

  fun timestamp(): String {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      java.time.OffsetDateTime.now().toString()
    } else {
      SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date())
    }
  }

  private fun pluginRoots(): List<File> {
    val roots = mutableListOf<File>()
    roots.add(File(context.filesDir, "plugins"))
    context.getExternalFilesDir(null)?.let { roots.add(File(it, "plugins")) }
    return roots
  }

  private fun parseDescriptor(bundle: File): Vst3PluginDescriptor? {
    val info = File(bundle, "Contents/Info.json")
    if (!info.exists()) {
      return null
    }
    return try {
      FileReader(info).use { reader ->
        val json = JSONObject(reader.readText())
        val params = mutableListOf<Vst3ParameterDescriptor>()
        val parametersJson = json.optJSONArray("parameters")
        if (parametersJson != null) {
          for (i in 0 until parametersJson.length()) {
            val item = parametersJson.getJSONObject(i)
            params.add(
              Vst3ParameterDescriptor(
                id = item.getString("id"),
                name = item.getString("name"),
                minValue = item.getDouble("min"),
                maxValue = item.getDouble("max"),
                defaultValue = item.optDouble("default", 0.0),
                automationRate = item.optString("automationRate", "control"),
              )
            )
          }
        }
        Vst3PluginDescriptor(
          identifier = json.optString("identifier", bundle.nameWithoutExtension),
          name = json.optString("name", bundle.nameWithoutExtension),
          manufacturer = json.optString("manufacturer", "Unknown"),
          version = json.optString("version", "1.0.0"),
          path = bundle,
          parameters = params,
        )
      }
    } catch (error: IOException) {
      null
    }
  }
}

private class PluginProcess(
  context: Context,
  private val descriptor: Vst3PluginDescriptor,
  private val sandbox: File?,
  private val onCrash: (String) -> Unit,
) {
  private val process: Process
  private val writer: BufferedWriter
  private val monitorThread: Thread

  init {
    val executable = resolveExecutable(context)
    val builder = ProcessBuilder(executable.absolutePath, descriptor.path.absolutePath).apply {
      environment()["PLUGIN_SANDBOX"] = sandbox?.absolutePath ?: ""
    }
    process = builder.start()
    writer = BufferedWriter(OutputStreamWriter(process.outputStream))
    monitorThread = Thread {
      val exitCode = process.waitFor()
      onCrash("Process exited with code $exitCode")
    }
    monitorThread.isDaemon = true
    monitorThread.start()
  }

  fun sendCommand(command: Map<String, Any?>) {
    val json = JSONObject(command).toString()
    writer.write(json)
    writer.newLine()
    writer.flush()
  }

  fun cpuLoad(): Double {
    return 0.0
  }

  fun stop() {
    try {
      sendCommand(mapOf("type" to "shutdown"))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        process.waitFor(500, TimeUnit.MILLISECONDS)
      } else {
        Thread.sleep(500)
      }
    } catch (_: Exception) {
    } finally {
      process.destroy()
    }
  }

  private fun resolveExecutable(context: Context): File {
    val bundled = File(context.filesDir, "vst3sandbox")
    if (bundled.exists()) {
      return bundled
    }
    val nativeDir = File(context.applicationInfo.nativeLibraryDir)
    val candidate = File(nativeDir, "libvst3sandbox.so")
    if (candidate.exists()) {
      return candidate
    }
    throw IllegalStateException("VST3 sandbox executable not found")
  }
}
