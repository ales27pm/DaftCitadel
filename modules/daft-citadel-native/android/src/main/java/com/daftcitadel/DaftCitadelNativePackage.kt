package com.daftcitadel

import com.daftcitadel.audio.AudioEngineModule
import com.daftcitadel.collab.CollabNetworkDiagnosticsModule
import com.daftcitadel.plugins.VST3PluginHostModule
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class DaftCitadelNativePackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(
    AudioEngineModule(reactContext),
    AudioSampleLoaderModule(reactContext),
    CollabNetworkDiagnosticsModule(reactContext),
    VST3PluginHostModule(reactContext)
  )

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
