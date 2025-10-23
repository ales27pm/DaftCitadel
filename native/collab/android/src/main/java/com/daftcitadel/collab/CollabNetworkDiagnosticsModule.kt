package com.daftcitadel.collab

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private const val EVENT_NAME = "CollabNetworkDiagnosticsEvent"
private const val LOG_TAG = "CollabDiagnostics"

class CollabNetworkDiagnosticsModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private val applicationContext: Context = reactContext.applicationContext
  private val wifiManager: WifiManager? =
    applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
  private val scheduler = Executors.newSingleThreadScheduledExecutor()
  private var pollTask: ScheduledFuture<*>? = null

  override fun getName(): String = "CollabNetworkDiagnostics"

  @ReactMethod
  fun getCurrentLinkMetrics(promise: Promise) {
    try {
      promise.resolve(collectMetrics())
    } catch (error: SecurityException) {
      Log.w(LOG_TAG, "Permission required for Wi-Fi metrics", error)
      promise.reject("collab_metrics_permission_denied", error.message, error)
    } catch (error: Exception) {
      Log.e(LOG_TAG, "Unable to collect Wi-Fi metrics", error)
      promise.reject("collab_metrics_unavailable", error.message, error)
    }
  }

  @ReactMethod
  fun startObserving() {
    if (pollTask != null) {
      return
    }

    try {
      emitMetrics()
    } catch (error: Exception) {
      Log.w(LOG_TAG, "Initial metrics unavailable", error)
      sendErrorEvent(error.message ?: "Metrics unavailable")
    }

    pollTask = scheduler.scheduleAtFixedRate(
      {
        try {
          emitMetrics()
        } catch (error: Exception) {
          Log.w(LOG_TAG, "Polling failure", error)
          sendErrorEvent(error.message ?: "Metrics unavailable")
        }
      },
      5,
      5,
      TimeUnit.SECONDS,
    )
  }

  @ReactMethod
  fun stopObserving() {
    pollTask?.cancel(true)
    pollTask = null
  }

  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
    // Required for React Native event emitter semantics.
  }

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {
    // Required for React Native event emitter semantics.
  }

  override fun invalidate() {
    super.invalidate()
    scheduler.shutdownNow()
  }

  @Throws(Exception::class)
  private fun collectMetrics(): WritableMap {
    ensurePermissions()
    val wifi = wifiManager ?: throw IllegalStateException("WifiManager unavailable")
    val info: WifiInfo = wifi.connectionInfo
      ?: throw IllegalStateException("Wi-Fi connection info unavailable")

    val payload = Arguments.createMap()
    val ssid = sanitizeSsid(info.ssid)
    if (ssid != null) {
      payload.putString("ssid", ssid)
    }
    if (!info.bssid.isNullOrEmpty()) {
      payload.putString("bssid", info.bssid)
    }
    if (info.networkId >= 0) {
      payload.putString("interface", "wlan0")
    }
    payload.putDouble("timestamp", System.currentTimeMillis().toDouble())

    if (info.rssi != WifiInfo.INVALID_RSSI) {
      payload.putInt("rssi", info.rssi)
    }

    val linkSpeed = info.linkSpeed
    if (linkSpeed > 0) {
      payload.putInt("linkSpeedMbps", linkSpeed)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val txSpeed = info.txLinkSpeedMbps
      if (txSpeed > 0) {
        payload.putInt("transmitRateMbps", txSpeed)
      }
      val rxSpeed = info.rxLinkSpeedMbps
      if (rxSpeed > 0 && !payload.hasKey("linkSpeedMbps")) {
        payload.putInt("linkSpeedMbps", rxSpeed)
      }
    }

    return payload
  }

  private fun emitMetrics() {
    val payload = collectMetrics()
    sendEvent(payload)
  }

  private fun sendEvent(payload: WritableMap) {
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_NAME, payload)
  }

  private fun sendErrorEvent(message: String) {
    val map = Arguments.createMap()
    map.putString("error", message)
    map.putDouble("timestamp", System.currentTimeMillis().toDouble())
    sendEvent(map)
  }

  @Throws(SecurityException::class)
  private fun ensurePermissions() {
    val locationGranted =
      hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
        hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)

    val nearbyGranted =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        hasPermission(Manifest.permission.NEARBY_WIFI_DEVICES)

    if (!locationGranted || !nearbyGranted) {
      throw SecurityException("ACCESS_FINE_LOCATION and NEARBY_WIFI_DEVICES permissions are required")
    }
  }

  private fun hasPermission(permission: String): Boolean {
    return ContextCompat.checkSelfPermission(
      applicationContext,
      permission,
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun sanitizeSsid(rawSsid: String?): String? {
    if (rawSsid.isNullOrBlank()) {
      return null
    }
    val trimmed = rawSsid.replace("\"", "")
    return if (trimmed.equals(WifiManager.UNKNOWN_SSID, ignoreCase = true)) {
      null
    } else {
      trimmed
    }
  }
}
